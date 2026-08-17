import { DatabasePool, Queryable } from "../../db/client.js";
import { TenantContext } from "../../tenant.js";
import { NormalizedEventEntity } from "../models/events.js";
import {
  SessionBranchEntity,
  SessionEntity,
  SessionFidelity,
  SessionQueryFilter,
  SessionStatus,
  SessionSummary,
} from "../models/sessions.js";

export class SessionRepository {
  constructor(private pool: DatabasePool | Queryable) {}

  /**
   * Create a new session record.
   */
  async createSession(
    tenant: TenantContext,
    input: {
      id: string;
      harnessType?: string;
      status?: SessionStatus;
      fidelity?: SessionFidelity;
      startedAt?: string;
      endedAt?: string | null;
      cursor?: string | null;
      metadata?: Record<string, unknown>;
    },
    db?: Queryable,
  ): Promise<SessionEntity> {
    const client = db ?? this.pool;
    const now = new Date().toISOString();
    const harnessType = input.harnessType ?? "default";
    const status = input.status ?? "active";
    const fidelity = input.fidelity ?? "full";
    const startedAt = input.startedAt ?? now;
    const endedAt = input.endedAt ?? null;
    const cursor = input.cursor ?? null;
    const metadata = input.metadata ?? {};

    // Idempotent check
    const existing = await this.getSessionById(tenant, input.id, client);
    if (existing) {
      return existing;
    }

    await client.query(
      `INSERT INTO sessions (
        id, account_id, workspace_id, harness_type, status, fidelity,
        started_at, ended_at, cursor, event_count, summary_by_kind,
        metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        input.id,
        tenant.accountId,
        tenant.workspaceId,
        harnessType,
        status,
        fidelity,
        startedAt,
        endedAt,
        cursor,
        0,
        {},
        metadata,
        now,
        now,
      ],
    );

    return {
      id: input.id,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      harnessType,
      status,
      fidelity,
      startedAt,
      endedAt,
      cursor,
      eventCount: 0,
      summaryByKind: {},
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Retrieve a session by ID enforcing tenant isolation.
   */
  async getSessionById(
    tenant: TenantContext,
    sessionId: string,
    db?: Queryable,
  ): Promise<SessionEntity | null> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM sessions WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenant.accountId, tenant.workspaceId, sessionId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToSession(result.rows[0]);
  }

  /**
   * Get an existing session or create a new active session record.
   */
  async getOrCreateSession(
    tenant: TenantContext,
    sessionId: string,
    harnessType = "default",
    db?: Queryable,
  ): Promise<SessionEntity> {
    const client = db ?? this.pool;
    const existing = await this.getSessionById(tenant, sessionId, client);
    if (existing) {
      return existing;
    }
    return this.createSession(tenant, { id: sessionId, harnessType }, client);
  }

  /**
   * List sessions matching query filters.
   */
  async listSessions(
    filter: SessionQueryFilter,
    db?: Queryable,
  ): Promise<SessionEntity[]> {
    const client = db ?? this.pool;
    const conditions: string[] = [
      "account_id = $1",
      "workspace_id = $2",
    ];
    const params: unknown[] = [filter.accountId, filter.workspaceId];
    let paramIdx = 3;

    if (filter.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filter.status);
    }

    if (filter.harnessType) {
      conditions.push(`harness_type = $${paramIdx++}`);
      params.push(filter.harnessType);
    }

    if (filter.startedAfter) {
      conditions.push(`started_at >= $${paramIdx++}`);
      params.push(filter.startedAfter);
    }

    if (filter.startedBefore) {
      conditions.push(`started_at <= $${paramIdx++}`);
      params.push(filter.startedBefore);
    }

    const whereClause = conditions.join(" AND ");
    const sortOrder = filter.sortOrder ?? "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const querySql = `SELECT * FROM sessions WHERE ${whereClause} ORDER BY started_at ${sortOrder} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    const queryParams = [...params, limit, offset];

    const result = await client.query<Record<string, unknown>>(querySql, queryParams);
    return result.rows.map((row) => this.mapRowToSession(row));
  }

  /**
   * Update session status (e.g. completed, failed, active).
   */
  async updateSessionStatus(
    tenant: TenantContext,
    sessionId: string,
    status: SessionStatus,
    endedAt?: string | null,
    db?: Queryable,
  ): Promise<void> {
    const client = db ?? this.pool;
    const now = new Date().toISOString();
    const finalEndedAt = endedAt !== undefined ? endedAt : (status === "completed" || status === "failed" ? now : null);

    await client.query(
      `UPDATE sessions SET status = $1, ended_at = $2, updated_at = $3 WHERE account_id = $4 AND workspace_id = $5 AND id = $6`,
      [status, finalEndedAt, now, tenant.accountId, tenant.workspaceId, sessionId],
    );
  }

  /**
   * Materialize newly ingested events into the session's summary:
   * event counts by kind, total count, latest cursor, and timestamps.
   */
  async recordSessionEventsMaterialized(
    tenant: TenantContext,
    sessionId: string,
    events: NormalizedEventEntity[],
    db?: Queryable,
  ): Promise<SessionEntity> {
    const client = db ?? this.pool;
    const session = await this.getOrCreateSession(tenant, sessionId, "default", client);
    if (events.length === 0) {
      return session;
    }

    const now = new Date().toISOString();
    const updatedSummary: Record<string, number> = { ...session.summaryByKind };

    let maxSequence = 0;
    let latestTimestamp = session.startedAt;
    let earliestTimestamp = session.startedAt;

    for (const evt of events) {
      const type = evt.eventType;
      updatedSummary[type] = (updatedSummary[type] ?? 0) + 1;

      if (evt.causalSequence > maxSequence) {
        maxSequence = evt.causalSequence;
      }
      if (new Date(evt.timestamp).getTime() > new Date(latestTimestamp).getTime()) {
        latestTimestamp = evt.timestamp;
      }
      if (new Date(evt.timestamp).getTime() < new Date(earliestTimestamp).getTime()) {
        earliestTimestamp = evt.timestamp;
      }
    }

    const newEventCount = session.eventCount + events.length;
    const newCursor = String(maxSequence > 0 ? maxSequence : latestTimestamp);

    await client.query(
      `UPDATE sessions SET
        event_count = $1,
        summary_by_kind = $2,
        cursor = $3,
        started_at = $4,
        updated_at = $5
      WHERE account_id = $6 AND workspace_id = $7 AND id = $8`,
      [
        newEventCount,
        updatedSummary,
        newCursor,
        earliestTimestamp,
        now,
        tenant.accountId,
        tenant.workspaceId,
        sessionId,
      ],
    );

    return {
      ...session,
      eventCount: newEventCount,
      summaryByKind: updatedSummary,
      cursor: newCursor,
      startedAt: earliestTimestamp,
      updatedAt: now,
    };
  }

  /**
   * Create a session branch.
   */
  async createBranch(
    tenant: TenantContext,
    branch: {
      id: string;
      sessionId: string;
      name: string;
      parentBranchId?: string | null;
      forkEventId?: string | null;
      metadata?: Record<string, unknown>;
    },
    db?: Queryable,
  ): Promise<SessionBranchEntity> {
    const client = db ?? this.pool;
    const now = new Date().toISOString();
    const parentBranchId = branch.parentBranchId ?? null;
    const forkEventId = branch.forkEventId ?? null;
    const metadata = branch.metadata ?? {};

    const existing = await this.getBranchById(tenant, branch.id, client);
    if (existing) {
      return existing;
    }

    await client.query(
      `INSERT INTO session_branches (
        id, session_id, account_id, workspace_id, name,
        parent_branch_id, fork_event_id, head_event_id, event_count,
        metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        branch.id,
        branch.sessionId,
        tenant.accountId,
        tenant.workspaceId,
        branch.name,
        parentBranchId,
        forkEventId,
        forkEventId,
        0,
        metadata,
        now,
        now,
      ],
    );

    return {
      id: branch.id,
      sessionId: branch.sessionId,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      name: branch.name,
      parentBranchId,
      forkEventId,
      headEventId: forkEventId,
      eventCount: 0,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Retrieve branch by ID.
   */
  async getBranchById(
    tenant: TenantContext,
    branchId: string,
    db?: Queryable,
  ): Promise<SessionBranchEntity | null> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM session_branches WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenant.accountId, tenant.workspaceId, branchId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToBranch(result.rows[0]);
  }

  /**
   * List all branches for a given session.
   */
  async listBranches(
    tenant: TenantContext,
    sessionId: string,
    db?: Queryable,
  ): Promise<SessionBranchEntity[]> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM session_branches WHERE account_id = $1 AND workspace_id = $2 AND session_id = $3 ORDER BY created_at ASC`,
      [tenant.accountId, tenant.workspaceId, sessionId],
    );
    return result.rows.map((row) => this.mapRowToBranch(row));
  }

  /**
   * Get aggregated summary overview of a session.
   */
  async getSessionSummary(
    tenant: TenantContext,
    sessionId: string,
    db?: Queryable,
  ): Promise<SessionSummary | null> {
    const client = db ?? this.pool;
    const session = await this.getSessionById(tenant, sessionId, client);
    if (!session) {
      return null;
    }

    const branches = await this.listBranches(tenant, sessionId, client);

    return {
      sessionId: session.id,
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      status: session.status,
      fidelity: session.fidelity,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      cursor: session.cursor,
      eventCount: session.eventCount,
      summaryByKind: session.summaryByKind,
      branchCount: branches.length,
    };
  }

  /**
   * Map row to SessionEntity.
   */
  private mapRowToSession(row: Record<string, unknown>): SessionEntity {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      harnessType: String(row.harness_type ?? "default"),
      status: String(row.status) as SessionStatus,
      fidelity: String(row.fidelity ?? "full") as SessionFidelity,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : null,
      cursor: row.cursor ? String(row.cursor) : null,
      eventCount: Number(row.event_count ?? 0),
      summaryByKind: (typeof row.summary_by_kind === "string"
        ? JSON.parse(row.summary_by_kind)
        : row.summary_by_kind ?? {}) as Record<string, number>,
      metadata: (typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata ?? {}) as Record<string, unknown>,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Map row to SessionBranchEntity.
   */
  private mapRowToBranch(row: Record<string, unknown>): SessionBranchEntity {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      parentBranchId: row.parent_branch_id ? String(row.parent_branch_id) : null,
      forkEventId: row.fork_event_id ? String(row.fork_event_id) : null,
      headEventId: row.head_event_id ? String(row.head_event_id) : null,
      eventCount: Number(row.event_count ?? 0),
      metadata: (typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata ?? {}) as Record<string, unknown>,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
