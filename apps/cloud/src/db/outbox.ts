import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "./client.js";

/**
 * Record representing an outbox event in the database.
 */
export interface OutboxRecord {
  id: string;
  accountId: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  status: "pending" | "published" | "failed";
  retryCount: number;
  lastError?: string | null;
  createdAt: string;
  publishedAt?: string | null;
}

/**
 * Input for creating a new outbox event.
 */
export interface OutboxEventInput {
  id?: string;
  accountId: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * Outbox repository for transactional storage and status updates.
 */
export class OutboxRepository {
  /**
   * Insert an outbox message within an active database transaction.
   */
  static async insert(db: Queryable, input: OutboxEventInput): Promise<OutboxRecord> {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const headers = input.headers ?? {};

    await db.query(
      `INSERT INTO outbox (
        id, account_id, workspace_id, aggregate_type, aggregate_id, event_type, payload, headers, status, retry_count, last_error, created_at, published_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        input.accountId,
        input.workspaceId,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        input.payload,
        headers,
        "pending",
        0,
        null,
        now,
        null,
      ],
    );

    return {
      id,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload,
      headers,
      status: "pending",
      retryCount: 0,
      lastError: null,
      createdAt: now,
      publishedAt: null,
    };
  }

  /**
   * Fetch pending outbox messages ordered by creation time.
   */
  static async fetchPending(db: Queryable, limit = 50): Promise<OutboxRecord[]> {
    const result = await db.query<{
      id: string;
      account_id: string;
      workspace_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      headers: Record<string, string>;
      status: "pending" | "published" | "failed";
      retry_count: number;
      last_error?: string | null;
      created_at: string;
      published_at?: string | null;
    }>(
      `SELECT id, account_id, workspace_id, aggregate_type, aggregate_id, event_type, payload, headers, status, retry_count, last_error, created_at, published_at
       FROM outbox
       WHERE status = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      ["pending", limit],
    );

    return result.rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      workspaceId: r.workspace_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      payload: r.payload,
      headers: r.headers ?? {},
      status: r.status,
      retryCount: r.retry_count,
      lastError: r.last_error,
      createdAt: r.created_at,
      publishedAt: r.published_at,
    }));
  }

  /**
   * Mark an outbox record as published.
   */
  static async markPublished(db: Queryable, id: string): Promise<void> {
    const now = new Date().toISOString();
    await db.query(`UPDATE outbox SET status = $1, published_at = $2 WHERE id = $3`, [
      "published",
      now,
      id,
    ]);
  }

  /**
   * Mark an outbox record as failed and increment retry count.
   */
  static async markFailed(db: Queryable, id: string, error: string): Promise<void> {
    await db.query(
      `UPDATE outbox SET status = $1, retry_count = retry_count + 1, last_error = $2 WHERE id = $3`,
      ["failed", error, id],
    );
  }
}

export type OutboxEventHandler = (event: OutboxRecord) => Promise<void>;

/**
 * Asynchronous Outbox Publisher with deduplication and subscriber management.
 */
export class OutboxPublisher {
  private pool: DatabasePool;
  private handlers = new Map<string, Set<OutboxEventHandler>>();
  private publishedIds = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(pool: DatabasePool) {
    this.pool = pool;
  }

  /**
   * Subscribe a handler to a specific event type or "*" for all events.
   */
  subscribe(eventType: string, handler: OutboxEventHandler): () => void {
    let handlers = this.handlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventType, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers?.delete(handler);
    };
  }

  /**
   * Dispatch a single batch of pending outbox events.
   */
  async dispatchBatch(limit = 50): Promise<number> {
    const pending = await OutboxRepository.fetchPending(this.pool, limit);
    let dispatchedCount = 0;

    for (const record of pending) {
      // Deduplication check
      if (this.publishedIds.has(record.id)) {
        await OutboxRepository.markPublished(this.pool, record.id);
        continue;
      }

      try {
        const specificHandlers = this.handlers.get(record.eventType) ?? new Set();
        const wildcardHandlers = this.handlers.get("*") ?? new Set();
        const allHandlers = [...specificHandlers, ...wildcardHandlers];

        for (const handler of allHandlers) {
          await handler(record);
        }

        this.publishedIds.add(record.id);
        await OutboxRepository.markPublished(this.pool, record.id);
        dispatchedCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await OutboxRepository.markFailed(this.pool, record.id, errorMessage);
      }
    }

    return dispatchedCount;
  }

  /**
   * Start periodic outbox dispatching background worker.
   */
  start(intervalMs = 1000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const poll = async () => {
      if (!this.isRunning) return;
      try {
        await this.dispatchBatch();
      } catch {
        // Ignored in background loop
      }
      if (this.isRunning) {
        this.pollTimer = setTimeout(poll, intervalMs);
      }
    };

    this.pollTimer = setTimeout(poll, intervalMs);
  }

  /**
   * Stop the background outbox polling loop.
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
