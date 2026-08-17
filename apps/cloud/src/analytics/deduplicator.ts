import { hashCanonicalContent } from "@tool-evolver/contracts";
import type { TelemetryBatchRequest } from "@tool-evolver/protocol";
import type { DatabasePool, Queryable } from "../db/client.js";
import type { TelemetryReceiptEntity } from "./types.js";

/**
 * Custom error thrown when a duplicate batch submission has conflicting/altered payload content (HTTP 409).
 */
export class TelemetryBatchConflictError extends Error {
  public readonly batchId: string;
  public readonly workspaceId: string;
  public readonly existingReceipt?: TelemetryReceiptEntity;

  constructor(
    message: string,
    batchId: string,
    workspaceId: string,
    existingReceipt?: TelemetryReceiptEntity,
  ) {
    super(message);
    this.name = "TelemetryBatchConflictError";
    this.batchId = batchId;
    this.workspaceId = workspaceId;
    this.existingReceipt = existingReceipt;
  }
}

export interface TelemetryDeduplicationResult {
  duplicate: boolean;
  acceptedCount: number;
  duplicateCount: number;
  receiptId?: string;
}

/**
 * TelemetryDeduplicator: Ensures idempotent batch ingestion and detects payload conflicts.
 */
export class TelemetryDeduplicator {
  private memoryReceipts = new Map<string, TelemetryReceiptEntity>();

  constructor(private pool?: DatabasePool | Queryable) {}

  /**
   * Compute a deterministic content digest for a telemetry batch request.
   */
  computeBatchContentHash(request: TelemetryBatchRequest): string {
    return hashCanonicalContent({
      batchId: request.batchId,
      workspaceId: request.workspaceId,
      deviceId: request.deviceId,
      installationId: request.installationId,
      timestamp: request.timestamp,
      metrics: request.metrics ?? [],
      invocations: request.invocations ?? [],
    });
  }

  /**
   * Check if a batch has been processed before, or record it if new.
   */
  async checkAndRecord(
    workspaceId: string,
    batchId: string,
    contentHash: string,
    totalItemsCount: number,
    metadata: {
      accountId?: string;
      deviceId?: string;
      installationId?: string;
    } = {},
    db?: Queryable,
  ): Promise<TelemetryDeduplicationResult> {
    const executor = db ?? this.pool;
    const memoryKey = `${workspaceId}:${batchId}`;

    if (executor) {
      // 1. Query existing receipt from database
      const existingRes = await executor.query<Record<string, unknown>>(
        `SELECT id, batch_id, workspace_id, account_id, device_id, installation_id, content_hash, accepted_count, duplicate_count, status, created_at
         FROM telemetry_receipts
         WHERE workspace_id = $1 AND batch_id = $2
         LIMIT 1`,
        [workspaceId, batchId],
      );

      if (existingRes.rows.length > 0) {
        const row = existingRes.rows[0];
        const existingReceipt: TelemetryReceiptEntity = {
          id: String(row.id),
          batchId: String(row.batch_id),
          workspaceId: String(row.workspace_id),
          accountId: row.account_id ? String(row.account_id) : undefined,
          deviceId: row.device_id ? String(row.device_id) : undefined,
          installationId: row.installation_id ? String(row.installation_id) : undefined,
          contentHash: String(row.content_hash),
          acceptedCount: Number(row.accepted_count ?? 0),
          duplicateCount: Number(row.duplicate_count ?? 0),
          status: (row.status as "accepted" | "partial" | "rejected") ?? "accepted",
          createdAt: String(row.created_at),
        };

        if (existingReceipt.contentHash === contentHash) {
          // Idempotent retry: increment duplicate count in database
          await executor.query(
            `UPDATE telemetry_receipts
             SET duplicate_count = duplicate_count + 1
             WHERE id = $1`,
            [existingReceipt.id],
          );

          return {
            duplicate: true,
            acceptedCount: existingReceipt.acceptedCount,
            duplicateCount: existingReceipt.duplicateCount + 1,
            receiptId: existingReceipt.id,
          };
        }

        // Conflict: Same batch ID with differing content hash
        throw new TelemetryBatchConflictError(
          `Telemetry batch '${batchId}' previously ingested with differing content hash (existing: ${existingReceipt.contentHash}, submitted: ${contentHash})`,
          batchId,
          workspaceId,
          existingReceipt,
        );
      }

      // 2. Insert new receipt
      const receiptId = `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      await executor.query(
        `INSERT INTO telemetry_receipts (
          id, batch_id, workspace_id, account_id, device_id, installation_id,
          content_hash, accepted_count, duplicate_count, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
        [
          receiptId,
          batchId,
          workspaceId,
          metadata.accountId ?? null,
          metadata.deviceId ?? null,
          metadata.installationId ?? null,
          contentHash,
          totalItemsCount,
          0,
          "accepted",
        ],
      );

      return {
        duplicate: false,
        acceptedCount: totalItemsCount,
        duplicateCount: 0,
        receiptId,
      };
    }

    // In-memory fallback
    const existing = this.memoryReceipts.get(memoryKey);
    if (existing) {
      if (existing.contentHash === contentHash) {
        existing.duplicateCount += 1;
        return {
          duplicate: true,
          acceptedCount: existing.acceptedCount,
          duplicateCount: existing.duplicateCount,
          receiptId: existing.id,
        };
      }

      throw new TelemetryBatchConflictError(
        `Telemetry batch '${batchId}' previously ingested with differing content hash (existing: ${existing.contentHash}, submitted: ${contentHash})`,
        batchId,
        workspaceId,
        existing,
      );
    }

    const receiptId = `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const newReceipt: TelemetryReceiptEntity = {
      id: receiptId,
      batchId,
      workspaceId,
      accountId: metadata.accountId,
      deviceId: metadata.deviceId,
      installationId: metadata.installationId,
      contentHash,
      acceptedCount: totalItemsCount,
      duplicateCount: 0,
      status: "accepted",
      createdAt: new Date().toISOString(),
    };
    this.memoryReceipts.set(memoryKey, newReceipt);

    return {
      duplicate: false,
      acceptedCount: totalItemsCount,
      duplicateCount: 0,
      receiptId,
    };
  }

  /**
   * Clear in-memory receipts (used for testing).
   */
  clear(): void {
    this.memoryReceipts.clear();
  }
}
