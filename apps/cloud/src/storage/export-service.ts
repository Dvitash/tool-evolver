import { randomUUID } from "node:crypto";
import { canonicalJsonStringify } from "@tool-evolver/contracts";
import type { DatabasePool, Queryable } from "../db/client.js";
import type { TenantContext } from "../tenant.js";
import type {
  DeletionJobEntity,
  DeletionScope,
  ExportJobEntity,
  ExportScope,
} from "./models/retention.js";
import type { ObjectStore } from "./object-store.js";
import { EvidenceRepository } from "./repositories/evidence-repository.js";
import { ObservationRepository } from "./repositories/observation-repository.js";
import { RetentionRepository } from "./repositories/retention-repository.js";
import { SessionRepository } from "./repositories/session-repository.js";

/**
 * Error raised when a deletion is blocked by an active retention hold.
 */
export class ActiveRetentionHoldBlockedError extends Error {
  constructor(
    public readonly targetType: string,
    public readonly targetId: string,
  ) {
    super(`Deletion blocked by active retention hold on ${targetType} '${targetId}'`);
    this.name = "ActiveRetentionHoldBlockedError";
  }
}

export class ExportService {
  private obsRepo: ObservationRepository;
  private sessionRepo: SessionRepository;
  private evidenceRepo: EvidenceRepository;
  private retentionRepo: RetentionRepository;

  constructor(
    private pool: DatabasePool,
    private objectStore?: ObjectStore,
    options: {
      obsRepo?: ObservationRepository;
      sessionRepo?: SessionRepository;
      evidenceRepo?: EvidenceRepository;
      retentionRepo?: RetentionRepository;
    } = {},
  ) {
    this.obsRepo = options.obsRepo ?? new ObservationRepository(this.pool);
    this.sessionRepo = options.sessionRepo ?? new SessionRepository(this.pool);
    this.evidenceRepo = options.evidenceRepo ?? new EvidenceRepository(this.pool);
    this.retentionRepo = options.retentionRepo ?? new RetentionRepository(this.pool);
  }

  /**
   * Export observations, sessions, branches, and evidence sets into a portable bundle.
   */
  async exportData(
    tenant: TenantContext,
    request: {
      scope: ExportScope;
      targetId: string;
      requestedBy?: string;
      format?: "json" | "zip" | "ndjson";
    },
  ): Promise<ExportJobEntity> {
    const job = await this.retentionRepo.createExportJob(tenant, {
      scope: request.scope,
      targetId: request.targetId,
      requestedBy: request.requestedBy,
      format: request.format,
    });

    try {
      await this.retentionRepo.updateExportJob(tenant, job.id, {
        status: "processing",
      });

      // Gather entities
      let sessionsQuery = `SELECT * FROM sessions WHERE account_id = $1 AND workspace_id = $2`;
      const sessionsParams: unknown[] = [tenant.accountId, tenant.workspaceId];
      if (request.scope === "session") {
        sessionsQuery += ` AND id = $3`;
        sessionsParams.push(request.targetId);
      }
      const sessionsRes = await this.pool.query<Record<string, unknown>>(
        sessionsQuery,
        sessionsParams,
      );
      const sessions = sessionsRes.rows;

      let branchesQuery = `SELECT * FROM session_branches WHERE account_id = $1 AND workspace_id = $2`;
      const branchesParams: unknown[] = [tenant.accountId, tenant.workspaceId];
      if (request.scope === "session") {
        branchesQuery += ` AND session_id = $3`;
        branchesParams.push(request.targetId);
      }
      const branchesRes = await this.pool.query<Record<string, unknown>>(
        branchesQuery,
        branchesParams,
      );
      const branches = branchesRes.rows;

      let eventsQuery = `SELECT * FROM normalized_events WHERE account_id = $1 AND workspace_id = $2`;
      const eventsParams: unknown[] = [tenant.accountId, tenant.workspaceId];
      if (request.scope === "session") {
        eventsQuery += ` AND session_id = $3`;
        eventsParams.push(request.targetId);
      }
      const eventsRes = await this.pool.query<Record<string, unknown>>(eventsQuery, eventsParams);
      const events = eventsRes.rows;

      let evidenceQuery = `SELECT * FROM evidence_sets WHERE account_id = $1 AND workspace_id = $2`;
      const evidenceParams: unknown[] = [tenant.accountId, tenant.workspaceId];
      if (request.scope === "session") {
        evidenceQuery += ` AND session_id = $3`;
        evidenceParams.push(request.targetId);
      }
      const evidenceRes = await this.pool.query<Record<string, unknown>>(
        evidenceQuery,
        evidenceParams,
      );
      const evidenceSets = evidenceRes.rows;
      const bucketsRes = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM telemetry_buckets WHERE account_id = $1 AND workspace_id = $2`,
        [tenant.accountId, tenant.workspaceId],
      );
      const buckets = bucketsRes.rows;

      const windowsRes = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM rollout_metric_windows WHERE account_id = $1 AND workspace_id = $2`,
        [tenant.accountId, tenant.workspaceId],
      );
      const rolloutWindows = windowsRes.rows;

      const efficiencyRes = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM efficiency_metrics WHERE account_id = $1 AND workspace_id = $2`,
        [tenant.accountId, tenant.workspaceId],
      );
      const efficiency = efficiencyRes.rows;

      const calibrationsRes = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM evaluation_calibrations WHERE account_id = $1 AND workspace_id = $2`,
        [tenant.accountId, tenant.workspaceId],
      );
      const calibrations = calibrationsRes.rows;

