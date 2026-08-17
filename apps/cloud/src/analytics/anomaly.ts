import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "../db/client.js";
import type { IMetricsRepository } from "./repositories/metrics-repository.js";
import {
  type AnomalyAlertRecord,
  type AnomalySeverity,
  type AnomalyType,
  type TelemetryBatchRequest,
} from "./types.js";

/**
 * AnomalyDetector: Inspects incoming telemetry streams and lifecycle state transitions
 * for impossible sequences, clock manipulation, counter resets, and cardinality attacks.
 */
export class AnomalyDetector {
  // In-memory sequence counter tracker: `${workspaceId}:${sessionId}:${toolId}` -> last sequence
  private sequenceCounters = new Map<string, number>();

  constructor(
    private pool?: DatabasePool | Queryable,
    private metricsRepo?: IMetricsRepository,
  ) {}

  /**
   * Check a telemetry batch request for anomalies.
   */
  async checkBatch(
    workspaceId: string,
    request: TelemetryBatchRequest,
    context: {
      accountId?: string;
      serverTime?: number;
      activeRolloutTimestamps?: Record<string, string>; // `${toolId}:${version}` -> activatedAt ISO
      revokedVersions?: Record<string, true>; // `${toolId}:${version}` -> true
    } = {},
  ): Promise<AnomalyAlertRecord[]> {
    const alerts: AnomalyAlertRecord[] = [];
    const now = context.serverTime ?? Date.now();
    const batchTime = new Date(request.timestamp).getTime();

    // 1. Check Impossible Timestamps on Batch Header
    const futureClockSkewThresholdMs = 5 * 60 * 1000; // 5 minutes
    const pastRetentionHorizonMs = 30 * 24 * 60 * 60 * 1000; // 30 days

    if (batchTime > now + futureClockSkewThresholdMs) {
      alerts.push(
        this.createAlert({
          workspaceId,
          accountId: context.accountId,
          toolId: "system",
          version: "0.0.0",
          anomalyType: "impossible_timestamp",
          severity: "critical",
          description: `Batch timestamp (${request.timestamp}) is ${Math.round((batchTime - now) / 1000)}s in the future`,
          evidence: {
            batchId: request.batchId,
            batchTimestamp: request.timestamp,
            serverTimestamp: new Date(now).toISOString(),
            skewMs: batchTime - now,
          },
        }),
      );
    } else if (now - batchTime > pastRetentionHorizonMs) {
      alerts.push(
        this.createAlert({
          workspaceId,
          accountId: context.accountId,
          toolId: "system",
          version: "0.0.0",
          anomalyType: "impossible_timestamp",
          severity: "warning",
          description: `Batch timestamp (${request.timestamp}) exceeds 30-day retention horizon`,
          evidence: {
            batchId: request.batchId,
            batchTimestamp: request.timestamp,
            serverTimestamp: new Date(now).toISOString(),
            ageMs: now - batchTime,
          },
        }),
      );
    }

    // 2. Check Cardinality Explosion in Batch
    const distinctTools = new Set<string>();
    const distinctVersions = new Set<string>();

    if (request.invocations) {
      for (const inv of request.invocations) {
        distinctTools.add(inv.toolId);
        distinctVersions.add(`${inv.toolId}:${inv.toolVersion}`);
      }
    }
    if (request.metrics) {
      for (const metric of request.metrics) {
        if (metric.tags?.toolId) distinctTools.add(String(metric.tags.toolId));
        if (metric.tags?.tool_id) distinctTools.add(String(metric.tags.tool_id));
      }
    }

    const MAX_DISTINCT_TOOLS_PER_BATCH = 50;
    if (distinctTools.size > MAX_DISTINCT_TOOLS_PER_BATCH) {
      alerts.push(
        this.createAlert({
          workspaceId,
          accountId: context.accountId,
          toolId: "system",
          version: "0.0.0",
          anomalyType: "cardinality_explosion",
          severity: "critical",
          description: `Telemetry batch contains ${distinctTools.size} distinct tools, exceeding safe limit of ${MAX_DISTINCT_TOOLS_PER_BATCH}`,
          evidence: {
            batchId: request.batchId,
            distinctToolCount: distinctTools.size,
            sampleTools: Array.from(distinctTools).slice(0, 10),
          },
        }),
      );
    }

    // 3. Inspect Invocations for Lifecycle & Sequence Anomalies
    if (request.invocations) {
      for (const inv of request.invocations) {
        const invStartedAt = new Date(inv.startedAt).getTime();
        const toolKey = `${inv.toolId}:${inv.toolVersion}`;

        // Check for Future Invocations
        if (invStartedAt > now + futureClockSkewThresholdMs) {
          alerts.push(
            this.createAlert({
              workspaceId,
              accountId: context.accountId,
              toolId: inv.toolId,
              version: inv.toolVersion,
              anomalyType: "impossible_timestamp",
              severity: "critical",
              description: `Invocation ${inv.invocationId} timestamp is in the future`,
              evidence: {
                invocationId: inv.invocationId,
                startedAt: inv.startedAt,
                serverTimestamp: new Date(now).toISOString(),
              },
            }),
          );
        }

        // Check Invocation Before Activation
        if (context.activeRolloutTimestamps && context.activeRolloutTimestamps[toolKey]) {
          const activatedAt = new Date(context.activeRolloutTimestamps[toolKey]).getTime();
          // Allow 5 second clock tolerance
          if (invStartedAt < activatedAt - 5000) {
            alerts.push(
              this.createAlert({
                workspaceId,
                accountId: context.accountId,
                toolId: inv.toolId,
                version: inv.toolVersion,
                anomalyType: "invocation_before_activation",
                severity: "critical",
                description: `Invocation ${inv.invocationId} reported timestamp (${inv.startedAt}) before tool version activation (${context.activeRolloutTimestamps[toolKey]})`,
                evidence: {
                  invocationId: inv.invocationId,
                  startedAt: inv.startedAt,
                  activatedAt: context.activeRolloutTimestamps[toolKey],
                },
              }),
            );
          }
        }

        // Check Revoked Tool Invocation (unless shadowRun)
        if (context.revokedVersions && context.revokedVersions[toolKey]) {
          if (!inv.resourceUsage?.shadowRun) {
            alerts.push(
              this.createAlert({
                workspaceId,
                accountId: context.accountId,
                toolId: inv.toolId,
                version: inv.toolVersion,
                anomalyType: "revoked_tool_invocation",
                severity: "critical",
                description: `Invocation reported for revoked/rolled-back tool version ${toolKey} without shadow run flag`,
                evidence: {
                  invocationId: inv.invocationId,
                  toolId: inv.toolId,
                  version: inv.toolVersion,
                  status: inv.status,
                },
              }),
            );
          }
        }
      }
    }

    // 4. Save any created alerts to repository
    if (this.metricsRepo && alerts.length > 0) {
      for (const alert of alerts) {
        await this.metricsRepo.saveAnomalyAlert(alert);
      }
    }

    return alerts;
  }

