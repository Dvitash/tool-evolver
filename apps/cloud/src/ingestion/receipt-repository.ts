import { randomUUID } from "node:crypto";
import type { ObservationBatchResponse } from "@tool-evolver/protocol";
import type { DatabasePool, Queryable } from "../db/client.js";

/**
 * Ingestion receipt record.
 */
export interface IngestionReceipt {
  receiptId: string;
  batchId: string;
  installationId: string;
  workspaceId: string;
  deviceId?: string;
  accountId?: string;
  sourceCursors?: string[];
  sourceCursor?: string;
  contentHash: string;
  acceptedCount: number;
  duplicateCount: number;
  status: "accepted" | "partial" | "rejected";
  responsePayload?: ObservationBatchResponse;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input for creating or recording an ingestion receipt.
 */
export interface IngestionReceiptInput {
  receiptId?: string;
  batchId: string;
  installationId: string;
  workspaceId: string;
  deviceId?: string;
  accountId?: string;
  sourceCursors?: string[];
  sourceCursor?: string;
  contentHash: string;
  acceptedCount: number;
  duplicateCount?: number;
  status?: "accepted" | "partial" | "rejected";
  responsePayload?: ObservationBatchResponse;
}

/**
 * Repository interface for managing ingestion receipts.
 */
export interface IngestionReceiptRepository {
  getReceipt(receiptId: string, executor?: Queryable): Promise<IngestionReceipt | null>;
  findByBatchId(
    installationId: string,
    workspaceId: string,
    batchId: string,
    executor?: Queryable,
  ): Promise<IngestionReceipt | null>;
  findByCursor(
    installationId: string,
    workspaceId: string,
    cursor: string,
    executor?: Queryable,
  ): Promise<IngestionReceipt | null>;
  createReceipt(input: IngestionReceiptInput, executor?: Queryable): Promise<IngestionReceipt>;
  incrementDuplicateCount(receiptId: string, executor?: Queryable): Promise<IngestionReceipt>;
  getHighestContiguousCursor(
    installationId: string,
    workspaceId: string,
    executor?: Queryable,
  ): Promise<string | null>;
  listReceipts(
    installationId: string,
    workspaceId: string,
    limit?: number,
    executor?: Queryable,
  ): Promise<IngestionReceipt[]>;
}

/**
 * In-memory repository implementation for ingestion receipts.
 */
export class MemoryIngestionReceiptRepository implements IngestionReceiptRepository {
  private receipts = new Map<string, IngestionReceipt>();

  private buildKey(installationId: string, workspaceId: string, batchId: string): string {
    return `${installationId}:${workspaceId}:${batchId}`;
  }

  async getReceipt(receiptId: string): Promise<IngestionReceipt | null> {
    for (const receipt of this.receipts.values()) {
      if (receipt.receiptId === receiptId) return { ...receipt };
    }
    return null;
  }

  async findByBatchId(
    installationId: string,
    workspaceId: string,
    batchId: string,
  ): Promise<IngestionReceipt | null> {
    const key = this.buildKey(installationId, workspaceId, batchId);
    const found = this.receipts.get(key);
    return found ? { ...found } : null;
  }

  async findByCursor(
    installationId: string,
    workspaceId: string,
    cursor: string,
  ): Promise<IngestionReceipt | null> {
    for (const receipt of this.receipts.values()) {
      if (receipt.installationId === installationId && receipt.workspaceId === workspaceId) {
        if (receipt.sourceCursor === cursor || receipt.sourceCursors?.includes(cursor)) {
          return { ...receipt };
        }
      }
    }
    return null;
  }

  async createReceipt(input: IngestionReceiptInput): Promise<IngestionReceipt> {
    const now = new Date().toISOString();
    const receiptId = input.receiptId ?? `rcpt-${randomUUID().slice(0, 12)}`;
    const receipt: IngestionReceipt = {
      receiptId,
      batchId: input.batchId,
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      deviceId: input.deviceId,
      accountId: input.accountId,
      sourceCursors: input.sourceCursors ?? (input.sourceCursor ? [input.sourceCursor] : []),
      sourceCursor: input.sourceCursor,
      contentHash: input.contentHash,
      acceptedCount: input.acceptedCount,
      duplicateCount: input.duplicateCount ?? 0,
      status: input.status ?? "accepted",
      responsePayload: input.responsePayload,
      createdAt: now,
      updatedAt: now,
    };

    const key = this.buildKey(input.installationId, input.workspaceId, input.batchId);
    this.receipts.set(key, receipt);
    return { ...receipt };
  }

