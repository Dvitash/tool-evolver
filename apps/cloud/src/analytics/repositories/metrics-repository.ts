import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "../../db/client.js";
import type {
  AnomalyAlertRecord,
  AnomalyQueryFilter,
  AnomalySeverity,
  AnomalyType,
  BucketQueryFilter,
  CalibrationQueryFilter,
  CalibrationRecord,
  DecisionOutcome,
  EfficiencyMetricRecord,
  EfficiencyQueryFilter,
  RolloutMetricWindowRecord,
  RolloutWindowQueryFilter,
  TelemetryBucketRecord,
  TelemetryReceiptEntity,
} from "../types.js";

/**
 * Interface for Metrics Repository.
 */
export interface IMetricsRepository {
  upsertBucket(bucket: TelemetryBucketRecord): Promise<void>;
  getBucket(workspaceId: string, bucketId: string): Promise<TelemetryBucketRecord | null>;
  queryBuckets(filter: BucketQueryFilter): Promise<TelemetryBucketRecord[]>;
  saveRolloutMetricWindow(window: RolloutMetricWindowRecord): Promise<void>;
  getLatestRolloutMetricWindow(
    workspaceId: string,
    toolId: string,
    version: string,
  ): Promise<RolloutMetricWindowRecord | null>;
  queryRolloutMetricWindows(filter: RolloutWindowQueryFilter): Promise<RolloutMetricWindowRecord[]>;
  saveEfficiencyMetric(metric: EfficiencyMetricRecord): Promise<void>;
  queryEfficiencyMetrics(filter: EfficiencyQueryFilter): Promise<EfficiencyMetricRecord[]>;
  saveCalibration(record: CalibrationRecord): Promise<void>;
  queryCalibrations(filter: CalibrationQueryFilter): Promise<CalibrationRecord[]>;
  saveAnomalyAlert(alert: AnomalyAlertRecord): Promise<void>;
  queryAnomalyAlerts(filter: AnomalyQueryFilter): Promise<AnomalyAlertRecord[]>;
  resolveAnomalyAlert(workspaceId: string, alertId: string, resolvedAt?: string): Promise<boolean>;
  deleteTenantAnalytics(
    accountId: string,
    workspaceId: string,
  ): Promise<{
    deletedBuckets: number;
    deletedWindows: number;
    deletedEfficiency: number;
    deletedCalibrations: number;
    deletedAnomalies: number;
    deletedReceipts: number;
  }>;
  exportTenantAnalytics(
    accountId: string,
    workspaceId: string,
  ): Promise<{
    buckets: TelemetryBucketRecord[];
    windows: RolloutMetricWindowRecord[];
    efficiency: EfficiencyMetricRecord[];
    calibrations: CalibrationRecord[];
    anomalies: AnomalyAlertRecord[];
  }>;
}

/**
 * Postgres / Memory MetricsRepository implementation.
 */
export class MetricsRepository implements IMetricsRepository {
  constructor(private pool: DatabasePool | Queryable) {}

  // ---------------------------------------------------------------------------
  // 1. Telemetry Buckets
  // ---------------------------------------------------------------------------

