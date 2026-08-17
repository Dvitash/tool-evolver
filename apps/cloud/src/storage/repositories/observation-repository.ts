import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  canonicalJsonStringify,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import type { DatabasePool, Queryable } from "../../db/client.js";
import type { TenantContext } from "../../tenant.js";
import type {
  EventQueryFilter,
  NormalizedEventEntity,
  PaginatedEventsResult,
} from "../models/events.js";

export class ObservationRepository {
  constructor(private pool: DatabasePool | Queryable) {}

  /**
   * Insert a normalized event into the store.
   * If an event with the same ID already exists, this operation is idempotent.
   */
  async insertEvent(
    tenant: TenantContext,
    event: NormalizedSessionEvent | NormalizedEventEntity,
    db?: Queryable,
  ): Promise<NormalizedEventEntity> {
    const client = db ?? this.pool;

    const eventId = "id" in event && event.id ? event.id : (event as { eventId: string }).eventId;
    const sessionId = "sessionId" in event ? event.sessionId : "";
    const branchId = "branchId" in event && event.branchId ? event.branchId : "main";
    const eventType =
      "type" in event
        ? (event as { type: string }).type
        : (event as { eventType: string }).eventType;
    const schemaVersion =
      "schemaVersion" in event && event.schemaVersion ? event.schemaVersion : "1.0.0";
    const timestamp = "timestamp" in event ? event.timestamp : new Date().toISOString();

    const causalRef = "causalRef" in event ? event.causalRef : undefined;
    const causalSequence =
      "causalSequence" in event && event.causalSequence !== undefined
        ? Number(event.causalSequence)
        : (causalRef?.causalSequence ?? 0);
    const parentId = "parentId" in event ? event.parentId : (causalRef?.parentId ?? null);
    const rootId = "rootId" in event ? event.rootId : (causalRef?.rootId ?? null);
    const turnIndex = "turnIndex" in event ? event.turnIndex : (causalRef?.turnIndex ?? null);
    const stepIndex = "stepIndex" in event ? event.stepIndex : (causalRef?.stepIndex ?? null);
    const traceId =
      "traceId" in event ? event.traceId : (causalRef?.traceId ?? tenant.traceId ?? null);
    const spanId = "spanId" in event ? event.spanId : (causalRef?.spanId ?? null);

    const redaction = "redaction" in event ? event.redaction : null;

    let payload: Record<string, unknown> = {};
    if ("payload" in event && event.payload && typeof event.payload === "object") {
      payload = event.payload as Record<string, unknown>;
    } else {
      payload = { ...(event as Record<string, unknown>) };
    }

    const contentHash =
      "contentHash" in event && event.contentHash
        ? event.contentHash
        : hashCanonicalContent(event, { prefix: false });

    const createdAt =
      "createdAt" in event && event.createdAt ? event.createdAt : new Date().toISOString();

    // Check if event already exists for idempotency
    const existing = await this.getEventById(tenant, eventId, client);
    if (existing) {
      return existing;
    }

    await client.query(
      `INSERT INTO normalized_events (
        id, account_id, workspace_id, session_id, branch_id,
        event_type, schema_version, timestamp, causal_sequence,
        parent_id, root_id, turn_index, step_index, trace_id, span_id,
        payload, redaction, content_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        eventId,
        tenant.accountId,
        tenant.workspaceId,
        sessionId,
        branchId,
        eventType,
        schemaVersion,
        timestamp,
        causalSequence,
        parentId,
        rootId,
        turnIndex,
        stepIndex,
        traceId,
        spanId,
        payload,
        redaction,
        contentHash,
        createdAt,
      ],
    );

    return {
      id: eventId,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      sessionId,
      branchId,
      eventType,
      schemaVersion,
      timestamp,
      causalSequence,
      parentId,
      rootId,
      turnIndex,
      stepIndex,
      traceId,
      spanId,
      payload,
      redaction,
      contentHash,
      createdAt,
    };
  }

  /**
   * Insert a batch of events idempotently with deterministic causal sequencing.
   */
  async insertEventsBatch(
    tenant: TenantContext,
    events: Array<NormalizedSessionEvent | NormalizedEventEntity>,
    db?: Queryable,
  ): Promise<NormalizedEventEntity[]> {
    const result = await this.insertEventsBatchWithStatus(tenant, events, db);
    return result.all;
  }

  /**
   * Insert a batch of events idempotently returning all and newly inserted entities.
   */
  async insertEventsBatchWithStatus(
    tenant: TenantContext,
    events: Array<NormalizedSessionEvent | NormalizedEventEntity>,
    db?: Queryable,
  ): Promise<{ all: NormalizedEventEntity[]; newlyInserted: NormalizedEventEntity[] }> {
    const client = db ?? this.pool;
    const all: NormalizedEventEntity[] = [];
    const newlyInserted: NormalizedEventEntity[] = [];

    // Sort batch by timestamp and causal sequence to preserve causal lineage
    const sorted = [...events].sort((a, b) => {
      const seqA =
        "causalSequence" in a && a.causalSequence !== undefined
          ? Number(a.causalSequence)
          : ((a as NormalizedSessionEvent).causalRef?.causalSequence ?? 0);
      const seqB =
        "causalSequence" in b && b.causalSequence !== undefined
          ? Number(b.causalSequence)
          : ((b as NormalizedSessionEvent).causalRef?.causalSequence ?? 0);
      if (seqA !== seqB) return seqA - seqB;
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeA - timeB;
    });

    for (const evt of sorted) {
      const eventId = "id" in evt && evt.id ? evt.id : (evt as { eventId: string }).eventId;
      const existing = await this.getEventById(tenant, eventId, client);
      if (existing) {
        all.push(existing);
      } else {
        const stored = await this.insertEvent(tenant, evt, client);
        all.push(stored);
        newlyInserted.push(stored);
      }
    }

    return { all, newlyInserted };
  }

  /**
   * Retrieve a normalized event by ID enforcing tenant isolation.
   */
  async getEventById(
    tenant: TenantContext,
    eventId: string,
    db?: Queryable,
  ): Promise<NormalizedEventEntity | null> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM normalized_events WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenant.accountId, tenant.workspaceId, eventId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToEntity(result.rows[0]);
  }

  /**
   * Query normalized events with filtering, causal ordering, and deterministic pagination.
   */
  async queryEvents(filter: EventQueryFilter, db?: Queryable): Promise<PaginatedEventsResult> {
    const client = db ?? this.pool;
    const conditions: string[] = ["account_id = $1", "workspace_id = $2"];
    const params: unknown[] = [filter.accountId, filter.workspaceId];
    let paramIdx = 3;

    if (filter.sessionId) {
      conditions.push(`session_id = $${paramIdx++}`);
      params.push(filter.sessionId);
    }

    if (filter.branchId) {
      conditions.push(`branch_id = $${paramIdx++}`);
      params.push(filter.branchId);
    }

    if (filter.eventKind) {
      conditions.push(`event_type = $${paramIdx++}`);
      params.push(filter.eventKind);
    } else if (filter.eventTypes && filter.eventTypes.length > 0) {
      const placeholders = filter.eventTypes.map(() => `$${paramIdx++}`).join(", ");
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...filter.eventTypes);
    }

    if (filter.timeRange?.start) {
      conditions.push(`timestamp >= $${paramIdx++}`);
      params.push(filter.timeRange.start);
    }

    if (filter.timeRange?.end) {
      conditions.push(`timestamp <= $${paramIdx++}`);
      params.push(filter.timeRange.end);
    }

    if (filter.causalSequenceRange?.min !== undefined) {
      conditions.push(`causal_sequence >= $${paramIdx++}`);
      params.push(filter.causalSequenceRange.min);
    }

    if (filter.causalSequenceRange?.max !== undefined) {
      conditions.push(`causal_sequence <= $${paramIdx++}`);
      params.push(filter.causalSequenceRange.max);
    }

    if (filter.afterSequence !== undefined) {
      conditions.push(`causal_sequence > $${paramIdx++}`);
      params.push(filter.afterSequence);
    }

    if (filter.afterTimestamp) {
      conditions.push(`timestamp > $${paramIdx++}`);
      params.push(filter.afterTimestamp);
    }

    if (filter.parentId !== undefined) {
      if (filter.parentId === null) {
        conditions.push(`parent_id IS NULL`);
      } else {
        conditions.push(`parent_id = $${paramIdx++}`);
        params.push(filter.parentId);
      }
    }

    if (filter.rootId !== undefined) {
      if (filter.rootId === null) {
        conditions.push(`root_id IS NULL`);
      } else {
        conditions.push(`root_id = $${paramIdx++}`);
        params.push(filter.rootId);
      }
    }

    if (filter.turnIndex !== undefined) {
      conditions.push(`turn_index = $${paramIdx++}`);
      params.push(filter.turnIndex);
    }

    if (filter.stepIndex !== undefined) {
      conditions.push(`step_index = $${paramIdx++}`);
      params.push(filter.stepIndex);
    }

    if (filter.traceId) {
      conditions.push(`trace_id = $${paramIdx++}`);
      params.push(filter.traceId);
    }

    const whereClause = conditions.join(" AND ");
    const sortOrder = filter.sortOrder ?? "ASC";

    // Count total matching records
    const countSql = `SELECT COUNT(*) AS count FROM normalized_events WHERE ${whereClause}`;
    const countRes = await client.query<{ count: number | string }>(countSql, params);
    const totalCount = Number(countRes.rows[0]?.count ?? 0);

    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);

    const querySql = `SELECT * FROM normalized_events WHERE ${whereClause} ORDER BY causal_sequence ${sortOrder}, timestamp ${sortOrder} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    const queryParams = [...params, limit, offset];

    const result = await client.query<Record<string, unknown>>(querySql, queryParams);
    const events = result.rows.map((row) => this.mapRowToEntity(row));
    const hasMore = offset + events.length < totalCount;
    const nextCursor =
      hasMore && events.length > 0 ? String(events[events.length - 1].causalSequence) : null;

    return {
      events,
      totalCount,
      hasMore,
      nextCursor,
    };
  }

  /**
   * Fetch causal neighborhood around a given event (ancestors, descendants, or siblings).
   */
  async getCausalNeighborhood(
    tenant: TenantContext,
    eventId: string,
    options: { depth?: number; direction?: "ancestors" | "descendants" | "both" } = {},
    db?: Queryable,
  ): Promise<NormalizedEventEntity[]> {
    const client = db ?? this.pool;
    const target = await this.getEventById(tenant, eventId, client);
    if (!target) return [];

    const direction = options.direction ?? "both";
    const depth = options.depth ?? 3;
    const results = new Map<string, NormalizedEventEntity>();
    results.set(target.id, target);

    let currentLevel = [target];
    for (let i = 0; i < depth; i++) {
      if (currentLevel.length === 0) break;
      const nextLevel: NormalizedEventEntity[] = [];

      for (const curr of currentLevel) {
        // Find parent / ancestor
        if ((direction === "ancestors" || direction === "both") && curr.parentId) {
          if (!results.has(curr.parentId)) {
            const parent = await this.getEventById(tenant, curr.parentId, client);
            if (parent) {
              results.set(parent.id, parent);
              nextLevel.push(parent);
            }
          }
        }

        // Find children / descendants
        if (direction === "descendants" || direction === "both") {
          const childrenRes = await client.query<Record<string, unknown>>(
            `SELECT * FROM normalized_events WHERE account_id = $1 AND workspace_id = $2 AND session_id = $3 AND parent_id = $4`,
            [tenant.accountId, tenant.workspaceId, curr.sessionId, curr.id],
          );
          for (const row of childrenRes.rows) {
            const child = this.mapRowToEntity(row);
            if (!results.has(child.id)) {
              results.set(child.id, child);
              nextLevel.push(child);
            }
          }
        }
      }

      currentLevel = nextLevel;
    }

    return Array.from(results.values()).sort((a, b) => a.causalSequence - b.causalSequence);
  }

  /**
   * Map database row record to NormalizedEventEntity.
   */
  private mapRowToEntity(row: Record<string, unknown>): NormalizedEventEntity {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      branchId: String(row.branch_id ?? "main"),
      eventType: String(row.event_type),
      schemaVersion: String(row.schema_version ?? "1.0.0"),
      timestamp: String(row.timestamp),
      causalSequence: Number(row.causal_sequence ?? 0),
      parentId: row.parent_id ? String(row.parent_id) : null,
      rootId: row.root_id ? String(row.root_id) : null,
      turnIndex:
        row.turn_index !== undefined && row.turn_index !== null ? Number(row.turn_index) : null,
      stepIndex:
        row.step_index !== undefined && row.step_index !== null ? Number(row.step_index) : null,
      traceId: row.trace_id ? String(row.trace_id) : null,
      spanId: row.span_id ? String(row.span_id) : null,
      payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<
        string,
        unknown
      >,
      redaction: (typeof row.redaction === "string"
        ? JSON.parse(row.redaction)
        : row.redaction) as NormalizedEventEntity["redaction"],
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
    };
  }
}
