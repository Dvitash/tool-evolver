import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "../../../db/client.js";
import { type TenantContext, TenantGuard } from "../../../tenant.js";
import { redactDiagnostics } from "../retry-classifier.js";
import type {
  CandidateLifecycleDlqRecord,
  CandidateLifecycleRecord,
  CandidateLifecycleState,
  DlqFilter,
  EvidenceDigests,
  LifecycleTransitionRecord,
  TerminalReason,
} from "../types.js";

/**
 * Repository managing persistent candidate lifecycle records, state transitions,
 * attempt counters, and dead-letter queue records with strict tenant isolation.
 */
export class LifecycleRepository {
  private readonly inMemoryLifecycles = new Map<string, CandidateLifecycleRecord>();
  private readonly inMemoryTransitions = new Map<string, LifecycleTransitionRecord[]>();
  private readonly inMemoryDlq = new Map<string, CandidateLifecycleDlqRecord>();

  constructor(private readonly pool?: DatabasePool) {}

  private enforceTenant(tenant: TenantContext): void {
    if (tenant?.accountId && tenant?.workspaceId) {
      TenantGuard.assertAccess(
        { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
        tenant,
      );
    }
  }

  private getCacheKey(tenant: TenantContext, candidateId: string): string {
    return `${tenant.workspaceId}:${candidateId}`;
  }

  private getDlqCacheKey(tenant: TenantContext, dlqId: string): string {
    return `${tenant.workspaceId}:${dlqId}`;
  }

  /**
   * Persists a candidate lifecycle state transition, updates the candidate_lifecycle_states record,
   * and appends to the immutable candidate_lifecycle_transitions audit table with idempotency.
   */
  async recordTransition(
    tenant: TenantContext,
    candidateId: string,
    transition: {
      revisionId: string;
      fromState: CandidateLifecycleState;
      toState: CandidateLifecycleState;
      targetVersion: string;
      idempotencyKey: string;
      attempt: number;
      evidenceDigests?: EvidenceDigests;
      terminalReason?: TerminalReason | null;
      validationResult?: CandidateLifecycleRecord["validationResult"];
      replayResult?: CandidateLifecycleRecord["replayResult"];
      evaluationResult?: CandidateLifecycleRecord["evaluationResult"];
      publicationRecordId?: string | null;
      publishedVersion?: string | null;
      attemptHistoryEntry?: CandidateLifecycleRecord["attemptHistory"][number];
      metadata?: Record<string, unknown>;
      persistedReplayOptions?: CandidateLifecycleRecord["persistedReplayOptions"];
      persistedReplayOptionsDigest?: CandidateLifecycleRecord["persistedReplayOptionsDigest"];
    },
    db?: Queryable,
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);

    const client = db ?? this.pool;
    const cacheKey = this.getCacheKey(tenant, candidateId);
    const existing = await this.getLifecycle(tenant, candidateId, db);
    const now = new Date().toISOString();
    const isRevisionChange = !!existing && transition.revisionId !== existing.activeRevisionId;

    let mergedDigests: EvidenceDigests;
    if (isRevisionChange) {
      // Revision changed: start a fresh validation chain and clear downstream
      // stage digests (validation/replay/evaluation/artifact). Artifact-set
      // digests for the new revision are taken solely from the transition.
      mergedDigests = {
        ...(transition.evidenceDigests || {}),
      };
    } else {
      mergedDigests = {
        ...(existing?.evidenceDigests || {}),
        ...(transition.evidenceDigests || {}),
      };
    }

    const attemptHistory = [...(existing?.attemptHistory || [])];
    if (transition.attemptHistoryEntry) {
      attemptHistory.push(transition.attemptHistoryEntry);
    }

    const sanitizedMetadata =
      (redactDiagnostics(transition.metadata || {}) as Record<string, unknown>) || {};
    const sanitizedTerminalReason = transition.terminalReason
      ? (redactDiagnostics(
          transition.terminalReason as unknown as Record<string, unknown>,
        ) as unknown as TerminalReason)
      : isRevisionChange
        ? null
        : null;
    // When revision changes, terminal reason is cleared unless explicitly
    // provided by the new transition (e.g., repair sets it to null).
    const effectiveTerminalReason =
      transition.terminalReason !== undefined
        ? sanitizedTerminalReason
        : isRevisionChange
          ? null
          : (existing?.terminalReason as TerminalReason | null | undefined) ?? null;

    const effectiveValidationResult = isRevisionChange
      ? transition.validationResult !== undefined
        ? transition.validationResult
        : null
      : transition.validationResult !== undefined
        ? transition.validationResult
        : existing?.validationResult;
    const effectiveReplayResult = isRevisionChange
      ? transition.replayResult !== undefined
        ? transition.replayResult
        : null
      : transition.replayResult !== undefined
        ? transition.replayResult
        : existing?.replayResult;
    const effectiveEvaluationResult = isRevisionChange
      ? transition.evaluationResult !== undefined
        ? transition.evaluationResult
        : null
      : transition.evaluationResult !== undefined
        ? transition.evaluationResult
        : existing?.evaluationResult;
    const effectivePublicationRecordId = isRevisionChange
      ? transition.publicationRecordId !== undefined
        ? transition.publicationRecordId
        : null
      : transition.publicationRecordId !== undefined
        ? transition.publicationRecordId
        : existing?.publicationRecordId;
    const effectivePublishedVersion = isRevisionChange
      ? transition.publishedVersion !== undefined
        ? transition.publishedVersion
        : null
      : transition.publishedVersion !== undefined
        ? transition.publishedVersion
        : existing?.publishedVersion;

    // Sync replayOptionsDigest in evidenceDigests with persisted digest for status exposure
    // This is done after effective digest is computed to ensure consistency.
    if (isRevisionChange) {
      // On revision change, replayOptionsDigest is managed via transition.evidenceDigests above; downstream will be cleared
    }

    const effectivePersistedReplayOptions = isRevisionChange
      ? transition.persistedReplayOptions !== undefined
        ? transition.persistedReplayOptions
        : null
      : transition.persistedReplayOptions !== undefined
        ? transition.persistedReplayOptions
        : existing?.persistedReplayOptions;

    const effectivePersistedReplayOptionsDigest = isRevisionChange
      ? transition.persistedReplayOptionsDigest !== undefined
        ? transition.persistedReplayOptionsDigest
        : null
      : transition.persistedReplayOptionsDigest !== undefined
        ? transition.persistedReplayOptionsDigest
        : existing?.persistedReplayOptionsDigest;

    // Keep EvidenceDigests.replayOptionsDigest in sync with persisted digest for observability
    if (effectivePersistedReplayOptionsDigest) {
      mergedDigests.replayOptionsDigest = effectivePersistedReplayOptionsDigest;
    } else if (isRevisionChange) {
      delete mergedDigests.replayOptionsDigest;
    } else if (transition.evidenceDigests?.replayOptionsDigest === undefined && existing?.evidenceDigests?.replayOptionsDigest && !effectivePersistedReplayOptionsDigest) {
      // retain existing if not cleared
    } else if (!effectivePersistedReplayOptionsDigest) {
      delete mergedDigests.replayOptionsDigest;
    }

    const record: CandidateLifecycleRecord = {
      id: existing?.id ?? `cls_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      candidateId,
      activeRevisionId: transition.revisionId,
      currentState: transition.toState,
      targetVersion: transition.targetVersion,
      idempotencyKey: transition.idempotencyKey,
      attempt: transition.attempt,
      evidenceDigests: mergedDigests,
      terminalReason: effectiveTerminalReason,
      validationResult: effectiveValidationResult as CandidateLifecycleRecord["validationResult"],
      replayResult: effectiveReplayResult as CandidateLifecycleRecord["replayResult"],
      evaluationResult: effectiveEvaluationResult as CandidateLifecycleRecord["evaluationResult"],
      publicationRecordId: effectivePublicationRecordId,
      publishedVersion: effectivePublishedVersion,
      persistedReplayOptions: effectivePersistedReplayOptions as CandidateLifecycleRecord["persistedReplayOptions"],
      persistedReplayOptionsDigest: effectivePersistedReplayOptionsDigest as CandidateLifecycleRecord["persistedReplayOptionsDigest"],
      attemptHistory,
      metadata: { ...(existing?.metadata || {}), ...sanitizedMetadata },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const transitionRecord: LifecycleTransitionRecord = {
      id: `ltr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      candidateId,
      revisionId: transition.revisionId,
      fromState: transition.fromState,
      toState: transition.toState,
      idempotencyKey: transition.idempotencyKey,
      attempt: transition.attempt,
      evidenceDigests: mergedDigests,
      terminalReason: sanitizedTerminalReason,
      metadata: sanitizedMetadata,
      createdAt: now,
    };

    const transitions = this.inMemoryTransitions.get(cacheKey) ?? [];
    if (!transitions.some((t) => t.idempotencyKey === transition.idempotencyKey)) {
      transitions.push(transitionRecord);
      this.inMemoryTransitions.set(cacheKey, transitions);
    }

    if (client) {
      try {
        await client.query(
          `
          INSERT INTO candidate_lifecycle_states (
            id, account_id, workspace_id, candidate_id, active_revision_id,
            current_state, target_version, idempotency_key, attempt,
            evidence_digests, terminal_reason, validation_result, replay_result, evaluation_result,
            publication_record_id, published_version, attempt_history, metadata,
            persisted_replay_options, persisted_replay_options_digest,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
            persisted_replay_options = EXCLUDED.persisted_replay_options,
            persisted_replay_options_digest = EXCLUDED.persisted_replay_options_digest,
            updated_at = EXCLUDED.updated_at;
          `,
          [
            record.id,
            record.accountId,
            record.workspaceId,
            record.candidateId,
            record.activeRevisionId,
            record.currentState,
            record.targetVersion,
            record.idempotencyKey,
            record.attempt,
            JSON.stringify(record.evidenceDigests),
            record.terminalReason ? JSON.stringify(record.terminalReason) : null,
            record.validationResult ? JSON.stringify(record.validationResult) : null,
            record.replayResult ? JSON.stringify(record.replayResult) : null,
            record.evaluationResult ? JSON.stringify(record.evaluationResult) : null,
            record.publicationRecordId ?? null,
            record.publishedVersion ?? null,
            JSON.stringify(record.attemptHistory),
            JSON.stringify(record.metadata),
            record.persistedReplayOptions ? JSON.stringify(record.persistedReplayOptions) : null,
            record.persistedReplayOptionsDigest ?? null,
            record.createdAt,
            record.updatedAt,
          ],
        );

        await client.query(
          `
          INSERT INTO candidate_lifecycle_transitions (
            id, account_id, workspace_id, candidate_id, revision_id,
            from_state, to_state, idempotency_key, attempt,
            evidence_digests, terminal_reason, metadata, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;
          `,
          [
            transitionRecord.id,
            transitionRecord.accountId,
            transitionRecord.workspaceId,
            transitionRecord.candidateId,
            transitionRecord.revisionId,
            transitionRecord.fromState,
            transitionRecord.toState,
            transitionRecord.idempotencyKey,
            transitionRecord.attempt,
            JSON.stringify(transitionRecord.evidenceDigests),
            transitionRecord.terminalReason
              ? JSON.stringify(transitionRecord.terminalReason)
              : null,
            JSON.stringify(transitionRecord.metadata),
            transitionRecord.createdAt,
          ],
        );
      } catch {
        // Continue with memory fallback if DB fails
      }
    }

    return record;
  }