  async upsertBucket(bucket: TelemetryBucketRecord): Promise<void> {
    const bucketId = bucket.bucketId || `bkt_${randomUUID()}`;
    const now = new Date().toISOString();

    await this.pool.query(
      `INSERT INTO telemetry_buckets (
        id, account_id, workspace_id, tool_id, version, metric_name,
        window_start, window_end, count, sum, min, max, p50, p95, p99,
        dimensions, error_count, success_count, quarantine_count, security_violation_count,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        bucketId,
        bucket.accountId ?? null,
        bucket.workspaceId,
        bucket.toolId,
        bucket.version,
        bucket.metricName,
        bucket.windowStart,
        bucket.windowEnd,
        bucket.count,
        bucket.sum,
        bucket.min,
        bucket.max,
        bucket.p50,
        bucket.p95,
        bucket.p99,
        JSON.stringify(bucket.dimensions ?? {}),
        bucket.errorCount ?? 0,
        bucket.successCount ?? 0,
        bucket.quarantineCount ?? 0,
        bucket.securityViolationCount ?? 0,
        bucket.createdAt ?? now,
        bucket.updatedAt ?? now,
      ],
    );
  }

  async getBucket(workspaceId: string, bucketId: string): Promise<TelemetryBucketRecord | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM telemetry_buckets WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
      [workspaceId, bucketId],
    );

    if (res.rows.length === 0) {
      return null;
    }

    return this.mapRowToBucket(res.rows[0]);
  }

  async queryBuckets(filter: BucketQueryFilter): Promise<TelemetryBucketRecord[]> {
    let sql = `SELECT * FROM telemetry_buckets WHERE workspace_id = $1`;
    const params: unknown[] = [filter.workspaceId];
    let paramIndex = 2;

    if (filter.accountId) {
      sql += ` AND account_id = $${paramIndex++}`;
      params.push(filter.accountId);
    }
    if (filter.toolId) {
      sql += ` AND tool_id = $${paramIndex++}`;
      params.push(filter.toolId);
    }
    if (filter.version) {
      sql += ` AND version = $${paramIndex++}`;
      params.push(filter.version);
    }
    if (filter.metricName) {
      sql += ` AND metric_name = $${paramIndex++}`;
      params.push(filter.metricName);
    }
    if (filter.startTime) {
      sql += ` AND window_start >= $${paramIndex++}`;
      params.push(filter.startTime);
    }
    if (filter.endTime) {
      sql += ` AND window_end <= $${paramIndex++}`;
      params.push(filter.endTime);
    }

    sql += ` ORDER BY window_start DESC`;

    if (filter.limit) {
      sql += ` LIMIT ${Number(filter.limit)}`;
    }

    const res = await this.pool.query<Record<string, unknown>>(sql, params);
    return res.rows.map((row) => this.mapRowToBucket(row));
  }

  // ---------------------------------------------------------------------------
  // 2. Rollout Metric Windows
  // ---------------------------------------------------------------------------

  async saveRolloutMetricWindow(window: RolloutMetricWindowRecord): Promise<void> {
    const windowId = window.windowId || `rmw_${randomUUID()}`;
    const now = new Date().toISOString();

    await this.pool.query(
      `INSERT INTO rollout_metric_windows (
        id, account_id, workspace_id, tool_id, version,
        window_start, window_end, total_invocations, success_count, failure_count,
        success_rate, error_rate, latencies_ms, p50_latency_ms, p95_latency_ms, p99_latency_ms,
        baseline_p95_latency_ms, latency_regression_percent, policy_violations,
        security_violations, quarantine_signals, capability_breaches, schema_mismatches,
        signature_valid, active_devices_count, offline_devices_count, device_reporting_rate,
        quarantine_reasons, security_violation_details, confidence, materialized_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31
      )`,
      [
        windowId,
        window.accountId ?? null,
        window.workspaceId,
        window.toolId,
        window.version,
        window.windowStart,
        window.windowEnd,
        window.totalInvocations,
        window.successCount,
        window.failureCount,
        window.successRate,
        window.errorRate,
        JSON.stringify(window.latenciesMs ?? []),
        window.p50LatencyMs,
        window.p95LatencyMs,
        window.p99LatencyMs,
        window.baselineP95LatencyMs ?? null,
        window.latencyRegressionPercent ?? null,
        window.policyViolations ?? 0,
        window.securityViolations ?? 0,
        window.quarantineSignals ?? 0,
        window.capabilityBreaches ?? 0,
        window.schemaMismatches ?? 0,
        window.signatureValid ?? true,
        window.activeDevicesCount ?? 0,
        window.offlineDevicesCount ?? 0,
        window.deviceReportingRate ?? 1.0,
        JSON.stringify(window.quarantineReasons ?? []),
        JSON.stringify(window.securityViolationDetails ?? []),
        window.confidence ?? 0,
        window.materializedAt ?? now,
      ],
    );
  }

  async getLatestRolloutMetricWindow(
    workspaceId: string,
    toolId: string,
    version: string,
  ): Promise<RolloutMetricWindowRecord | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM rollout_metric_windows
       WHERE workspace_id = $1 AND tool_id = $2 AND version = $3
       ORDER BY window_start DESC
       LIMIT 1`,
      [workspaceId, toolId, version],
    );

    if (res.rows.length === 0) {
      return null;
    }

    return this.mapRowToRolloutWindow(res.rows[0]);
  }

