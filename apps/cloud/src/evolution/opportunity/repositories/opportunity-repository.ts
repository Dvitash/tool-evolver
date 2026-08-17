import type { CandidateTriggerReason } from "@tool-evolver/contracts";
import type { DatabasePool, Queryable } from "../../../db/client.js";
import { OutboxRepository } from "../../../db/outbox.js";
import { type TenantContext, TenantGuard } from "../../../tenant.js";
import type {
  CoverageResult,
  OpportunityClassification,
  OpportunityDetection,
  OpportunityDetectionStatus,
  OpportunityFilter,
  SuppressionReason,
  SuppressionResult,
} from "../types.js";

/**
 * Maps a raw database row to an OpportunityDetection domain object.
 */
export function mapRowToOpportunity(row: Record<string, unknown>): OpportunityDetection {
  const metrics =
    typeof row.metrics === "string"
      ? JSON.parse(row.metrics)
      : (row.metrics as Record<string, unknown>) || {};

  const classification =
    typeof row.classification === "string"
      ? (JSON.parse(row.classification) as OpportunityClassification)
      : (row.classification as OpportunityClassification) || {
          title: "Unknown Opportunity",
          description: "",
          taskClass: "general",
          pattern: "",
          confidenceScore: 0.5,
          priority: "medium",
        };

  const evidenceEventIds =
    typeof row.evidence_event_ids === "string"
      ? (JSON.parse(row.evidence_event_ids) as string[])
      : (row.evidence_event_ids as string[]) || [];

  const status = (row.status as OpportunityDetectionStatus) || "eligible";

  let suppression: SuppressionResult;
  if (row.suppression_reason) {
    if (typeof row.suppression_reason === "string" && row.suppression_reason.startsWith("{")) {
      try {
        suppression = JSON.parse(row.suppression_reason) as SuppressionResult;
      } catch {
        suppression = {
          suppressed: status === "suppressed" || row.suppression_reason !== "none",
          reason: row.suppression_reason as SuppressionReason,
          details: `Suppressed: ${row.suppression_reason}`,
        };
      }
    } else if (typeof row.suppression_reason === "object") {
      suppression = row.suppression_reason as SuppressionResult;
    } else {
      suppression = {
        suppressed: status === "suppressed" || row.suppression_reason !== "none",
        reason: row.suppression_reason as SuppressionReason,
        details: `Suppressed: ${row.suppression_reason}`,
      };
    }
  } else {
    suppression = {
      suppressed: status === "suppressed",
      reason: "none",
      details: "",
    };
  }

  let coverage: CoverageResult;
  if (row.coverage_decision) {
    if (typeof row.coverage_decision === "string" && row.coverage_decision.startsWith("{")) {
      try {
        coverage = JSON.parse(row.coverage_decision) as CoverageResult;
      } catch {
        coverage = {
          status:
            (row.coverage_decision as CoverageResult["status"]) ||
            (status === "covered" ? "covered" : status === "duplicate" ? "duplicate" : "net_new"),
          reason: String(row.coverage_decision),
          similarityScore: 0,
          overlapRatio: 0,
        };
      }
    } else if (typeof row.coverage_decision === "object") {
      coverage = row.coverage_decision as CoverageResult;
    } else {
      coverage = {
        status:
          (row.coverage_decision as CoverageResult["status"]) ||
          (status === "covered" ? "covered" : status === "duplicate" ? "duplicate" : "net_new"),
        reason: String(row.coverage_decision),
        similarityScore: 0,
        overlapRatio: 0,
      };
    }
  } else {
    coverage = {
      status: status === "covered" ? "covered" : status === "duplicate" ? "duplicate" : "net_new",
      reason: "",
      similarityScore: 0,
      overlapRatio: 0,
    };
  }

  const createdAt =
    typeof row.created_at === "string"
      ? row.created_at
      : ((row.created_at as Date)?.toISOString?.() ?? new Date().toISOString());

  const updatedAt =
    typeof row.updated_at === "string"
      ? row.updated_at
      : ((row.updated_at as Date)?.toISOString?.() ?? new Date().toISOString());

  return {
    id: row.id as string,
    accountId: row.account_id as string,
    workspaceId: row.workspace_id as string,
    clusterId: row.cluster_id as string,
    structuralHash: row.structural_hash as string,
    idempotencyKey: (row.idempotency_key as string) || (row.id as string),
    status,
    triggerType:
      (row.trigger_type as "normal_frequency" | "exceptional_waste") || "normal_frequency",
    triggerReason: (row.trigger_reason as CandidateTriggerReason) || "frequency_threshold_met",
    occurrenceCount: Number(row.occurrence_count ?? 1),
    distinctSessionCount: Number(row.distinct_session_count ?? 1),
    evidenceEventIds,
    coverage,
    suppression,
    classification,
    metrics: {
      totalDurationMs: Number(metrics.totalDurationMs ?? 0),
      avgDurationMs: Number(metrics.avgDurationMs ?? 0),
      totalTokens: Number(metrics.totalTokens ?? 0),
      totalRetries: Number(metrics.totalRetries ?? 0),
      totalCostUsd: Number(metrics.totalCostUsd ?? 0),
    },
    createdAt,
    updatedAt,
  };
}

