import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "../db/client.js";
import type { TenantContext } from "../tenant.js";
import { AnomalyDetector } from "./anomaly.js";
import { EvaluationCalibrator } from "./calibration.js";
import { TelemetryDeduplicator } from "./deduplicator.js";
import { EfficiencyCalculator } from "./efficiency.js";
import { RolloutWindowMaterializer } from "./materializer.js";
import { MetricsRepository, type IMetricsRepository } from "./repositories/metrics-repository.js";
import { SchemaGuard } from "./schema-guard.js";
import {
  type AnomalyAlertRecord,
  type AnomalyQueryFilter,
  type BucketQueryFilter,
  type CalculateEfficiencyParams,
  type CalibrateEvaluationParams,
  type CalibrationQueryFilter,
  type CalibrationRecord,
  type EfficiencyMetricRecord,
  type EfficiencyQueryFilter,
  type MaterializeRolloutWindowParams,
  type RolloutMetricWindowRecord,
  type RolloutWindowQueryFilter,
  type TelemetryBatchRequest,
  type TelemetryBatchResponse,
  type TelemetryBucketRecord,
} from "./types.js";

export interface AnalyticsServiceOptions {
  pool?: DatabasePool | Queryable;
  repository?: IMetricsRepository;
  deduplicator?: TelemetryDeduplicator;
  materializer?: RolloutWindowMaterializer;
  efficiencyCalculator?: EfficiencyCalculator;
  calibrator?: EvaluationCalibrator;
  anomalyDetector?: AnomalyDetector;
}

/**
 * Custom error thrown when a request workspace does not match the active tenant context.
 */
export class AnalyticsTenantMismatchError extends Error {
  constructor(expectedWorkspace: string, actualWorkspace: string) {
    super(`Tenant mismatch: authenticated for workspace '${expectedWorkspace}' but received request for '${actualWorkspace}'`);
    this.name = "AnalyticsTenantMismatchError";
  }
}

/**
 * Floor a timestamp to a 5-minute bucket window boundary.
 */
function floorTo5Minutes(isoString: string): { windowStart: string; windowEnd: string } {
  const date = new Date(isoString);
  const ms = date.getTime();
  const fiveMinMs = 5 * 60 * 1000;
  const startMs = Math.floor(ms / fiveMinMs) * fiveMinMs;
  const endMs = startMs + fiveMinMs;

  return {
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
  };
}

/**
 * AnalyticsService: Orchestrates privacy-safe telemetry ingestion, idempotent deduplication,
 * rollout window materialization, efficiency calculation, evaluation calibration, and anomaly detection.
 */
export class AnalyticsService {
  readonly repository: IMetricsRepository;
  readonly deduplicator: TelemetryDeduplicator;
  readonly materializer: RolloutWindowMaterializer;
  readonly efficiencyCalculator: EfficiencyCalculator;
  readonly calibrator: EvaluationCalibrator;
  readonly anomalyDetector: AnomalyDetector;

  constructor(
    private pool: DatabasePool | Queryable,
    options: AnalyticsServiceOptions = {},
  ) {
    this.repository = options.repository ?? new MetricsRepository(this.pool);
    this.deduplicator = options.deduplicator ?? new TelemetryDeduplicator(this.pool);
    this.materializer = options.materializer ?? new RolloutWindowMaterializer(this.pool, this.repository);
    this.efficiencyCalculator = options.efficiencyCalculator ?? new EfficiencyCalculator(this.pool, this.repository);
    this.calibrator = options.calibrator ?? new EvaluationCalibrator(this.pool, this.repository);
    this.anomalyDetector = options.anomalyDetector ?? new AnomalyDetector(this.pool, this.repository);
  }

