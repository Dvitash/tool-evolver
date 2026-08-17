import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "../db/client.js";
import type { CanaryMetricsWindow } from "../evolution/rollout/types.js";
import type { IMetricsRepository } from "./repositories/metrics-repository.js";
import type {
  MaterializeRolloutWindowParams,
  RolloutMetricWindowRecord,
  SecurityViolationDetail,
} from "./types.js";

/**
 * Calculates percentile from a sorted array of numbers.
 */
function calculatePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) return sorted[lower];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * RolloutWindowMaterializer: Computes deterministic, privacy-safe metric observation windows
 * for TE-037 Autonomous Canary & Rollout evaluations.
 */
export class RolloutWindowMaterializer {
  constructor(
    private pool: DatabasePool | Queryable,
    private metricsRepo: IMetricsRepository,
  ) {}

  /**
   * Materialize a rollout metric window for a specific tool and version.
   */
  async materializeWindow(
    params: MaterializeRolloutWindowParams,
  ): Promise<RolloutMetricWindowRecord> {
    const windowStart = params.windowStart;
    const windowEnd = params.windowEnd ?? new Date().toISOString();

    // 1. Query raw telemetry events in the target time window
    const eventsRes = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM rollout_telemetry_events
       WHERE workspace_id = $1 AND tool_id = $2 AND version = $3
         AND timestamp >= $4 AND timestamp <= $5
       ORDER BY timestamp ASC`,
      [params.workspaceId, params.toolId, params.version, windowStart, windowEnd],
    );

    const rows = eventsRes.rows;
    const totalInvocations = rows.length;

    let successCount = 0;
    let failureCount = 0;
    let policyViolations = 0;
    let securityViolations = 0;
    let quarantineSignals = 0;
    let capabilityBreaches = 0;
    let schemaMismatches = 0;
    let signatureValid = true;

    const latencies: number[] = [];
    const activeDeviceIds = new Set<string>();
    const quarantineReasonsSet = new Set<string>();
    const securityViolationDetails: SecurityViolationDetail[] = [];

    for (const row of rows) {
      const isSuccess = Boolean(row.success);
      if (isSuccess) {
        successCount++;
      } else {
        failureCount++;
      }

      if (row.duration_ms !== null && row.duration_ms !== undefined) {
        latencies.push(Number(row.duration_ms));
      }

      if (row.device_id) {
        activeDeviceIds.add(String(row.device_id));
      }

      if (Boolean(row.security_violation)) {
        securityViolations++;
        policyViolations++;
        securityViolationDetails.push({
          type: "security_violation",
          reason: row.security_violation_reason
            ? String(row.security_violation_reason)
            : "Security rule breach",
          timestamp: String(row.timestamp),
        });
      }

      if (Boolean(row.quarantine_signal)) {
        quarantineSignals++;
        if (row.quarantine_reason) {
          quarantineReasonsSet.add(String(row.quarantine_reason));
        }
      }

      if (Boolean(row.capability_breach)) {
        capabilityBreaches++;
        policyViolations++;
      }

      if (Boolean(row.schema_mismatch)) {
        schemaMismatches++;
      }

      if (row.signature_valid === false) {
        signatureValid = false;
      }
    }

    // 2. Compute rates and latency percentiles
    const successRate = totalInvocations > 0 ? successCount / totalInvocations : 0;
    const errorRate = totalInvocations > 0 ? failureCount / totalInvocations : 0;

    latencies.sort((a, b) => a - b);
    const p50LatencyMs = calculatePercentile(latencies, 50);
    const p95LatencyMs = calculatePercentile(latencies, 95);
    const p99LatencyMs = calculatePercentile(latencies, 99);

    // 3. Baseline comparison
    let baselineP95LatencyMs = params.baselineP95LatencyMs;
    if (baselineP95LatencyMs === undefined && params.baselineVersion) {
      const baselineWindow = await this.metricsRepo.getLatestRolloutMetricWindow(
        params.workspaceId,
        params.toolId,
        params.baselineVersion,
      );
      if (baselineWindow && baselineWindow.p95LatencyMs > 0) {
        baselineP95LatencyMs = baselineWindow.p95LatencyMs;
      }
    }

    let latencyRegressionPercent: number | undefined;
    if (baselineP95LatencyMs !== undefined && baselineP95LatencyMs > 0) {
      latencyRegressionPercent =
        ((p95LatencyMs - baselineP95LatencyMs) / baselineP95LatencyMs) * 100;
    }

    // 4. Device reporting calculations
    const activeDevicesCount = activeDeviceIds.size;
    const expectedActive =
      params.expectedActiveDevices ?? (activeDevicesCount > 0 ? activeDevicesCount : 1);
    const offlineDevicesCount = Math.max(0, expectedActive - activeDevicesCount);
    const deviceReportingRate =
      expectedActive > 0 ? Math.min(1.0, activeDevicesCount / expectedActive) : 1.0;

    // 5. Statistical Confidence Score: [0, 1] based on sample size and device coverage
    const sampleFactor = totalInvocations > 0 ? totalInvocations / (totalInvocations + 20) : 0;
    const confidence = Math.min(1.0, Math.max(0, sampleFactor * deviceReportingRate));

    const windowRecord: RolloutMetricWindowRecord = {
      windowId: `rmw_${randomUUID()}`,
      accountId: params.accountId,
      workspaceId: params.workspaceId,
      toolId: params.toolId,
      version: params.version,
      windowStart,
      windowEnd,
      totalInvocations,
      successCount,
      failureCount,
      successRate,
      errorRate,
      latenciesMs: latencies,
      p50LatencyMs,
      p95LatencyMs,
      p99LatencyMs,
      baselineP95LatencyMs,
      latencyRegressionPercent,
      policyViolations,
      securityViolations,
      quarantineSignals,
      capabilityBreaches,
      schemaMismatches,
      signatureValid,
      activeDevicesCount,
      offlineDevicesCount,
      deviceReportingRate,
      quarantineReasons: Array.from(quarantineReasonsSet),
      securityViolationDetails,
      confidence,
      materializedAt: new Date().toISOString(),
    };

    // 6. Save window to repository
    await this.metricsRepo.saveRolloutMetricWindow(windowRecord);

    return windowRecord;
  }

  /**
   * Convert a RolloutMetricWindowRecord to CanaryMetricsWindow for TE-037 Rollout Evaluator.
   */
  toCanaryMetricsWindow(record: RolloutMetricWindowRecord): CanaryMetricsWindow {
    return {
      windowStart: record.windowStart,
      windowEnd: record.windowEnd,
      totalInvocations: record.totalInvocations,
      successCount: record.successCount,
      failureCount: record.failureCount,
      successRate: record.successRate,
      errorRate: record.errorRate,
      latenciesMs: record.latenciesMs,
      p50LatencyMs: record.p50LatencyMs,
      p95LatencyMs: record.p95LatencyMs,
      p99LatencyMs: record.p99LatencyMs,
      baselineP95LatencyMs: record.baselineP95LatencyMs,
      latencyRegressionPercent: record.latencyRegressionPercent,
      policyViolations: record.policyViolations,
      securityViolations: record.securityViolations,
      quarantineSignals: record.quarantineSignals,
      capabilityBreaches: record.capabilityBreaches,
      schemaMismatches: record.schemaMismatches,
      signatureValid: record.signatureValid,
      activeDevicesCount: record.activeDevicesCount,
      offlineDevicesCount: record.offlineDevicesCount,
      deviceReportingRate: record.deviceReportingRate,
      quarantineReasons: record.quarantineReasons,
      securityViolationDetails: record.securityViolationDetails,
    };
  }
}