  async queryRolloutMetricWindows(
    filter: RolloutWindowQueryFilter,
  ): Promise<RolloutMetricWindowRecord[]> {
    let sql = `SELECT * FROM rollout_metric_windows WHERE workspace_id = $1`;
    const params: unknown[] = [filter.workspaceId];
    let paramIndex = 2;

    if (filter.accountId) {
      sql += ` AND account_id = $${paramIndex++}`;
      params.push(filter.accountId);
    }
    if (filter.toolId) {
      sql += ` AND tool_id = $${paramIndex++}`;
      params.push(filter.toolId);
    }
    if (filter.version) {
      sql += ` AND version = $${paramIndex++}`;
      params.push(filter.version);
    }
    if (filter.startTime) {
      sql += ` AND window_start >= $${paramIndex++}`;
      params.push(filter.startTime);
    }
    if (filter.endTime) {
      sql += ` AND window_end <= $${paramIndex++}`;
      params.push(filter.endTime);
    }

    sql += ` ORDER BY window_start DESC`;

    if (filter.limit) {
      sql += ` LIMIT ${Number(filter.limit)}`;
    }

    const res = await this.pool.query<Record<string, unknown>>(sql, params);
    return res.rows.map((row) => this.mapRowToRolloutWindow(row));
  }

  // ---------------------------------------------------------------------------
  // 3. Efficiency Metrics
  // ---------------------------------------------------------------------------

  async saveEfficiencyMetric(metric: EfficiencyMetricRecord): Promise<void> {
    const id = metric.id || `eff_${randomUUID()}`;
    const now = new Date().toISOString();

    await this.pool.query(
      `INSERT INTO efficiency_metrics (
        id, account_id, workspace_id, tool_id, version, baseline_version,
        window_start, window_end, invocation_count,
        measured_savings, counterfactual_savings, net_savings_score, calculated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        metric.accountId ?? null,
        metric.workspaceId,
        metric.toolId,
        metric.version,
        metric.baselineVersion ?? null,
        metric.windowStart,
        metric.windowEnd,
        metric.invocationCount,
        JSON.stringify(metric.measuredSavings ?? {}),
        JSON.stringify(metric.counterfactualSavings ?? {}),
        metric.netSavingsScore,
        metric.calculatedAt ?? now,
      ],
    );
  }

  async queryEfficiencyMetrics(filter: EfficiencyQueryFilter): Promise<EfficiencyMetricRecord[]> {
    let sql = `SELECT * FROM efficiency_metrics WHERE workspace_id = $1`;
    const params: unknown[] = [filter.workspaceId];
    let paramIndex = 2;

    if (filter.accountId) {
      sql += ` AND account_id = $${paramIndex++}`;
      params.push(filter.accountId);
    }
    if (filter.toolId) {
      sql += ` AND tool_id = $${paramIndex++}`;
      params.push(filter.toolId);
    }
    if (filter.version) {
      sql += ` AND version = $${paramIndex++}`;
      params.push(filter.version);
    }
    if (filter.startTime) {
      sql += ` AND window_start >= $${paramIndex++}`;
      params.push(filter.startTime);
    }
    if (filter.endTime) {
      sql += ` AND window_end <= $${paramIndex++}`;
      params.push(filter.endTime);
    }

    sql += ` ORDER BY calculated_at DESC`;

    if (filter.limit) {
      sql += ` LIMIT ${Number(filter.limit)}`;
    }

    const res = await this.pool.query<Record<string, unknown>>(sql, params);
    return res.rows.map((row) => this.mapRowToEfficiencyMetric(row));
  }

  // ---------------------------------------------------------------------------
  // 4. Evaluation Calibrations
  // ---------------------------------------------------------------------------

  async saveCalibration(record: CalibrationRecord): Promise<void> {
    const id = record.id || `cal_${randomUUID()}`;
    const now = new Date().toISOString();

    await this.pool.query(
      `INSERT INTO evaluation_calibrations (
        id, account_id, workspace_id, tool_id, version,
        candidate_id, evaluation_id, predicted_success_rate, actual_success_rate,
        predicted_p95_latency_ms, actual_p95_latency_ms, predicted_token_savings,
        actual_token_savings, prediction_error, sample_size, decision_outcome, calibrated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        record.accountId ?? null,
        record.workspaceId,
        record.toolId,
        record.version,
        record.candidateId,
        record.evaluationId,
        record.predictedSuccessRate,
        record.actualSuccessRate,
        record.predictedP95LatencyMs,
        record.actualP95LatencyMs,
        record.predictedTokenSavings ?? 0,
        record.actualTokenSavings ?? 0,
        JSON.stringify(record.predictionError ?? {}),
        record.sampleSize,
        record.decisionOutcome,
        record.calibratedAt ?? now,
      ],
    );
  }