  // ---------------------------------------------------------------------------
  // 1. Ingestion Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Ingest a batch of telemetry metrics and invocation records.
   */
  async ingestBatch(
    tenant: TenantContext,
    request: TelemetryBatchRequest,
  ): Promise<TelemetryBatchResponse> {
    // 1. Tenant workspace isolation check
    if (request.workspaceId !== tenant.workspaceId) {
      throw new AnalyticsTenantMismatchError(tenant.workspaceId, request.workspaceId);
    }

    // 2. Strict Schema Guard Validation (Allowlist, dimensions, secrets, paths rejection)
    SchemaGuard.validateBatch(request);

    // 3. Deduplication Check
    const contentHash = this.deduplicator.computeBatchContentHash(request);
    const totalItems = (request.metrics?.length ?? 0) + (request.invocations?.length ?? 0);

    const dedupResult = await this.deduplicator.checkAndRecord(
      tenant.workspaceId,
      request.batchId,
      contentHash,
      totalItems,
      {
        accountId: tenant.accountId,
        deviceId: request.deviceId,
        installationId: request.installationId,
      },
    );

    if (dedupResult.duplicate) {
      return {
        batchId: request.batchId,
        status: "accepted",
        processedCount: dedupResult.acceptedCount,
      };
    }

    // 4. Anomaly Detection
    await this.anomalyDetector.checkBatch(tenant.workspaceId, request, {
      accountId: tenant.accountId,
    });

    // 5. Ingest Invocations into rollout_telemetry_events and metric buckets
    if (request.invocations && request.invocations.length > 0) {
      for (const inv of request.invocations) {
        const eventId = `rte_${randomUUID()}`;
        const isSuccess = inv.status === "success";
        const hasSecurityViolation = inv.status === "rejected_capability";

        await this.pool.query(
          `INSERT INTO rollout_telemetry_events (
            id, workspace_id, device_id, session_id, tool_id, version,
            artifact_digest, success, duration_ms, error_code, error_message,
            security_violation, security_violation_reason, quarantine_signal,
            quarantine_reason, capability_breach, schema_mismatch, signature_valid, timestamp
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            eventId,
            tenant.workspaceId,
            request.deviceId,
            inv.sessionId,
            inv.toolId,
            inv.toolVersion,
            inv.outputDigest ?? null,
            isSuccess,
            inv.durationMs,
            inv.errorDetails?.errorType ?? null,
            inv.errorDetails?.message ?? null,
            hasSecurityViolation,
            hasSecurityViolation ? "Capability boundary rejected" : null,
            false,
            null,
            hasSecurityViolation,
            false,
            true,
            inv.completedAt ?? request.timestamp,
          ],
        );

        // Aggregate into a 5-minute bucket
        const { windowStart, windowEnd } = floorTo5Minutes(inv.completedAt ?? request.timestamp);
        await this.repository.upsertBucket({
          bucketId: `bkt_${randomUUID()}`,
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          toolId: inv.toolId,
          version: inv.toolVersion,
          metricName: "tool.invocation",
          windowStart,
          windowEnd,
          count: 1,
          sum: inv.durationMs,
          min: inv.durationMs,
          max: inv.durationMs,
          p50: inv.durationMs,
          p95: inv.durationMs,
          p99: inv.durationMs,
          dimensions: {
            status: inv.status,
            shadowRun: inv.resourceUsage?.shadowRun ?? false,
          },
          errorCount: isSuccess ? 0 : 1,
          successCount: isSuccess ? 1 : 0,
          quarantineCount: 0,
          securityViolationCount: hasSecurityViolation ? 1 : 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    // 6. Ingest Metrics into metric buckets
    if (request.metrics && request.metrics.length > 0) {
      for (const metric of request.metrics) {
        const { windowStart, windowEnd } = floorTo5Minutes(metric.timestamp);
        const toolId = String(metric.tags?.toolId ?? metric.tags?.tool_id ?? "system");
        const version = String(metric.tags?.version ?? metric.tags?.toolVersion ?? "0.0.0");

        await this.repository.upsertBucket({
          bucketId: `bkt_${randomUUID()}`,
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          toolId,
          version,
          metricName: metric.metricName,
          windowStart,
          windowEnd,
          count: 1,
          sum: metric.value,
          min: metric.value,
          max: metric.value,
          p50: metric.value,
          p95: metric.value,
          p99: metric.value,
          dimensions: (metric.tags as Record<string, string | number | boolean>) ?? {},
          errorCount: 0,
          successCount: 1,
          quarantineCount: 0,
          securityViolationCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return {
      batchId: request.batchId,
      status: "accepted",
      processedCount: totalItems,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Rollout Metric Window Materialization
  // ---------------------------------------------------------------------------

  async materializeRolloutWindow(
    tenant: TenantContext,
    params: Omit<MaterializeRolloutWindowParams, "workspaceId" | "accountId">,
  ): Promise<RolloutMetricWindowRecord> {
    return this.materializer.materializeWindow({
      ...params,
      workspaceId: tenant.workspaceId,
      accountId: tenant.accountId,
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Efficiency Calculation
  // ---------------------------------------------------------------------------

  async calculateEfficiency(
    tenant: TenantContext,
    params: Omit<CalculateEfficiencyParams, "workspaceId" | "accountId">,
  ): Promise<EfficiencyMetricRecord> {
    return this.efficiencyCalculator.calculateEfficiency({
      ...params,
      workspaceId: tenant.workspaceId,
      accountId: tenant.accountId,
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Evaluation Calibration
  // ---------------------------------------------------------------------------

  async calibrateEvaluation(
    tenant: TenantContext,
    params: Omit<CalibrateEvaluationParams, "workspaceId" | "accountId">,
  ): Promise<CalibrationRecord> {
    return this.calibrator.calibrateEvaluation({
      ...params,
      workspaceId: tenant.workspaceId,
      accountId: tenant.accountId,
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Query Operations
  // ---------------------------------------------------------------------------

  async queryBuckets(
    tenant: TenantContext,
    filter: Omit<BucketQueryFilter, "workspaceId" | "accountId">,
  ): Promise<TelemetryBucketRecord[]> {
    return this.repository.queryBuckets({
      ...filter,
      workspaceId: tenant.workspaceId,
      accountId: tenant.accountId,
    });
  }

  async queryRolloutWindows(
    tenant: TenantContext,
    filter: Omit<RolloutWindowQueryFilter, "workspaceId" | "accountId">,
  ): Promise<RolloutMetricWindowRecord[]> {
    return this.repository.queryRolloutMetricWindows({
      ...filter,
      workspaceId: tenant.workspaceId,
      accountId: tenant.accountId,
    });
  }

  async queryEfficiencyMetrics(
    tenant: TenantContext,
    filter: Omit<EfficiencyQueryFilter, "workspaceId" | "accountId">,
  ): Promise<EfficiencyMetricRecord[]> {
    return this.repository.queryEfficiencyMetrics({
      ...filter,
      workspaceId: tenant.workspaceId,
      accountId: tenant.accountId,
    });
  }

  async queryCalibrations(
    tenant: TenantContext,
    filter: Omit<CalibrationQueryFilter, "workspaceId" | "accountId">,
  ): Promise<CalibrationRecord[]> {
    return this.repository.queryCalibrations({
      ...filter,
      workspaceId: tenant.workspaceId,
      accountId: tenant.accountId,
    });
  }

  async queryAnomalies(
    tenant: TenantContext,
    filter: Omit<AnomalyQueryFilter, "workspaceId" | "accountId">,
  ): Promise<AnomalyAlertRecord[]> {
    return this.repository.queryAnomalyAlerts({
      ...filter,
      workspaceId: tenant.workspaceId,
      accountId: tenant.accountId,
    });
  }

  async resolveAnomaly(tenant: TenantContext, alertId: string): Promise<boolean> {
    return this.repository.resolveAnomalyAlert(tenant.workspaceId, alertId);
  }

  // ---------------------------------------------------------------------------
  // 6. Tenant Data Isolation, Export & Cascade Deletion
  // ---------------------------------------------------------------------------

  async deleteTenantData(tenant: TenantContext) {
    if (!tenant.accountId) {
      throw new Error("Tenant account ID is required for data deletion");
    }
    return this.repository.deleteTenantAnalytics(tenant.accountId, tenant.workspaceId);
  }

  async exportTenantData(tenant: TenantContext) {
    if (!tenant.accountId) {
      throw new Error("Tenant account ID is required for data export");
    }
    return this.repository.exportTenantAnalytics(tenant.accountId, tenant.workspaceId);
  }
}

export function createAnalyticsService(
  pool: DatabasePool | Queryable,
  options: AnalyticsServiceOptions = {},
): AnalyticsService {
  return new AnalyticsService(pool, options);
}
