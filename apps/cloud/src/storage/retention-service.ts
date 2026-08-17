import type { DatabasePool, Queryable } from "../db/client.js";
import type { TenantContext } from "../tenant.js";
import { RetentionRepository } from "./repositories/retention-repository.js";

/**
 * Options for running a retention pass.
 */
export interface RetentionPassOptions {
  now?: string;
  eventRetentionDays?: number;
  sessionRetentionDays?: number;
  dryRun?: boolean;
  batchSize?: number;
}

/**
 * Result metrics from a completed retention pass.
 */
export interface RetentionPassResult {
  scannedSessions: number;
  scannedEvents: number;
  deletedSessions: number;
  deletedEvents: number;
  preservedHeldSessions: number;
  preservedHeldEvents: number;
  durationMs: number;
}

export class RetentionService {
  private retentionRepo: RetentionRepository;

  constructor(
    private pool: DatabasePool,
    options: { retentionRepo?: RetentionRepository } = {},
  ) {
    this.retentionRepo = options.retentionRepo ?? new RetentionRepository(this.pool);
  }

  /**
   * Run a retention pass for a specific tenant, pruning expired events and sessions
   * while strictly preserving held evidence and entities.
   */
  async runRetentionPass(
    tenant: TenantContext,
    options: RetentionPassOptions = {},
  ): Promise<RetentionPassResult> {
    const startTime = Date.now();
    const nowIso = options.now ?? new Date().toISOString();
    const nowDate = new Date(nowIso);

    const eventRetentionDays = options.eventRetentionDays ?? 30;
    const sessionRetentionDays = options.sessionRetentionDays ?? 90;
    const dryRun = options.dryRun ?? false;

    const eventCutoffTime = new Date(
      nowDate.getTime() - eventRetentionDays * 86400000,
    ).toISOString();
    const sessionCutoffTime = new Date(
      nowDate.getTime() - sessionRetentionDays * 86400000,
    ).toISOString();

    let scannedSessions = 0;
    let scannedEvents = 0;
    let deletedSessions = 0;
    let deletedEvents = 0;
    let preservedHeldSessions = 0;
    let preservedHeldEvents = 0;

    // Check if entire account or workspace is under hold
    const isAccountHeld = await this.retentionRepo.isTargetHeld(
      tenant,
      "account",
      tenant.accountId,
      nowIso,
    );
    const isWorkspaceHeld = await this.retentionRepo.isTargetHeld(
      tenant,
      "workspace",
      tenant.workspaceId,
      nowIso,
    );

    if (isAccountHeld || isWorkspaceHeld) {
      return {
        scannedSessions,
        scannedEvents,
        deletedSessions: 0,
        deletedEvents: 0,
        preservedHeldSessions,
        preservedHeldEvents,
        durationMs: Date.now() - startTime,
      };
    }

    // 1. Process expired sessions
    const expiredSessionsRes = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM sessions WHERE account_id = $1 AND workspace_id = $2 AND started_at < $3`,
      [tenant.accountId, tenant.workspaceId, sessionCutoffTime],
    );
    scannedSessions = expiredSessionsRes.rows.length;

    for (const sessionRow of expiredSessionsRes.rows) {
      const sessionId = String(sessionRow.id);

      // Check if session has active hold
      const isSessionHeld = await this.retentionRepo.isTargetHeld(
        tenant,
        "session",
        sessionId,
        nowIso,
      );

      // Check if any evidence set for this session has active hold
      const evidenceSetsRes = await this.pool.query<Record<string, unknown>>(
        `SELECT id FROM evidence_sets WHERE account_id = $1 AND workspace_id = $2 AND session_id = $3`,
        [tenant.accountId, tenant.workspaceId, sessionId],
      );

      let isAnyEvidenceHeld = false;
      for (const evRow of evidenceSetsRes.rows) {
        const evSetId = String(evRow.id);
        const isEvHeld = await this.retentionRepo.isTargetHeld(
          tenant,
          "evidence_set",
          evSetId,
          nowIso,
        );
        if (isEvHeld) {
          isAnyEvidenceHeld = true;
          break;
        }
      }

      if (isSessionHeld || isAnyEvidenceHeld) {
        preservedHeldSessions++;
        continue;
      }

      if (!dryRun) {
        await this.pool.transaction(async (txClient: Queryable) => {
          // Delete evidence members and sets for this session
          for (const evRow of evidenceSetsRes.rows) {
            const evSetId = String(evRow.id);
            await txClient.query(
              `DELETE FROM evidence_members WHERE account_id = $1 AND workspace_id = $2 AND evidence_set_id = $3`,
              [tenant.accountId, tenant.workspaceId, evSetId],
            );
            await txClient.query(
              `DELETE FROM evidence_sets WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
              [tenant.accountId, tenant.workspaceId, evSetId],
            );
          }

          // Delete session events
          const delEvts = await txClient.query(
            `DELETE FROM normalized_events WHERE account_id = $1 AND workspace_id = $2 AND session_id = $3`,
            [tenant.accountId, tenant.workspaceId, sessionId],
          );
          deletedEvents += delEvts.rowCount;

          // Delete session branches
          await txClient.query(
            `DELETE FROM session_branches WHERE account_id = $1 AND workspace_id = $2 AND session_id = $3`,
            [tenant.accountId, tenant.workspaceId, sessionId],
          );

          // Delete session
          await txClient.query(
            `DELETE FROM sessions WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
            [tenant.accountId, tenant.workspaceId, sessionId],
          );
        });
      }

      deletedSessions++;
    }

    // 2. Process expired individual events in retained sessions
    const expiredEventsRes = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM normalized_events WHERE account_id = $1 AND workspace_id = $2 AND timestamp < $3`,
      [tenant.accountId, tenant.workspaceId, eventCutoffTime],
    );
    scannedEvents = expiredEventsRes.rows.length;

    for (const evtRow of expiredEventsRes.rows) {
      const eventId = String(evtRow.id);
      const sessionId = String(evtRow.session_id);

      // Check if session or event is held
      const isSessionHeld = await this.retentionRepo.isTargetHeld(
        tenant,
        "session",
        sessionId,
        nowIso,
      );
      if (isSessionHeld) {
        preservedHeldEvents++;
        continue;
      }

      // Check if event is referenced by any evidence set
      const evidenceMemberRes = await this.pool.query<Record<string, unknown>>(
        `SELECT id FROM evidence_members WHERE account_id = $1 AND workspace_id = $2 AND event_id = $3`,
        [tenant.accountId, tenant.workspaceId, eventId],
      );

      if (evidenceMemberRes.rows.length > 0) {
        preservedHeldEvents++;
        continue;
      }

      if (!dryRun) {
        await this.pool.query(
          `DELETE FROM normalized_events WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
          [tenant.accountId, tenant.workspaceId, eventId],
        );
      }
      deletedEvents++;
    }

    return {
      scannedSessions,
      scannedEvents,
      deletedSessions,
      deletedEvents,
      preservedHeldSessions,
      preservedHeldEvents,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Factory function creating a RetentionService.
 */
export function createRetentionService(
  pool: DatabasePool,
  options?: { retentionRepo?: RetentionRepository },
): RetentionService {
  return new RetentionService(pool, options);
}
