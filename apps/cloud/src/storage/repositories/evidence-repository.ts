import { randomUUID } from "node:crypto";
import { canonicalJsonStringify, hashCanonicalContent } from "@tool-evolver/contracts";
import type { DatabasePool, Queryable } from "../../db/client.js";
import type { TenantContext } from "../../tenant.js";
import type { NormalizedEventEntity } from "../models/events.js";
import type {
  CreateEvidenceSetInput,
  EvidenceMemberEntity,
  EvidenceSetEntity,
  ResolvedEvidenceSet,
} from "../models/evidence.js";
import { ObservationRepository } from "./observation-repository.js";

export class EvidenceRepository {
  private obsRepo: ObservationRepository;

  constructor(private pool: DatabasePool | Queryable) {
    this.obsRepo = new ObservationRepository(this.pool);
  }

  /**
   * Create an immutable EvidenceSet snapshot.
   */
  async createEvidenceSet(
    tenant: TenantContext,
    input: CreateEvidenceSetInput,
    db?: Queryable,
  ): Promise<EvidenceSetEntity> {
    const client = db ?? this.pool;
    const setId = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const description = input.description ?? "";
    const revision = input.revision ?? 1;
    const sessionId = input.sessionId ?? null;
    const metadata = input.metadata ?? {};

    // Fetch and verify all member events exist and belong to the tenant
    const membersData: Array<{ eventId: string; eventDigest: string; sequenceIndex: number }> = [];

    for (let i = 0; i < input.eventIds.length; i++) {
      const eventId = input.eventIds[i];
      const event = await this.obsRepo.getEventById(tenant, eventId, client);
      if (!event) {
        throw new Error(
          `Event with ID '${eventId}' not found for tenant '${tenant.accountId}:${tenant.workspaceId}'`,
        );
      }
      membersData.push({
        eventId: event.id,
        eventDigest: event.contentHash,
        sequenceIndex: i,
      });
    }

    // Compute root digest deterministically across members
    const rootDigest = hashCanonicalContent(
      membersData.map((m) => ({
        eventId: m.eventId,
        eventDigest: m.eventDigest,
        sequenceIndex: m.sequenceIndex,
      })),
      { prefix: false },
    );

    // Insert EvidenceSet
    await client.query(
      `INSERT INTO evidence_sets (
        id, account_id, workspace_id, session_id, name, description,
        revision, root_digest, member_count, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        setId,
        tenant.accountId,
        tenant.workspaceId,
        sessionId,
        input.name,
        description,
        revision,
        rootDigest,
        membersData.length,
        metadata,
        now,
      ],
    );

    // Insert member records
    for (const member of membersData) {
      const memberId = randomUUID();
      await client.query(
        `INSERT INTO evidence_members (
          id, evidence_set_id, account_id, workspace_id,
          event_id, event_digest, sequence_index, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          memberId,
          setId,
          tenant.accountId,
          tenant.workspaceId,
          member.eventId,
          member.eventDigest,
          member.sequenceIndex,
          now,
        ],
      );
    }

    return {
      id: setId,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      sessionId,
      name: input.name,
      description,
      revision,
      rootDigest,
      memberCount: membersData.length,
      metadata,
      createdAt: now,
    };
  }

  /**
   * Retrieve an EvidenceSet by ID.
   */
  async getEvidenceSetById(
    tenant: TenantContext,
    evidenceSetId: string,
    db?: Queryable,
  ): Promise<EvidenceSetEntity | null> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM evidence_sets WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenant.accountId, tenant.workspaceId, evidenceSetId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToEvidenceSet(result.rows[0]);
  }

  /**
   * List EvidenceSets for a tenant.
   */
  async listEvidenceSets(
    tenant: TenantContext,
    filter: { sessionId?: string; limit?: number; offset?: number } = {},
    db?: Queryable,
  ): Promise<EvidenceSetEntity[]> {
    const client = db ?? this.pool;
    const conditions: string[] = ["account_id = $1", "workspace_id = $2"];
    const params: unknown[] = [tenant.accountId, tenant.workspaceId];
    let paramIdx = 3;

    if (filter.sessionId) {
      conditions.push(`session_id = $${paramIdx++}`);
      params.push(filter.sessionId);
    }

    const whereClause = conditions.join(" AND ");
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const querySql = `SELECT * FROM evidence_sets WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    const queryParams = [...params, limit, offset];

    const result = await client.query<Record<string, unknown>>(querySql, queryParams);
    return result.rows.map((row) => this.mapRowToEvidenceSet(row));
  }

  /**
   * Resolve an EvidenceSet with all member records and verify cryptographic digest integrity.
   */
  async resolveEvidenceSet(
    tenant: TenantContext,
    evidenceSetId: string,
    db?: Queryable,
  ): Promise<ResolvedEvidenceSet | null> {
    const client = db ?? this.pool;
    const evidenceSet = await this.getEvidenceSetById(tenant, evidenceSetId, client);
    if (!evidenceSet) {
      return null;
    }

    // Fetch members ordered by sequence_index
    const memberRows = await client.query<Record<string, unknown>>(
      `SELECT * FROM evidence_members WHERE account_id = $1 AND workspace_id = $2 AND evidence_set_id = $3 ORDER BY sequence_index ASC`,
      [tenant.accountId, tenant.workspaceId, evidenceSetId],
    );
    const members: EvidenceMemberEntity[] = memberRows.rows.map((r) => ({
      id: String(r.id),
      evidenceSetId: String(r.evidence_set_id),
      accountId: String(r.account_id),
      workspaceId: String(r.workspace_id),
      eventId: String(r.event_id),
      eventDigest: String(r.event_digest),
      sequenceIndex: Number(r.sequence_index),
      createdAt: String(r.created_at),
    }));

    // Fetch all events
    const events: NormalizedEventEntity[] = [];
    let isDigestValid = true;

    for (const m of members) {
      const evt = await this.obsRepo.getEventById(tenant, m.eventId, client);
      if (!evt || evt.contentHash !== m.eventDigest) {
        isDigestValid = false;
      }
      if (evt) {
        events.push(evt);
      }
    }

    // Verify root digest
    const recomputedRootDigest = hashCanonicalContent(
      members.map((m) => ({
        eventId: m.eventId,
        eventDigest: m.eventDigest,
        sequenceIndex: m.sequenceIndex,
      })),
      { prefix: false },
    );

    if (recomputedRootDigest !== evidenceSet.rootDigest) {
      isDigestValid = false;
    }

    return {
      evidenceSet,
      members,
      events,
      isDigestValid,
    };
  }

  /**
   * Map row to EvidenceSetEntity.
   */
  private mapRowToEvidenceSet(row: Record<string, unknown>): EvidenceSetEntity {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      sessionId: row.session_id ? String(row.session_id) : null,
      name: String(row.name),
      description: String(row.description ?? ""),
      revision: Number(row.revision ?? 1),
      rootDigest: String(row.root_digest),
      memberCount: Number(row.member_count ?? 0),
      metadata: (typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : (row.metadata ?? {})) as Record<string, unknown>,
      createdAt: String(row.created_at),
    };
  }
}