  async incrementDuplicateCount(receiptId: string): Promise<IngestionReceipt> {
    for (const [key, receipt] of this.receipts.entries()) {
      if (receipt.receiptId === receiptId) {
        const updated: IngestionReceipt = {
          ...receipt,
          duplicateCount: receipt.duplicateCount + 1,
          updatedAt: new Date().toISOString(),
        };
        this.receipts.set(key, updated);
        return { ...updated };
      }
    }
    throw new Error(`Ingestion receipt '${receiptId}' not found`);
  }

  async getHighestContiguousCursor(
    installationId: string,
    workspaceId: string,
  ): Promise<string | null> {
    const matching: IngestionReceipt[] = [];
    for (const receipt of this.receipts.values()) {
      if (
        receipt.installationId === installationId &&
        receipt.workspaceId === workspaceId &&
        receipt.status === "accepted"
      ) {
        matching.push(receipt);
      }
    }

    if (matching.length === 0) return null;

    // Sort by created_at ascending
    matching.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    let highestCursor: string | null = null;
    for (const r of matching) {
      if (r.sourceCursor) {
        highestCursor = r.sourceCursor;
      } else if (r.sourceCursors && r.sourceCursors.length > 0) {
        highestCursor = r.sourceCursors[r.sourceCursors.length - 1];
      }
    }

    return highestCursor;
  }

  async listReceipts(
    installationId: string,
    workspaceId: string,
    limit = 50,
  ): Promise<IngestionReceipt[]> {
    const list: IngestionReceipt[] = [];
    for (const receipt of this.receipts.values()) {
      if (receipt.installationId === installationId && receipt.workspaceId === workspaceId) {
        list.push({ ...receipt });
      }
    }
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return list.slice(0, limit);
  }

  clear(): void {
    this.receipts.clear();
  }
}

/**
 * PostgreSQL repository implementation for ingestion receipts.
 */
export class PostgresIngestionReceiptRepository implements IngestionReceiptRepository {
  private pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.pool = pool;
  }

  private mapRow(row: Record<string, unknown>): IngestionReceipt {
    let sourceCursors: string[] = [];
    if (Array.isArray(row.source_cursors)) {
      sourceCursors = row.source_cursors as string[];
    } else if (typeof row.source_cursors === "string") {
      try {
        sourceCursors = JSON.parse(row.source_cursors) as string[];
      } catch {
        sourceCursors = [row.source_cursors];
      }
    }

    let responsePayload: ObservationBatchResponse | undefined;
    if (row.response_payload && typeof row.response_payload === "object") {
      responsePayload = row.response_payload as ObservationBatchResponse;
    } else if (typeof row.response_payload === "string") {
      try {
        responsePayload = JSON.parse(row.response_payload) as ObservationBatchResponse;
      } catch {
        // ignore
      }
    }

    return {
      receiptId: String(row.receipt_id),
      batchId: String(row.batch_id),
      installationId: String(row.installation_id),
      workspaceId: String(row.workspace_id),
      deviceId: row.device_id ? String(row.device_id) : undefined,
      accountId: row.account_id ? String(row.account_id) : undefined,
      sourceCursors,
      sourceCursor: row.source_cursor ? String(row.source_cursor) : undefined,
      contentHash: String(row.content_hash),
      acceptedCount: Number(row.accepted_count ?? 0),
      duplicateCount: Number(row.duplicate_count ?? 0),
      status: (row.status as "accepted" | "partial" | "rejected") ?? "accepted",
      responsePayload,
      createdAt: row.created_at
        ? new Date(row.created_at as string).toISOString()
        : new Date().toISOString(),
      updatedAt: row.updated_at
        ? new Date(row.updated_at as string).toISOString()
        : new Date().toISOString(),
    };
  }