/**
 * PostgreSQL repository for opportunity persistence, lineage tracking, and transactional candidate job outbox publication.
 */
export class OpportunityRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Persists an opportunity detection entity transactionally.
   * If eligible, newly detected, and possessing valid evidence, an atomic outbox event
   * for candidate.generate is written within the same database transaction.
   *
   * Idempotent: duplicate submissions return the existing immutable record without overwriting.
   */
  async saveOpportunity(
    tenant: TenantContext,
    opportunity: OpportunityDetection,
    db?: Queryable,
  ): Promise<OpportunityDetection> {
    TenantGuard.assertAccess(
      { accountId: opportunity.accountId, workspaceId: opportunity.workspaceId },
      tenant,
    );

    const executeInTransaction = async (client: Queryable): Promise<OpportunityDetection> => {
      const idempotencyKey = opportunity.idempotencyKey || opportunity.id;

      // 1. Check if opportunity already exists by (account_id, workspace_id, id) or (workspace_id, idempotency_key)
      const existingRes = await client.query(
        `SELECT * FROM opportunities WHERE account_id = $1 AND workspace_id = $2 AND (id = $3 OR idempotency_key = $4) LIMIT 1`,
        [tenant.accountId, tenant.workspaceId, opportunity.id, idempotencyKey],
      );

      if (existingRes.rows.length > 0) {
        // Return existing opportunity - deterministic fields are immutable
        return mapRowToOpportunity(existingRes.rows[0]);
      }

      const now = new Date().toISOString();
      const createdAt = opportunity.createdAt || now;
      const updatedAt = opportunity.updatedAt || now;

      // 2. Insert opportunity record
      const insertSql = `
        INSERT INTO opportunities (
          id, account_id, workspace_id, cluster_id, structural_hash, idempotency_key,
          status, trigger_type, trigger_reason, occurrence_count, distinct_session_count,
          evidence_event_ids, metrics, classification, suppression_reason, coverage_decision,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
        )
        ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
        RETURNING *;
      `;

      const suppressionReason = opportunity.suppression
        ? JSON.stringify(opportunity.suppression)
        : null;

      const coverageDecision = opportunity.coverage ? JSON.stringify(opportunity.coverage) : null;

      const insertParams = [
        opportunity.id,
        opportunity.accountId,
        opportunity.workspaceId,
        opportunity.clusterId,
        opportunity.structuralHash,
        idempotencyKey,
        opportunity.status,
        opportunity.triggerType,
        opportunity.triggerReason,
        opportunity.occurrenceCount,
        opportunity.distinctSessionCount,
        JSON.stringify(opportunity.evidenceEventIds || []),
        JSON.stringify(opportunity.metrics || {}),
        JSON.stringify(opportunity.classification || null),
        suppressionReason,
        coverageDecision,
        createdAt,
        updatedAt,
      ];

      const inserted = await client.query(insertSql, insertParams);

      let saved: OpportunityDetection;
      let isNewlyCreated = false;

      if (inserted.rows.length > 0) {
        saved = mapRowToOpportunity(inserted.rows[0]);
        isNewlyCreated = true;
      } else {
        // Conflict on insert - fetch the winning record
        const conflictRes = await client.query(
          `SELECT * FROM opportunities WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [opportunity.workspaceId, idempotencyKey],
        );
        if (conflictRes.rows.length > 0) {
          saved = mapRowToOpportunity(conflictRes.rows[0]);
          isNewlyCreated = false;
        } else {
          saved = { ...opportunity, idempotencyKey, createdAt, updatedAt };
          isNewlyCreated = true;
        }
      }

      // 3. Atomically enqueue candidate generation in Outbox if eligible, newly created, and has evidence
      const hasEvidence = saved.evidenceEventIds && saved.evidenceEventIds.length > 0;
      if (isNewlyCreated && saved.status === "eligible" && hasEvidence) {
        await OutboxRepository.insert(client, {
          accountId: saved.accountId,
          workspaceId: saved.workspaceId,
          aggregateType: "opportunity",
          aggregateId: saved.id,
          eventType: "candidate.generate",
          payload: {
            opportunityId: saved.id,
            workspaceId: saved.workspaceId,
            accountId: saved.accountId,
            clusterId: saved.clusterId,
            structuralHash: saved.structuralHash,
            triggerType: saved.triggerType,
            triggerReason: saved.triggerReason,
            classification: saved.classification,
            metrics: saved.metrics,
            createdAt: saved.createdAt,
          },
          headers: {
            correlationId: saved.id,
            idempotencyKey,
          },
        });
      }

      return saved;
    };

    if (db) {
      return executeInTransaction(db);
    }
    return this.pool.transaction(executeInTransaction);
  }

  /**
   * Persists multiple opportunities transactionally.
   */
  async saveOpportunities(
    tenant: TenantContext,
    opportunities: OpportunityDetection[],
    db?: Queryable,
  ): Promise<OpportunityDetection[]> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );
    const client = db ?? this.pool;

    const results: OpportunityDetection[] = [];
    for (const opp of opportunities) {
      const saved = await this.saveOpportunity(tenant, opp, client);
      results.push(saved);
    }
    return results;
  }

  /**
   * Retrieves a single OpportunityDetection by ID with tenant isolation.
   */
  async getOpportunityById(
    tenant: TenantContext,
    opportunityId: string,
    db?: Queryable,
  ): Promise<OpportunityDetection | null> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );
    const client = db ?? this.pool;

    const res = await client.query(
      `SELECT * FROM opportunities WHERE id = $1 AND account_id = $2 AND workspace_id = $3 LIMIT 1`,
      [opportunityId, tenant.accountId, tenant.workspaceId],
    );

    if (res.rows.length === 0) return null;
    return mapRowToOpportunity(res.rows[0]);
  }

  /**
   * Lists detected opportunities matching filter criteria for a tenant.
   */
  async listOpportunities(
    tenant: TenantContext,
    filter: OpportunityFilter = {},
    db?: Queryable,
  ): Promise<OpportunityDetection[]> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );
    const client = db ?? this.pool;

    let query = `SELECT * FROM opportunities WHERE account_id = $1 AND workspace_id = $2`;
    const params: unknown[] = [tenant.accountId, tenant.workspaceId];
    let paramIdx = 3;

    if (filter.status) {
      query += ` AND status = $${paramIdx++}`;
      params.push(filter.status);
    }
    if (filter.structuralHash) {
      query += ` AND structural_hash = $${paramIdx++}`;
      params.push(filter.structuralHash);
    }
    if (filter.triggerType) {
      query += ` AND trigger_type = $${paramIdx++}`;
      params.push(filter.triggerType);
    }

    query += ` ORDER BY created_at DESC`;

    if (filter.limit) {
      query += ` LIMIT $${paramIdx++}`;
      params.push(filter.limit);
    }

    const res = await client.query(query, params);
    return res.rows.map(mapRowToOpportunity);
  }

  /**
   * Retrieves recent opportunity structural hashes detected since a given timestamp for cooldown evaluation.
   */
  async getRecentOpportunityHashes(
    tenant: TenantContext,
    since: Date | string | number,
    db?: Queryable,
  ): Promise<Map<string, number>> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );
    const client = db ?? this.pool;
    const sinceDate =
      since instanceof Date
        ? since.toISOString()
        : typeof since === "number"
          ? new Date(since).toISOString()
          : since;

    const res = await client.query<{
      structural_hash: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `SELECT structural_hash, created_at, updated_at
       FROM opportunities
       WHERE account_id = $1 AND workspace_id = $2 AND created_at >= $3`,
      [tenant.accountId, tenant.workspaceId, sinceDate],
    );

    const map = new Map<string, number>();
    for (const row of res.rows) {
      const ts =
        typeof row.created_at === "string"
          ? Date.parse(row.created_at)
          : (row.created_at as Date).getTime();
      const existing = map.get(row.structural_hash);
      if (!existing || ts > existing) {
        map.set(row.structural_hash, ts);
      }
    }
    return map;
  }

  /**
   * Deletes an opportunity by ID (useful for tenant data cleanup or test isolation).
   */
  async deleteOpportunity(
    tenant: TenantContext,
    opportunityId: string,
    db?: Queryable,
  ): Promise<boolean> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );
    const client = db ?? this.pool;

    const res = await client.query(
      `DELETE FROM opportunities WHERE id = $1 AND account_id = $2 AND workspace_id = $3`,
      [opportunityId, tenant.accountId, tenant.workspaceId],
    );

    return res.rowCount > 0;
  }
}