  /**
   * Retrieves candidate lifecycle record by candidateId with tenant scoping.
   */
  async getLifecycle(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<CandidateLifecycleRecord | null> {
    this.enforceTenant(tenant);

    const client = db ?? this.pool;
    if (client) {
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
          evidence_digests: string | EvidenceDigests;
          terminal_reason: string | TerminalReason | null;
          validation_result: string | CandidateLifecycleRecord["validationResult"] | null;
          replay_result: string | CandidateLifecycleRecord["replayResult"] | null;
          evaluation_result: string | CandidateLifecycleRecord["evaluationResult"] | null;
          publication_record_id: string | null;
          published_version: string | null;
          attempt_history: string | CandidateLifecycleRecord["attemptHistory"];
          metadata: string | Record<string, unknown>;
          persisted_replay_options?: string | CandidateLifecycleRecord["persistedReplayOptions"] | null;
          persisted_replay_options_digest?: string | null;
          created_at: string;
          updated_at: string;
        }>(
          `
          SELECT * FROM candidate_lifecycle_states
          WHERE workspace_id = $1 AND candidate_id = $2
          LIMIT 1;
          `,
          [tenant.workspaceId, candidateId],
        );

        if (res.rows.length > 0) {
          const row = res.rows[0];
          const record: CandidateLifecycleRecord = {
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
              row.validation_result === null
                ? null
                : typeof row.validation_result === "string"
                  ? JSON.parse(row.validation_result)
                  : row.validation_result,
            replayResult:
              row.replay_result === null
                ? null
                : typeof row.replay_result === "string"
                  ? JSON.parse(row.replay_result)
                  : row.replay_result,
            evaluationResult:
              row.evaluation_result === null
                ? null
                : typeof row.evaluation_result === "string"
                  ? JSON.parse(row.evaluation_result)
                  : row.evaluation_result,
            publicationRecordId: row.publication_record_id,
            publishedVersion: row.published_version,
            attemptHistory:
              typeof row.attempt_history === "string"
                ? JSON.parse(row.attempt_history)
                : row.attempt_history || [],
            metadata:
              typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata || {},
            persistedReplayOptions:
              (row as unknown as { persisted_replay_options?: unknown }).persisted_replay_options === null ||
              (row as unknown as { persisted_replay_options?: unknown }).persisted_replay_options === undefined
                ? ((() => {
                    const metaRaw = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown> | null) ?? {};
                    const meta = metaRaw as Record<string, unknown>;
                    return (meta.persistedReplayOptions as CandidateLifecycleRecord["persistedReplayOptions"] ?? null);
                  })())
                : typeof (row as unknown as { persisted_replay_options?: unknown }).persisted_replay_options === "string"
                  ? (JSON.parse((row as unknown as { persisted_replay_options: string }).persisted_replay_options) as CandidateLifecycleRecord["persistedReplayOptions"])
                  : ((row as unknown as { persisted_replay_options?: unknown }).persisted_replay_options as CandidateLifecycleRecord["persistedReplayOptions"]),
            persistedReplayOptionsDigest:
              ((row as unknown as { persisted_replay_options_digest?: unknown }).persisted_replay_options_digest as string | null | undefined) ??
              ((() => {
                const metaRaw = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown> | null) ?? {};
                const meta = metaRaw as Record<string, unknown>;
                return meta.persistedReplayOptionsDigest as string | null | undefined;
              })()) ??
              (row.evidence_digests && typeof row.evidence_digests !== "string" ? (row.evidence_digests as EvidenceDigests).replayOptionsDigest ?? null : null) ??
              null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
          this.inMemoryLifecycles.set(this.getCacheKey(tenant, candidateId), record);
          return record;
        }
      } catch {
        // Fall back to memory
      }
    }

    const cacheKey = this.getCacheKey(tenant, candidateId);
    return this.inMemoryLifecycles.get(cacheKey) ?? null;
  }

  /**
   * Retrieves the immutable audit log of transitions for a candidate.
   */
  async getTransitions(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<LifecycleTransitionRecord[]> {
    this.enforceTenant(tenant);

    const client = db ?? this.pool;
    if (client) {
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
          evidence_digests: string | EvidenceDigests;
          terminal_reason: string | TerminalReason | null;
          metadata: string | Record<string, unknown>;
          created_at: string;
        }>(
          `
          SELECT * FROM candidate_lifecycle_transitions
          WHERE workspace_id = $1 AND candidate_id = $2
          ORDER BY created_at ASC;
          `,
          [tenant.workspaceId, candidateId],
        );

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
      } catch {
        // Memory fallback
      }
    }

    const cacheKey = this.getCacheKey(tenant, candidateId);
    return this.inMemoryTransitions.get(cacheKey) ?? [];
  }

  /**
   * Persists a terminal failure or quarantined candidate into the tenant-scoped DLQ table.
   */
  async saveDlqRecord(
    tenant: TenantContext,
    dlqRecord: CandidateLifecycleDlqRecord,
    db?: Queryable,
  ): Promise<CandidateLifecycleDlqRecord> {
    this.enforceTenant(tenant);

    const client = db ?? this.pool;
    const now = new Date().toISOString();
    const sanitizedDiagnostics =
      (redactDiagnostics(dlqRecord.diagnostics || {}) as Record<string, unknown>) || {};

    const record: CandidateLifecycleDlqRecord = {
      ...dlqRecord,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      diagnostics: sanitizedDiagnostics,
      createdAt: dlqRecord.createdAt || now,
      updatedAt: now,
    };

    const cacheKey = this.getDlqCacheKey(tenant, record.id);
    this.inMemoryDlq.set(cacheKey, record);

    if (client) {
      try {
        await client.query(
          `
          INSERT INTO candidate_lifecycle_dlq (
            id, account_id, workspace_id, candidate_id, revision_id,
            stage, error_category, error_message, retry_classification,
            attempt_count, diagnostics, resumed, resumed_at, resumed_by,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          ON CONFLICT (workspace_id, id) DO UPDATE SET
            error_category = EXCLUDED.error_category,
            error_message = EXCLUDED.error_message,
            retry_classification = EXCLUDED.retry_classification,
            attempt_count = EXCLUDED.attempt_count,
            diagnostics = EXCLUDED.diagnostics,
            resumed = EXCLUDED.resumed,
            resumed_at = EXCLUDED.resumed_at,
            resumed_by = EXCLUDED.resumed_by,
            updated_at = EXCLUDED.updated_at;
          `,
          [
            record.id,
            record.accountId,
            record.workspaceId,
            record.candidateId,
            record.revisionId,
            record.stage,
            record.errorCategory,
            record.errorMessage,
            record.retryClassification,
            record.attemptCount,
            JSON.stringify(record.diagnostics),
            record.resumed,
            record.resumedAt ?? null,
            record.resumedBy ?? null,
            record.createdAt,
            record.updatedAt,
          ],
        );
      } catch {
        // Memory fallback
      }
    }

    return record;
  }

  /**
   * Retrieves a single DLQ record by ID.
   */
  async getDlqRecord(
    tenant: TenantContext,
    dlqId: string,
    db?: Queryable,
  ): Promise<CandidateLifecycleDlqRecord | null> {
    this.enforceTenant(tenant);

    const client = db ?? this.pool;
    if (client) {
      try {
        const res = await client.query<{
          id: string;
          account_id: string;
          workspace_id: string;
          candidate_id: string;
          revision_id: string;
          stage: string;
          error_category: string;
          error_message: string;
          retry_classification: string;
          attempt_count: number;
          diagnostics: string | Record<string, unknown>;
          resumed: boolean;
          resumed_at: string | null;
          resumed_by: string | null;
          created_at: string;
          updated_at: string;
        }>(
          `
          SELECT * FROM candidate_lifecycle_dlq
          WHERE workspace_id = $1 AND id = $2
          LIMIT 1;
          `,
          [tenant.workspaceId, dlqId],
        );

        if (res.rows.length > 0) {
          const row = res.rows[0];
          const record: CandidateLifecycleDlqRecord = {
            id: row.id,
            accountId: row.account_id,
            workspaceId: row.workspace_id,
            candidateId: row.candidate_id,
            revisionId: row.revision_id,
            stage: row.stage as CandidateLifecycleDlqRecord["stage"],
            errorCategory: row.error_category as CandidateLifecycleDlqRecord["errorCategory"],
            errorMessage: row.error_message,
            retryClassification:
              row.retry_classification as CandidateLifecycleDlqRecord["retryClassification"],
            attemptCount: row.attempt_count,
            diagnostics:
              typeof row.diagnostics === "string"
                ? JSON.parse(row.diagnostics)
                : row.diagnostics || {},
            resumed: row.resumed,
            resumedAt: row.resumed_at,
            resumedBy: row.resumed_by,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
          this.inMemoryDlq.set(this.getDlqCacheKey(tenant, dlqId), record);
          return record;
        }
      } catch {
        // Memory fallback
      }
    }

    return this.inMemoryDlq.get(this.getDlqCacheKey(tenant, dlqId)) ?? null;
  }

  /**
   * Lists DLQ records for a tenant with optional filtering.
   */
  async listDlqRecords(
    tenant: TenantContext,
    filter: DlqFilter = {},
    db?: Queryable,
  ): Promise<CandidateLifecycleDlqRecord[]> {
    this.enforceTenant(tenant);

    const client = db ?? this.pool;
    if (client) {
      try {
        const conditions: string[] = ["workspace_id = $1"];
        const params: unknown[] = [tenant.workspaceId];
        let idx = 2;

        if (filter.candidateId) {
          conditions.push(`candidate_id = $${idx++}`);
          params.push(filter.candidateId);
        }
        if (filter.stage) {
          conditions.push(`stage = $${idx++}`);
          params.push(filter.stage);
        }
        if (filter.errorCategory) {
          conditions.push(`error_category = $${idx++}`);
          params.push(filter.errorCategory);
        }
        if (filter.resumed !== undefined) {
          conditions.push(`resumed = $${idx++}`);
          params.push(filter.resumed);
        }

        const queryText = `
          SELECT * FROM candidate_lifecycle_dlq
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT ${filter.limit ?? 100}
          OFFSET ${filter.offset ?? 0};
        `;

        const res = await client.query<{
          id: string;
          account_id: string;
          workspace_id: string;
          candidate_id: string;
          revision_id: string;
          stage: string;
          error_category: string;
          error_message: string;
          retry_classification: string;
          attempt_count: number;
          diagnostics: string | Record<string, unknown>;
          resumed: boolean;
          resumed_at: string | null;
          resumed_by: string | null;
          created_at: string;
          updated_at: string;
        }>(queryText, params);

        return res.rows.map((row) => ({
          id: row.id,
          accountId: row.account_id,
          workspaceId: row.workspace_id,
          candidateId: row.candidate_id,
          revisionId: row.revision_id,
          stage: row.stage as CandidateLifecycleDlqRecord["stage"],
          errorCategory: row.error_category as CandidateLifecycleDlqRecord["errorCategory"],
          errorMessage: row.error_message,
          retryClassification:
            row.retry_classification as CandidateLifecycleDlqRecord["retryClassification"],
          attemptCount: row.attempt_count,
          diagnostics:
            typeof row.diagnostics === "string"
              ? JSON.parse(row.diagnostics)
              : row.diagnostics || {},
          resumed: row.resumed,
          resumedAt: row.resumed_at,
          resumedBy: row.resumed_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
      } catch {
        // Memory fallback
      }
    }

    const records: CandidateLifecycleDlqRecord[] = [];
    for (const [key, record] of this.inMemoryDlq.entries()) {
      if (key.startsWith(`${tenant.workspaceId}:`)) {
        if (filter.candidateId && record.candidateId !== filter.candidateId) continue;
        if (filter.stage && record.stage !== filter.stage) continue;
        if (filter.errorCategory && record.errorCategory !== filter.errorCategory) continue;
        if (filter.resumed !== undefined && record.resumed !== filter.resumed) continue;
        records.push(record);
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Marks a DLQ record as resumed with operator audit info.
   */
  async markDlqResumed(
    tenant: TenantContext,
    dlqId: string,
    resumedBy = "operator",
    db?: Queryable,
  ): Promise<CandidateLifecycleDlqRecord | null> {
    this.enforceTenant(tenant);

    const existing = await this.getDlqRecord(tenant, dlqId, db);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated: CandidateLifecycleDlqRecord = {
      ...existing,
      resumed: true,
      resumedAt: now,
      resumedBy,
      updatedAt: now,
    };

    return this.saveDlqRecord(tenant, updated, db);
  }

  /**
   * Deletes a DLQ record.
   */
  async deleteDlqRecord(tenant: TenantContext, dlqId: string, db?: Queryable): Promise<boolean> {
    this.enforceTenant(tenant);

    const client = db ?? this.pool;
    this.inMemoryDlq.delete(this.getDlqCacheKey(tenant, dlqId));

    if (client) {
      try {
        await client.query(
          `DELETE FROM candidate_lifecycle_dlq WHERE workspace_id = $1 AND id = $2;`,
          [tenant.workspaceId, dlqId],
        );
      } catch {
        // Memory fallback
      }
    }

    return true;
  }

  /**
   * Alias for getLifecycle.
   */
  async getLifecycleRecord(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<CandidateLifecycleRecord | null> {
    return this.getLifecycle(tenant, candidateId, db);
  }

  /**
   * Direct lifecycle record persistence helper.
   */
  async saveLifecycleRecord(
    tenant: TenantContext,
    record: CandidateLifecycleRecord,
    db?: Queryable,
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);
    return this.recordTransition(
      tenant,
      record.candidateId,
      {
        revisionId: record.activeRevisionId,
        fromState: record.currentState,
        toState: record.currentState,
        targetVersion: record.targetVersion,
        idempotencyKey: record.idempotencyKey,
        attempt: record.attempt,
        evidenceDigests: record.evidenceDigests,
        terminalReason: record.terminalReason,
        validationResult: record.validationResult,
        replayResult: record.replayResult,
        evaluationResult: record.evaluationResult,
        publicationRecordId: record.publicationRecordId,
        publishedVersion: record.publishedVersion,
        metadata: record.metadata,
      },
      db,
    );
  }
  /**
   * Alias for getTransitions.
   */
  async listTransitions(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<LifecycleTransitionRecord[]> {
    return this.getTransitions(tenant, candidateId, db);
  }
}
