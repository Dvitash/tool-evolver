import { NormalizedSessionEvent, hashCanonicalContent } from "@tool-evolver/contracts";
import { Queryable } from "../db/client.js";
import {
  IngestionReceipt,
  IngestionReceiptRepository,
} from "./receipt-repository.js";

/**
 * Custom error thrown when a duplicate batch submission has conflicting/altered content (HTTP 409).
 */
export class BatchConflictError extends Error {
  public readonly batchId: string;
  public readonly installationId: string;
  public readonly workspaceId: string;
  public readonly cursor?: string;
  public readonly existingReceipt?: IngestionReceipt;

  constructor(
    message: string,
    batchId: string,
    installationId: string,
    workspaceId: string,
    cursor?: string,
    existingReceipt?: IngestionReceipt,
  ) {
    super(message);
    this.name = "BatchConflictError";
    this.batchId = batchId;
    this.installationId = installationId;
    this.workspaceId = workspaceId;
    this.cursor = cursor;
    this.existingReceipt = existingReceipt;
  }
}

/**
 * Result of a deduplication check.
 */
export interface DeduplicationCheckResult {
  isDuplicate: boolean;
  isConflict: boolean;
  existingReceipt?: IngestionReceipt;
  reason?: string;
}

/**
 * Ingestion deduplication engine.
 * Computes deterministic canonical hashes and checks for duplicate/conflicting batches.
 */
export class IngestionDeduplicator {
  private receiptRepo: IngestionReceiptRepository;

  constructor(receiptRepo: IngestionReceiptRepository) {
    this.receiptRepo = receiptRepo;
  }

  /**
   * Computes deterministic canonical content hash for an observation batch.
   */
  computeContentHash(observations: NormalizedSessionEvent[], cursor?: string): string {
    return hashCanonicalContent({
      observations,
      cursor: cursor ?? null,
    });
  }

  /**
   * Checks whether a batch request is a duplicate, a conflict, or new.
   */
  async checkDuplicate(
    installationId: string,
    workspaceId: string,
    batchId: string,
    contentHash: string,
    cursor?: string,
    executor?: Queryable,
  ): Promise<DeduplicationCheckResult> {
    // 1. Check existing receipt by batch ID
    const receiptByBatch = await this.receiptRepo.findByBatchId(
      installationId,
      workspaceId,
      batchId,
      executor,
    );

    if (receiptByBatch) {
      if (receiptByBatch.contentHash === contentHash) {
        return {
          isDuplicate: true,
          isConflict: false,
          existingReceipt: receiptByBatch,
        };
      }

      return {
        isDuplicate: false,
        isConflict: true,
        existingReceipt: receiptByBatch,
        reason: `Batch '${batchId}' already exists with a different content hash`,
      };
    }

    // 2. Check existing receipt by cursor (if cursor specified)
    if (cursor) {
      const receiptByCursor = await this.receiptRepo.findByCursor(
        installationId,
        workspaceId,
        cursor,
        executor,
      );

      if (receiptByCursor && receiptByCursor.batchId !== batchId) {
        if (receiptByCursor.contentHash === contentHash) {
          return {
            isDuplicate: true,
            isConflict: false,
            existingReceipt: receiptByCursor,
          };
        }

        return {
          isDuplicate: false,
          isConflict: true,
          existingReceipt: receiptByCursor,
          reason: `Cursor '${cursor}' was already acknowledged with different observation content`,
        };
      }
    }

    return {
      isDuplicate: false,
      isConflict: false,
    };
  }
}