      const anomaliesRes = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM anomaly_alerts WHERE account_id = $1 AND workspace_id = $2`,
        [tenant.accountId, tenant.workspaceId],
      );
      const anomalies = anomaliesRes.rows;

      const recordCount =
        sessions.length +
        branches.length +
        events.length +
        evidenceSets.length +
        buckets.length +
        rolloutWindows.length +
        efficiency.length +
        calibrations.length +
        anomalies.length;
      const manifest = {
        exportedAt: new Date().toISOString(),
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        scope: request.scope,
        targetId: request.targetId,
        counts: {
          sessions: sessions.length,
          branches: branches.length,
          events: events.length,
          evidenceSets: evidenceSets.length,
          telemetryBuckets: buckets.length,
          rolloutMetricWindows: rolloutWindows.length,
          efficiencyMetrics: efficiency.length,
          calibrations: calibrations.length,
          anomalyAlerts: anomalies.length,
          totalRecords: recordCount,
        },
      };

      const exportBundle = {
        manifest,
        sessions,
        branches,
        events,
        evidenceSets,
        telemetryBuckets: buckets,
        rolloutMetricWindows: rolloutWindows,
        efficiencyMetrics: efficiency,
        calibrations,
        anomalyAlerts: anomalies,
      };

      let exportPath: string | null = null;
      if (this.objectStore) {
        exportPath = `exports/${tenant.accountId}/${tenant.workspaceId}/${job.id}.json`;
        const content = canonicalJsonStringify(exportBundle);
        await this.objectStore.putObject(exportPath, content, {
          contentType: "application/json",
          retention: "standard",
        });
      }

      await this.retentionRepo.updateExportJob(tenant, job.id, {
        status: "completed",
        exportPath,
        manifest,
        recordCount,
        completedAt: new Date().toISOString(),
      });

      return {
        ...job,
        status: "completed",
        exportPath,
        manifest,
        recordCount,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.retentionRepo.updateExportJob(tenant, job.id, {
        status: "failed",
        error: errorMsg,
        completedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Execute cascading data deletion respecting retention holds.
   */
  async deleteData(
    tenant: TenantContext,
    request: {
      scope: DeletionScope;
      targetId: string;
      requestedBy?: string;
      force?: boolean;
    },
  ): Promise<DeletionJobEntity> {
    const job = await this.retentionRepo.createDeletionJob(tenant, {
      scope: request.scope,
      targetId: request.targetId,
      requestedBy: request.requestedBy,
    });

    try {
      await this.retentionRepo.updateDeletionJob(tenant, job.id, {
        status: "processing",
      });

      const nowIso = new Date().toISOString();

      // Check retention holds unless force is specified
      if (!request.force) {
        if (request.scope === "account") {
          const isHeld = await this.retentionRepo.isTargetHeld(
            tenant,
            "account",
            request.targetId,
            nowIso,
          );
          if (isHeld) throw new ActiveRetentionHoldBlockedError("account", request.targetId);
        } else if (request.scope === "workspace") {
          const isHeld = await this.retentionRepo.isTargetHeld(
            tenant,
            "workspace",
            request.targetId,
            nowIso,
          );
          if (isHeld) throw new ActiveRetentionHoldBlockedError("workspace", request.targetId);
        } else if (request.scope === "session") {
          const isHeld = await this.retentionRepo.isTargetHeld(
            tenant,
            "session",
            request.targetId,
            nowIso,
          );
          if (isHeld) throw new ActiveRetentionHoldBlockedError("session", request.targetId);
        }
      }

      let deletedRecordsCount = 0;
      const summary: Record<string, number> = {};

      await this.pool.transaction(async (txClient: Queryable) => {
        if (request.scope === "session") {
          const sessionId = request.targetId;

          // Delete evidence members for session
          const delEvMembers = await txClient.query(
            `DELETE FROM evidence_members WHERE account_id = $1 AND workspace_id = $2 AND evidence_set_id IN (SELECT id FROM evidence_sets WHERE session_id = $3)`,
            [tenant.accountId, tenant.workspaceId, sessionId],
          );
          summary.deletedEvidenceMembers = delEvMembers.rowCount;

          // Delete evidence sets for session
          const delEvSets = await txClient.query(
            `DELETE FROM evidence_sets WHERE account_id = $1 AND workspace_id = $2 AND session_id = $3`,
            [tenant.accountId, tenant.workspaceId, sessionId],
          );
          summary.deletedEvidenceSets = delEvSets.rowCount;

          // Delete normalized events
          const delEvents = await txClient.query(
            `DELETE FROM normalized_events WHERE account_id = $1 AND workspace_id = $2 AND session_id = $3`,
            [tenant.accountId, tenant.workspaceId, sessionId],
          );
          summary.deletedEvents = delEvents.rowCount;

          // Delete branches
          const delBranches = await txClient.query(
            `DELETE FROM session_branches WHERE account_id = $1 AND workspace_id = $2 AND session_id = $3`,
            [tenant.accountId, tenant.workspaceId, sessionId],
          );
          summary.deletedBranches = delBranches.rowCount;

          // Delete session
          const delSession = await txClient.query(
            `DELETE FROM sessions WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
            [tenant.accountId, tenant.workspaceId, sessionId],
          );
          summary.deletedSessions = delSession.rowCount;
        } else if (request.scope === "workspace" || request.scope === "account") {
          // Delete evidence members
          const delEvMembers = await txClient.query(
            `DELETE FROM evidence_members WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedEvidenceMembers = delEvMembers.rowCount;

          // Delete evidence sets
          const delEvSets = await txClient.query(
            `DELETE FROM evidence_sets WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedEvidenceSets = delEvSets.rowCount;

          // Delete normalized events
          const delEvents = await txClient.query(
            `DELETE FROM normalized_events WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedEvents = delEvents.rowCount;

          // Delete branches
          const delBranches = await txClient.query(
            `DELETE FROM session_branches WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedBranches = delBranches.rowCount;

          // Delete sessions
          const delSessions = await txClient.query(
            `DELETE FROM sessions WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedSessions = delSessions.rowCount;

          // Delete analytics tables
          const delBuckets = await txClient.query(
            `DELETE FROM telemetry_buckets WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedTelemetryBuckets = delBuckets.rowCount;

          const delWindows = await txClient.query(
            `DELETE FROM rollout_metric_windows WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedRolloutMetricWindows = delWindows.rowCount;

          const delEfficiency = await txClient.query(
            `DELETE FROM efficiency_metrics WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedEfficiencyMetrics = delEfficiency.rowCount;

          const delCalibrations = await txClient.query(
            `DELETE FROM evaluation_calibrations WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedEvaluationCalibrations = delCalibrations.rowCount;

          const delAnomalies = await txClient.query(
            `DELETE FROM anomaly_alerts WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedAnomalyAlerts = delAnomalies.rowCount;

          const delReceipts = await txClient.query(
            `DELETE FROM telemetry_receipts WHERE account_id = $1 AND workspace_id = $2`,
            [tenant.accountId, tenant.workspaceId],
          );
          summary.deletedTelemetryReceipts = delReceipts.rowCount;
        }

        deletedRecordsCount = Object.values(summary).reduce((acc, n) => acc + n, 0);
      });

      await this.retentionRepo.updateDeletionJob(tenant, job.id, {
        status: "completed",
        deletedRecordsCount,
        summary,
        completedAt: new Date().toISOString(),
      });

      return {
        ...job,
        status: "completed",
        deletedRecordsCount,
        summary,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.retentionRepo.updateDeletionJob(tenant, job.id, {
        status: "failed",
        error: errorMsg,
        completedAt: new Date().toISOString(),
      });
      throw error;
    }
  }
}

/**
 * Factory function creating an ExportService.
 */
export function createExportService(
  pool: DatabasePool,
  objectStore?: ObjectStore,
  options?: {
    obsRepo?: ObservationRepository;
    sessionRepo?: SessionRepository;
    evidenceRepo?: EvidenceRepository;
    retentionRepo?: RetentionRepository;
  },
): ExportService {
  return new ExportService(pool, objectStore, options);
}