  async getReceipt(receiptId: string, executor?: Queryable): Promise<IngestionReceipt | null> {
    const client = executor ?? this.pool;
    const res = await client.query(`SELECT * FROM ingestion_receipts WHERE receipt_id = $1`, [
      receiptId,
    ]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByBatchId(
    installationId: string,
    workspaceId: string,
    batchId: string,
    executor?: Queryable,
  ): Promise<IngestionReceipt | null> {
    const client = executor ?? this.pool;
    const res = await client.query(
      `SELECT * FROM ingestion_receipts WHERE installation_id = $1 AND workspace_id = $2 AND batch_id = $3`,
      [installationId, workspaceId, batchId],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByCursor(
    installationId: string,
    workspaceId: string,
    cursor: string,
    executor?: Queryable,
  ): Promise<IngestionReceipt | null> {
    const client = executor ?? this.pool;
    const res = await client.query(
      `SELECT * FROM ingestion_receipts WHERE installation_id = $1 AND workspace_id = $2 AND source_cursor = $3`,
      [installationId, workspaceId, cursor],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async createReceipt(
    input: IngestionReceiptInput,
    executor?: Queryable,
  ): Promise<IngestionReceipt> {
    const client = executor ?? this.pool;
    const receiptId = input.receiptId ?? `rcpt-${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const sourceCursors = input.sourceCursors ?? (input.sourceCursor ? [input.sourceCursor] : []);
    const sourceCursorsJson = JSON.stringify(sourceCursors);
    const responsePayloadJson = input.responsePayload
      ? JSON.stringify(input.responsePayload)
      : "{}";

    await client.query(
      `INSERT INTO ingestion_receipts (
        receipt_id, batch_id, installation_id, workspace_id, device_id, account_id,
        source_cursors, source_cursor, content_hash, accepted_count, duplicate_count,
        status, response_payload, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        receiptId,
        input.batchId,
        input.installationId,
        input.workspaceId,
        input.deviceId ?? null,
        input.accountId ?? null,
        sourceCursorsJson,
        input.sourceCursor ?? null,
        input.contentHash,
        input.acceptedCount,
        input.duplicateCount ?? 0,
        input.status ?? "accepted",
        responsePayloadJson,
        now,
        now,
      ],
    );

    return {
      receiptId,
      batchId: input.batchId,
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      deviceId: input.deviceId,
      accountId: input.accountId,
      sourceCursors,
      sourceCursor: input.sourceCursor,
      contentHash: input.contentHash,
      acceptedCount: input.acceptedCount,
      duplicateCount: input.duplicateCount ?? 0,
      status: input.status ?? "accepted",
      responsePayload: input.responsePayload,
      createdAt: now,
      updatedAt: now,
    };
  }

  async incrementDuplicateCount(
    receiptId: string,
    executor?: Queryable,
  ): Promise<IngestionReceipt> {
    const client = executor ?? this.pool;
    const now = new Date().toISOString();
    await client.query(
      `UPDATE ingestion_receipts SET duplicate_count = duplicate_count + 1, updated_at = $1 WHERE receipt_id = $2`,
      [now, receiptId],
    );
    const updated = await this.getReceipt(receiptId, client);
    if (!updated) throw new Error(`Ingestion receipt '${receiptId}' not found`);
    return updated;
  }

  async getHighestContiguousCursor(
    installationId: string,
    workspaceId: string,
    executor?: Queryable,
  ): Promise<string | null> {
    const client = executor ?? this.pool;
    const res = await client.query(
      `SELECT source_cursor, source_cursors FROM ingestion_receipts WHERE installation_id = $1 AND workspace_id = $2 AND status = 'accepted' ORDER BY created_at ASC`,
      [installationId, workspaceId],
    );
    if (res.rows.length === 0) return null;

    let highestCursor: string | null = null;
    for (const row of res.rows) {
      if (row.source_cursor) {
        highestCursor = String(row.source_cursor);
      }
    }
    return highestCursor;
  }

  async listReceipts(
    installationId: string,
    workspaceId: string,
    limit = 50,
    executor?: Queryable,
  ): Promise<IngestionReceipt[]> {
    const client = executor ?? this.pool;
    const res = await client.query(
      `SELECT * FROM ingestion_receipts WHERE installation_id = $1 AND workspace_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [installationId, workspaceId, limit],
    );
    return res.rows.map((row) => this.mapRow(row));
  }
}

/**
 * Factory function creating an IngestionReceiptRepository instance.
 */
export function createIngestionReceiptRepository(pool?: DatabasePool): IngestionReceiptRepository {
  return pool
    ? new PostgresIngestionReceiptRepository(pool)
    : new MemoryIngestionReceiptRepository();
}
