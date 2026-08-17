import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "../db/client.js";
import type { IMetricsRepository } from "./repositories/metrics-repository.js";
import {
  type CalibrateEvaluationParams,
  type CalibrationRecord,
  type DecisionOutcome,
} from "./types.js";

/**
 * EvaluationCalibrator: Joins pre-deployment evaluation predictions with canary & production outcomes
 * to audit prediction accuracy, compute calibration deltas, and detect systematic evaluation biases.
 */
export class EvaluationCalibrator {
  constructor(
    private pool: DatabasePool | Queryable,
    private metricsRepo: IMetricsRepository,
  ) {}

  /**
   * Calibrate pre-deployment predictions against observed rollout telemetry.
   */
  async calibrateEvaluation(
    params: CalibrateEvaluationParams,
  ): Promise<CalibrationRecord> {
    const windowStart = params.windowStart ?? new Date(Date.now() - 86400000 * 7).toISOString();
    const windowEnd = params.windowEnd ?? new Date().toISOString();

    // 1. Retrieve actual outcomes from latest rollout metric window
    let actualSuccessRate = 0;
    let actualP95LatencyMs = 0;
    let actualTokenSavings = 0;
    let sampleSize = 0;

    const latestWindow = await this.metricsRepo.getLatestRolloutMetricWindow(
      params.workspaceId,
      params.toolId,
      params.version,
    );

    if (latestWindow && latestWindow.totalInvocations > 0) {
      actualSuccessRate = latestWindow.successRate;
      actualP95LatencyMs = latestWindow.p95LatencyMs;
      sampleSize = latestWindow.totalInvocations;
    } else {
      // Fallback: Query rollout_telemetry_events directly
      const eventsRes = await this.pool.query<Record<string, unknown>>(
        `SELECT duration_ms, success FROM rollout_telemetry_events
         WHERE workspace_id = $1 AND tool_id = $2 AND version = $3
           AND timestamp >= $4 AND timestamp <= $5`,
        [params.workspaceId, params.toolId, params.version, windowStart, windowEnd],
      );

      const rows = eventsRes.rows;
      sampleSize = rows.length;

      if (sampleSize > 0) {
        let succ = 0;
        const latencies: number[] = [];
        for (const row of rows) {
          if (Boolean(row.success)) succ++;
          if (row.duration_ms !== null && row.duration_ms !== undefined) {
            latencies.push(Number(row.duration_ms));
          }
        }
        actualSuccessRate = succ / sampleSize;
        latencies.sort((a, b) => a - b);
        const p95Idx = Math.floor(latencies.length * 0.95);
        actualP95LatencyMs = latencies[p95Idx] ?? latencies[latencies.length - 1] ?? 0;
      }
    }

    // Query efficiency metrics if available for token savings
    const effMetrics = await this.metricsRepo.queryEfficiencyMetrics({
      workspaceId: params.workspaceId,
      toolId: params.toolId,
      version: params.version,
      limit: 1,
    });
    if (effMetrics.length > 0 && sampleSize > 0) {
      actualTokenSavings = Math.round(effMetrics[0].measuredSavings.tokensSaved / Math.max(1, effMetrics[0].invocationCount));
    }

    // 2. Compute Prediction Errors
    const predictedSuccessRate = params.predictedSuccessRate;
    const predictedP95LatencyMs = params.predictedP95LatencyMs;
    const predictedTokenSavings = params.predictedTokenSavings ?? 0;

    const successRateDelta = Number((actualSuccessRate - predictedSuccessRate).toFixed(4));
    const latencyDeltaMs = Number((actualP95LatencyMs - predictedP95LatencyMs).toFixed(2));
    const tokenSavingsDelta = Number((actualTokenSavings - predictedTokenSavings).toFixed(2));
    const brierScore = Number(Math.pow(predictedSuccessRate - actualSuccessRate, 2).toFixed(4));

    // 3. Classify Decision Outcome
    let decisionOutcome: DecisionOutcome = "concordant";
    if (predictedSuccessRate >= 0.85 && actualSuccessRate < 0.70 && sampleSize >= 5) {
      decisionOutcome = "optimistic_false_positive";
    } else if (predictedSuccessRate < 0.75 && actualSuccessRate >= 0.90 && sampleSize >= 5) {
      decisionOutcome = "pessimistic_false_negative";
    } else if (Math.abs(successRateDelta) <= 0.15 && Math.abs(latencyDeltaMs) <= 300) {
      decisionOutcome = "concordant";
    } else {
      decisionOutcome = "divergent";
    }

    const calibrationRecord: CalibrationRecord = {
      id: `cal_${randomUUID()}`,
      accountId: params.accountId,
      workspaceId: params.workspaceId,
      toolId: params.toolId,
      version: params.version,
      candidateId: params.candidateId,
      evaluationId: params.evaluationId,
      predictedSuccessRate,
      actualSuccessRate,
      predictedP95LatencyMs,
      actualP95LatencyMs,
      predictedTokenSavings,
      actualTokenSavings,
      predictionError: {
        successRateDelta,
        latencyDeltaMs,
        tokenSavingsDelta,
        brierScore,
      },
      sampleSize,
      decisionOutcome,
      calibratedAt: new Date().toISOString(),
    };

    // 4. Save immutable calibration join record
    await this.metricsRepo.saveCalibration(calibrationRecord);

    return calibrationRecord;
  }
}
