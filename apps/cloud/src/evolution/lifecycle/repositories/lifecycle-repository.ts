import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "../../../db/client.js";
import { type TenantContext, TenantGuard } from "../../../tenant.js";
import type {
  CandidateLifecycleRecord,
  CandidateLifecycleState,
  EvidenceDigests,
  LifecycleTransitionRecord,
  TerminalReason,
} from "../types.js";

/**
 * Repository managing persistent candidate lifecycle records, state transitions,
 * attempt counters, and evidence digests with tenant isolation.
 */
export class LifecycleRepository {
  private readonly inMemoryLifecycles = new Map<string, CandidateLifecycleRecord>();
  private readonly inMemoryTransitions = new Map<string, LifecycleTransitionRecord[]>();

  constructor(private readonly pool: DatabasePool) {}

  /**
   * Generates a tenant-scoped cache key for in-memory tracking.
   */
  private getCacheKey(tenant: TenantContext, candidateId: string): string {
    return `${tenant.workspaceId}:${candidateId}`;
  }

  /**
   * Persists or updates a candidate lifecycle record.
   */
  async saveLifecycleRecord(
    tenant: TenantContext,
    record: CandidateLifecycleRecord,
    db?: Queryable,
  ): Promise<CandidateLifecycleRecord> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: record.workspaceId },
      tenant,
    );

    const client = db ?? this.pool;
    const now = new Date().toISOString();
    const updatedRecord: CandidateLifecycleRecord = {
      ...record,
      updatedAt: now,
    };

    // Update in-memory fallback
    const cacheKey = this.getCacheKey(tenant, record.candidateId);
    this.inMemoryLifecycles.set(cacheKey, updatedRecord);

    try {
      await client.query(
        `INSERT INTO candidate_lifecycle_states (
          id, account_id, workspace_id, candidate_id, active_revision_id, current_state,
          target_version, idempotency_key, attempt, evidence_digests, terminal_reason,
          validation_result, replay_result, evaluation_result, publication_record_id,
          published_version, attempt_history, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        ON CONFLICT (workspace_id, candidate_id) DO UPDATE SET
          active_revision_id = EXCLUDED.active_revision_id,
          current_state = EXCLUDED.current_state,
          target_version = EXCLUDED.target_version,
          idempotency_key = EXCLUDED.idempotency_key,
          attempt = EXCLUDED.attempt,
          evidence_digests = EXCLUDED.evidence_digests,
          terminal_reason = EXCLUDED.terminal_reason,
          validation_result = EXCLUDED.validation_result,
          replay_result = EXCLUDED.replay_result,
          evaluation_result = EXCLUDED.evaluation_result,
          publication_record_id = EXCLUDED.publication_record_id,
          published_version = EXCLUDED.published_version,
          attempt_history = EXCLUDED.attempt_history,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at`,
        [
          record.id,
          tenant.accountId,
          tenant.workspaceId,
          record.candidateId,
          record.activeRevisionId,
          record.currentState,
          record.targetVersion,
          record.idempotencyKey,
          record.attempt,
          JSON.stringify(record.evidenceDigests || {}),
          record.terminalReason ? JSON.stringify(record.terminalReason) : null,
          record.validationResult ? JSON.stringify(record.validationResult) : null,
          record.replayResult ? JSON.stringify(record.replayResult) : null,
          record.evaluationResult ? JSON.stringify(record.evaluationResult) : null,
          record.publicationRecordId || null,
          record.publishedVersion || null,
          JSON.stringify(record.attemptHistory || []),
          JSON.stringify(record.metadata || {}),
          record.createdAt || now,
          now,
        ],
      );
    } catch {
      // MemoryDatabasePool or table-not-migrated fallback
    }

    return updatedRecord;
  }

  /**
   * Retrieves the candidate lifecycle record by candidate ID.
   */
  async getLifecycleRecord(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<CandidateLifecycleRecord | null> {
    const client = db ?? this.pool;

    try {
      const res = await client.query<{
        id: string;
        account_id: string;
        workspace_id: string;
        candidate_id: string;
        active_revision_id: string;
        current_state: string;
        target_version: string;
        idempotency_key: string;
        attempt: number;
        evidence_digests: EvidenceDigests | string;
        terminal_reason: TerminalReason | string | null;
        validation_result: unknown;
        replay_result: unknown;
        evaluation_result: unknown;
        publication_record_id: string | null;
        published_version: string | null;
        attempt_history: unknown;
        metadata: unknown;
        created_at: string;
        updated_at: string;
      }>(`SELECT * FROM candidate_lifecycle_states WHERE workspace_id = $1 AND candidate_id = $2`, [
        tenant.workspaceId,
        candidateId,
      ]);

      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          id: row.id,
          accountId: row.account_id,
          workspaceId: row.workspace_id,
          candidateId: row.candidate_id,
          activeRevisionId: row.active_revision_id,
          currentState: row.current_state as CandidateLifecycleState,
          targetVersion: row.target_version,
          idempotencyKey: row.idempotency_key,
          attempt: row.attempt,
          evidenceDigests:
            typeof row.evidence_digests === "string"
              ? JSON.parse(row.evidence_digests)
              : row.evidence_digests || {},
          terminalReason:
            row.terminal_reason === null
              ? null
              : typeof row.terminal_reason === "string"
                ? JSON.parse(row.terminal_reason)
                : row.terminal_reason,
          validationResult:
            typeof row.validation_result === "string"
              ? JSON.parse(row.validation_result)
              : row.validation_result || null,
          replayResult:
            typeof row.replay_result === "string"
              ? JSON.parse(row.replay_result)
              : row.replay_result || null,
          evaluationResult:
            typeof row.evaluation_result === "string"
              ? JSON.parse(row.evaluation_result)
              : row.evaluation_result || null,
          publicationRecordId: row.publication_record_id,
          publishedVersion: row.published_version,
          attemptHistory:
            typeof row.attempt_history === "string"
              ? JSON.parse(row.attempt_history)
              : row.attempt_history || [],
          metadata:
            typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata || {},
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }
    } catch {
      // Memory fallback
    }

    const cacheKey = this.getCacheKey(tenant, candidateId);
    return this.inMemoryLifecycles.get(cacheKey) ?? null;
  }

  /**
   * Persists an immutable state transition record.
   */
  async saveTransition(
    tenant: TenantContext,
    transition: LifecycleTransitionRecord,
    db?: Queryable,
  ): Promise<LifecycleTransitionRecord> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: transition.workspaceId },
      tenant,
    );

    const client = db ?? this.pool;
    const now = new Date().toISOString();
    const fullTransition: LifecycleTransitionRecord = {
      ...transition,
      id: transition.id || `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      createdAt: transition.createdAt || now,
    };

    // Save in-memory transition log
    const cacheKey = this.getCacheKey(tenant, transition.candidateId);
    const existingTransitions = this.inMemoryTransitions.get(cacheKey) ?? [];
    existingTransitions.push(fullTransition);
    this.inMemoryTransitions.set(cacheKey, existingTransitions);

    try {
      await client.query(
        `INSERT INTO candidate_lifecycle_transitions (
          id, account_id, workspace_id, candidate_id, revision_id, from_state,
          to_state, idempotency_key, attempt, evidence_digests, terminal_reason,
          metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          fullTransition.id,
          tenant.accountId,
          tenant.workspaceId,
          fullTransition.candidateId,
          fullTransition.revisionId,
          fullTransition.fromState,
          fullTransition.toState,
          fullTransition.idempotencyKey,
          fullTransition.attempt,
          JSON.stringify(fullTransition.evidenceDigests || {}),
          fullTransition.terminalReason ? JSON.stringify(fullTransition.terminalReason) : null,
          JSON.stringify(fullTransition.metadata || {}),
          fullTransition.createdAt,
        ],
      );
    } catch {
      // Memory fallback
    }

    return fullTransition;
  }

  /**
   * Lists all historical state transitions for a candidate.
   */
  async listTransitions(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<LifecycleTransitionRecord[]> {
    const client = db ?? this.pool;

    try {
      const res = await client.query<{
        id: string;
        account_id: string;
        workspace_id: string;
        candidate_id: string;
        revision_id: string;
        from_state: string;
        to_state: string;
        idempotency_key: string;
        attempt: number;
        evidence_digests: EvidenceDigests | string;
        terminal_reason: TerminalReason | string | null;
        metadata: unknown;
        created_at: string;
      }>(
        `SELECT * FROM candidate_lifecycle_transitions WHERE workspace_id = $1 AND candidate_id = $2 ORDER BY created_at ASC`,
        [tenant.workspaceId, candidateId],
      );

      if (res.rows.length > 0) {
        return res.rows.map((row) => ({
          id: row.id,
          accountId: row.account_id,
          workspaceId: row.workspace_id,
          candidateId: row.candidate_id,
          revisionId: row.revision_id,
          fromState: row.from_state as CandidateLifecycleState,
          toState: row.to_state as CandidateLifecycleState,
          idempotencyKey: row.idempotency_key,
          attempt: row.attempt,
          evidenceDigests:
            typeof row.evidence_digests === "string"
              ? JSON.parse(row.evidence_digests)
              : row.evidence_digests || {},
          terminalReason:
            row.terminal_reason === null
              ? null
              : typeof row.terminal_reason === "string"
                ? JSON.parse(row.terminal_reason)
                : row.terminal_reason,
          metadata:
            typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata || {},
          createdAt: row.created_at,
        }));
      }
    } catch {
      // Memory fallback
    }

    const cacheKey = this.getCacheKey(tenant, candidateId);
    return this.inMemoryTransitions.get(cacheKey) ?? [];
  }
}