  async queryCalibrations(filter: CalibrationQueryFilter): Promise<CalibrationRecord[]> {
    let sql = `SELECT * FROM evaluation_calibrations WHERE workspace_id = $1`;
    const params: unknown[] = [filter.workspaceId];
    let paramIndex = 2;

    if (filter.accountId) {
      sql += ` AND account_id = $${paramIndex++}`;
      params.push(filter.accountId);
    }
    if (filter.toolId) {
      sql += ` AND tool_id = $${paramIndex++}`;
      params.push(filter.toolId);
    }
    if (filter.version) {
      sql += ` AND version = $${paramIndex++}`;
      params.push(filter.version);
    }
    if (filter.candidateId) {
      sql += ` AND candidate_id = $${paramIndex++}`;
      params.push(filter.candidateId);
    }
    if (filter.evaluationId) {
      sql += ` AND evaluation_id = $${paramIndex++}`;
      params.push(filter.evaluationId);
    }
    if (filter.decisionOutcome) {
      sql += ` AND decision_outcome = $${paramIndex++}`;
      params.push(filter.decisionOutcome);
    }

    sql += ` ORDER BY calibrated_at DESC`;

    if (filter.limit) {
      sql += ` LIMIT ${Number(filter.limit)}`;
    }

    const res = await this.pool.query<Record<string, unknown>>(sql, params);
    return res.rows.map((row) => this.mapRowToCalibration(row));
  }

  // ---------------------------------------------------------------------------
  // 5. Anomaly Alerts
  // ---------------------------------------------------------------------------