  /**
   * Check for counter reset on a monotonic sequence.
   */
  async checkSequenceCounter(
    workspaceId: string,
    sessionId: string,
    toolId: string,
    version: string,
    currentCounter: number,
    accountId?: string,
  ): Promise<AnomalyAlertRecord | null> {
    const key = `${workspaceId}:${sessionId}:${toolId}`;
    const previous = this.sequenceCounters.get(key);

    this.sequenceCounters.set(key, currentCounter);

    if (previous !== undefined && currentCounter < previous) {
      const alert = this.createAlert({
        workspaceId,
        accountId,
        toolId,
        version,
        anomalyType: "counter_reset",
        severity: "warning",
        description: `Monotonic sequence counter reset detected in session ${sessionId} (previous: ${previous}, current: ${currentCounter})`,
        evidence: {
          sessionId,
          toolId,
          version,
          previousCounter: previous,
          currentCounter,
        },
      });

      if (this.metricsRepo) {
        await this.metricsRepo.saveAnomalyAlert(alert);
      }

      return alert;
    }

    return null;
  }

  /**
   * Clear in-memory state.
   */
  clear(): void {
    this.sequenceCounters.clear();
  }

  private createAlert(data: {
    workspaceId: string;
    accountId?: string;
    toolId: string;
    version: string;
    anomalyType: AnomalyType;
    severity: AnomalySeverity;
    description: string;
    evidence: Record<string, unknown>;
  }): AnomalyAlertRecord {
    return {
      id: `anom_${randomUUID()}`,
      accountId: data.accountId,
      workspaceId: data.workspaceId,
      toolId: data.toolId,
      version: data.version,
      anomalyType: data.anomalyType,
      severity: data.severity,
      description: data.description,
      evidence: data.evidence,
      resolved: false,
      detectedAt: new Date().toISOString(),
    };
  }
}