  async saveAnomalyAlert(alert: AnomalyAlertRecord): Promise<void> {
    const id = alert.id || `anom_${randomUUID()}`;
    const now = new Date().toISOString();

    await this.pool.query(
      `INSERT INTO anomaly_alerts (
        id, account_id, workspace_id, tool_id, version,
        anomaly_type, severity, description, evidence, resolved, detected_at, resolved_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        alert.accountId ?? null,
        alert.workspaceId,
        alert.toolId,
        alert.version,
        alert.anomalyType,
        alert.severity ?? "warning",
        alert.description,
        JSON.stringify(alert.evidence ?? {}),
        alert.resolved ?? false,
        alert.detectedAt ?? now,
        alert.resolvedAt ?? null,
      ],
    );
  }

  async queryAnomalyAlerts(filter: AnomalyQueryFilter): Promise<AnomalyAlertRecord[]> {
    let sql = `SELECT * FROM anomaly_alerts WHERE workspace_id = $1`;
    const params: unknown[] = [filter.workspaceId];
    let paramIndex = 2;

    if (filter.accountId) {
      sql += ` AND account_id = $${paramIndex++}`;
      params.push(filter.accountId);
    }
    if (filter.toolId) {
      sql += ` AND tool_id = $${paramIndex++}`;
      params.push(filter.toolId);
    }
    if (filter.version) {
      sql += ` AND version = $${paramIndex++}`;
      params.push(filter.version);
    }
    if (filter.anomalyType) {
      sql += ` AND anomaly_type = $${paramIndex++}`;
      params.push(filter.anomalyType);
    }
    if (filter.severity) {
      sql += ` AND severity = $${paramIndex++}`;
      params.push(filter.severity);
    }
    if (filter.resolved !== undefined) {
      sql += ` AND resolved = $${paramIndex++}`;
      params.push(filter.resolved);
    }

    sql += ` ORDER BY detected_at DESC`;

    if (filter.limit) {
      sql += ` LIMIT ${Number(filter.limit)}`;
    }

    const res = await this.pool.query<Record<string, unknown>>(sql, params);
    return res.rows.map((row) => this.mapRowToAnomalyAlert(row));
  }

  async resolveAnomalyAlert(
    workspaceId: string,
    alertId: string,
    resolvedAt?: string,
  ): Promise<boolean> {
    const now = resolvedAt ?? new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE anomaly_alerts
       SET resolved = TRUE, resolved_at = $1
       WHERE workspace_id = $2 AND id = $3`,
      [now, workspaceId, alertId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // 6. Tenant Data Isolation, Export & Cascade Deletion
  // ---------------------------------------------------------------------------

  async deleteTenantAnalytics(
    accountId: string,
    workspaceId: string,
  ): Promise<{
    deletedBuckets: number;
    deletedWindows: number;
    deletedEfficiency: number;
    deletedCalibrations: number;
    deletedAnomalies: number;
    deletedReceipts: number;
  }> {
    const bRes = await this.pool.query(
      `DELETE FROM telemetry_buckets WHERE account_id = $1 AND workspace_id = $2`,
      [accountId, workspaceId],
    );
    const wRes = await this.pool.query(
      `DELETE FROM rollout_metric_windows WHERE account_id = $1 AND workspace_id = $2`,
      [accountId, workspaceId],
    );
    const eRes = await this.pool.query(
      `DELETE FROM efficiency_metrics WHERE account_id = $1 AND workspace_id = $2`,
      [accountId, workspaceId],
    );
    const cRes = await this.pool.query(
      `DELETE FROM evaluation_calibrations WHERE account_id = $1 AND workspace_id = $2`,
      [accountId, workspaceId],
    );
    const aRes = await this.pool.query(
      `DELETE FROM anomaly_alerts WHERE account_id = $1 AND workspace_id = $2`,
      [accountId, workspaceId],
    );
    const rRes = await this.pool.query(
      `DELETE FROM telemetry_receipts WHERE account_id = $1 AND workspace_id = $2`,
      [accountId, workspaceId],
    );

    return {
      deletedBuckets: bRes.rowCount ?? 0,
      deletedWindows: wRes.rowCount ?? 0,
      deletedEfficiency: eRes.rowCount ?? 0,
      deletedCalibrations: cRes.rowCount ?? 0,
      deletedAnomalies: aRes.rowCount ?? 0,
      deletedReceipts: rRes.rowCount ?? 0,
    };
  }

  async exportTenantAnalytics(
    accountId: string,
    workspaceId: string,
  ): Promise<{
    buckets: TelemetryBucketRecord[];
    windows: RolloutMetricWindowRecord[];
    efficiency: EfficiencyMetricRecord[];
    calibrations: CalibrationRecord[];
    anomalies: AnomalyAlertRecord[];
  }> {
    const buckets = await this.queryBuckets({ accountId, workspaceId, limit: 10000 });
    const windows = await this.queryRolloutMetricWindows({ accountId, workspaceId, limit: 10000 });
    const efficiency = await this.queryEfficiencyMetrics({ accountId, workspaceId, limit: 10000 });
    const calibrations = await this.queryCalibrations({ accountId, workspaceId, limit: 10000 });
    const anomalies = await this.queryAnomalyAlerts({ accountId, workspaceId, limit: 10000 });

    return {
      buckets,
      windows,
      efficiency,
      calibrations,
      anomalies,
    };
  }

  // ---------------------------------------------------------------------------
  // Helper Mappers
  // ---------------------------------------------------------------------------

  private parseJson<T>(val: unknown, fallback: T): T {
    if (!val) return fallback;
    if (typeof val === "object") return val as T;
    if (typeof val === "string") {
      try {
        return JSON.parse(val) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  private mapRowToBucket(row: Record<string, unknown>): TelemetryBucketRecord {
    return {
      bucketId: String(row.id),
      accountId: row.account_id ? String(row.account_id) : undefined,
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      version: String(row.version),
      metricName: String(row.metric_name),
      windowStart: String(row.window_start),
      windowEnd: String(row.window_end),
      count: Number(row.count ?? 0),
      sum: Number(row.sum ?? 0),
      min: Number(row.min ?? 0),
      max: Number(row.max ?? 0),
      p50: Number(row.p50 ?? 0),
      p95: Number(row.p95 ?? 0),
      p99: Number(row.p99 ?? 0),
      dimensions: this.parseJson<Record<string, string | number | boolean>>(row.dimensions, {}),
      errorCount: Number(row.error_count ?? 0),
      successCount: Number(row.success_count ?? 0),
      quarantineCount: Number(row.quarantine_count ?? 0),
      securityViolationCount: Number(row.security_violation_count ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapRowToRolloutWindow(row: Record<string, unknown>): RolloutMetricWindowRecord {
    return {
      windowId: String(row.id),
      accountId: row.account_id ? String(row.account_id) : undefined,
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      version: String(row.version),
      windowStart: String(row.window_start),
      windowEnd: String(row.window_end),
      totalInvocations: Number(row.total_invocations ?? 0),
      successCount: Number(row.success_count ?? 0),
      failureCount: Number(row.failure_count ?? 0),
      successRate: Number(row.success_rate ?? 0),
      errorRate: Number(row.error_rate ?? 0),
      latenciesMs: this.parseJson<number[]>(row.latencies_ms, []),
      p50LatencyMs: Number(row.p50_latency_ms ?? 0),
      p95LatencyMs: Number(row.p95_latency_ms ?? 0),
      p99LatencyMs: Number(row.p99_latency_ms ?? 0),
      baselineP95LatencyMs:
        row.baseline_p95_latency_ms !== null && row.baseline_p95_latency_ms !== undefined
          ? Number(row.baseline_p95_latency_ms)
          : undefined,
      latencyRegressionPercent:
        row.latency_regression_percent !== null && row.latency_regression_percent !== undefined
          ? Number(row.latency_regression_percent)
          : undefined,
      policyViolations: Number(row.policy_violations ?? 0),
      securityViolations: Number(row.security_violations ?? 0),
      quarantineSignals: Number(row.quarantine_signals ?? 0),
      capabilityBreaches: Number(row.capability_breaches ?? 0),
      schemaMismatches: Number(row.schema_mismatches ?? 0),
      signatureValid:
        row.signature_valid === undefined || row.signature_valid === null
          ? true
          : Boolean(row.signature_valid),
      activeDevicesCount: Number(row.active_devices_count ?? 0),
      offlineDevicesCount: Number(row.offline_devices_count ?? 0),
      deviceReportingRate: Number(row.device_reporting_rate ?? 1.0),
      quarantineReasons: this.parseJson<string[]>(row.quarantine_reasons, []),
      securityViolationDetails: this.parseJson<
        Array<{ type: string; reason: string; timestamp: string }>
      >(row.security_violation_details, []),
      confidence: Number(row.confidence ?? 0),
      materializedAt: String(row.materialized_at),
    };
  }

  private mapRowToEfficiencyMetric(row: Record<string, unknown>): EfficiencyMetricRecord {
    return {
      id: String(row.id),
      accountId: row.account_id ? String(row.account_id) : undefined,
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      version: String(row.version),
      baselineVersion: row.baseline_version ? String(row.baseline_version) : undefined,
      windowStart: String(row.window_start),
      windowEnd: String(row.window_end),
      invocationCount: Number(row.invocation_count ?? 0),
      measuredSavings: this.parseJson(row.measured_savings, {
        durationMsSaved: 0,
        tokensSaved: 0,
        stepsAvoided: 0,
        estimatedCostSavedUsd: 0,
      }),
      counterfactualSavings: this.parseJson(row.counterfactual_savings, {
        durationMsSavedEstimate: 0,
        tokensSavedEstimate: 0,
        stepsAvoidedEstimate: 0,
        lowerBoundUsd: 0,
        upperBoundUsd: 0,
        confidenceLevel: 0.95,
        standardErrorUsd: 0,
      }),
      netSavingsScore: Number(row.net_savings_score ?? 0),
      calculatedAt: String(row.calculated_at),
    };
  }

  private mapRowToCalibration(row: Record<string, unknown>): CalibrationRecord {
    return {
      id: String(row.id),
      accountId: row.account_id ? String(row.account_id) : undefined,
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      version: String(row.version),
      candidateId: String(row.candidate_id),
      evaluationId: String(row.evaluation_id),
      predictedSuccessRate: Number(row.predicted_success_rate ?? 0),
      actualSuccessRate: Number(row.actual_success_rate ?? 0),
      predictedP95LatencyMs: Number(row.predicted_p95_latency_ms ?? 0),
      actualP95LatencyMs: Number(row.actual_p95_latency_ms ?? 0),
      predictedTokenSavings: Number(row.predicted_token_savings ?? 0),
      actualTokenSavings: Number(row.actual_token_savings ?? 0),
      predictionError: this.parseJson(row.prediction_error, {
        successRateDelta: 0,
        latencyDeltaMs: 0,
        tokenSavingsDelta: 0,
      }),
      sampleSize: Number(row.sample_size ?? 0),
      decisionOutcome: (row.decision_outcome as DecisionOutcome) ?? "concordant",
      calibratedAt: String(row.calibrated_at),
    };
  }

  private mapRowToAnomalyAlert(row: Record<string, unknown>): AnomalyAlertRecord {
    return {
      id: String(row.id),
      accountId: row.account_id ? String(row.account_id) : undefined,
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      version: String(row.version),
      anomalyType: row.anomaly_type as AnomalyType,
      severity: (row.severity as AnomalySeverity) ?? "warning",
      description: String(row.description),
      evidence: this.parseJson(row.evidence, {}),
      resolved: Boolean(row.resolved),
      detectedAt: String(row.detected_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    };
  }
}

export function createMetricsRepository(pool: DatabasePool | Queryable): MetricsRepository {
  return new MetricsRepository(pool);
}
