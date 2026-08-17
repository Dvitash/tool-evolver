import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import type {
  ObservationBatchRequest,
  ObservationBatchResponse,
  ProtocolMessageEnvelope,
} from "@tool-evolver/protocol";
import { ConsentManager } from "../auth/consent.js";
import type { DatabasePool, Queryable } from "../db/client.js";
import { OutboxRepository } from "../db/outbox.js";
import type { TenantContext } from "../tenant.js";
import {
  ConsentRequiredError,
  IngestionConsentGuard,
  RawConsentRequiredError,
} from "./consent-guard.js";
import { BatchConflictError, IngestionDeduplicator } from "./deduplicator.js";
import { QuotaExceededError, QuotaLimiter } from "./quota.js";
import {
  IngestionReceipt,
  type IngestionReceiptRepository,
  createIngestionReceiptRepository,
} from "./receipt-repository.js";
import {
  type BatchValidatorOptions,
  ObservationBatchValidator,
  type ValidatedBatch,
} from "./validator.js";

/**
 * Custom error thrown on cross-tenant or credential mismatch (HTTP 403).
 */
export class TenantMismatchError extends Error {
  public readonly expected: string;
  public readonly received: string;
  public readonly field: string;

  constructor(message: string, field: string, expected: string, received: string) {
    super(message);
    this.name = "TenantMismatchError";
    this.field = field;
    this.expected = expected;
    this.received = received;
  }
}

/**
 * Ingestion request context, enriched with tenant and auth metadata.
 */
export interface IngestionContext extends TenantContext {
  deviceId?: string;
  installationId?: string;
  scopes?: string[];
  rawUploadConsent?: boolean;
}

/**
 * Ingestion service configuration options.
 */
export interface ObservationIngestionServiceOptions {
  dbPool?: DatabasePool;
  receiptRepo?: IngestionReceiptRepository;
  consentManager?: ConsentManager;
  quotaLimiter?: QuotaLimiter;
  validator?: ObservationBatchValidator;
  validatorOptions?: BatchValidatorOptions;
  deduplicator?: IngestionDeduplicator;
  consentGuard?: IngestionConsentGuard;
}

/**
 * Service orchestrating idempotent normalized-observation ingestion.
 * Handles validation, rate/quota limits, consent checks, deduplication,
 * transactional outbox job enqueuing, and contiguous cursor acknowledgement.
 */
export class ObservationIngestionService {
  private dbPool?: DatabasePool;
  private receiptRepo: IngestionReceiptRepository;
  private consentManager: ConsentManager;
  private quotaLimiter: QuotaLimiter;
  private validator: ObservationBatchValidator;
  private deduplicator: IngestionDeduplicator;
  private consentGuard: IngestionConsentGuard;

  constructor(options: ObservationIngestionServiceOptions = {}) {
    this.dbPool = options.dbPool;
    this.receiptRepo = options.receiptRepo ?? createIngestionReceiptRepository(options.dbPool);
    this.consentManager = options.consentManager ?? new ConsentManager();
    this.quotaLimiter = options.quotaLimiter ?? new QuotaLimiter();
    this.validator = options.validator ?? new ObservationBatchValidator(options.validatorOptions);
    this.deduplicator = options.deduplicator ?? new IngestionDeduplicator(this.receiptRepo);
    this.consentGuard = options.consentGuard ?? new IngestionConsentGuard(this.consentManager);
  }

  /**
   * Helper to compute the highest contiguous cursor for a source.
   */
  private computeHighestCursor(
    currentHighest: string | null,
    batchCursor?: string,
    observations: NormalizedSessionEvent[] = [],
  ): string | undefined {
    if (batchCursor) {
      // If batch cursor is numeric sequence
      const batchNum = Number.parseInt(batchCursor.replace(/^seq[-:]/i, ""), 10);
      if (!Number.isNaN(batchNum)) {
        if (currentHighest) {
          const currentNum = Number.parseInt(currentHighest.replace(/^seq[-:]/i, ""), 10);
          if (!Number.isNaN(currentNum)) {
            return batchNum > currentNum ? batchCursor : currentHighest;
          }
        }
        return batchCursor;
      }

      // If batch cursor is ISO timestamp
      const batchTime = new Date(batchCursor).getTime();
      if (!Number.isNaN(batchTime)) {
        if (currentHighest) {
          const currentTime = new Date(currentHighest).getTime();
          if (!Number.isNaN(currentTime)) {
            return batchTime > currentTime ? batchCursor : currentHighest;
          }
        }
        return batchCursor;
      }

      return batchCursor;
    }

    if (observations.length > 0) {
      const lastObs = observations[observations.length - 1];
      return lastObs.timestamp;
    }

    return currentHighest ?? undefined;
  }

  /**
   * Ingest a batch of normalized observations.
   */
  async ingestBatch(
    context: IngestionContext,
    batchRequest: ObservationBatchRequest | ProtocolMessageEnvelope<ObservationBatchRequest>,
    rawByteSize?: number,
  ): Promise<ObservationBatchResponse> {
    const startTime = Date.now();

    // 1. Extract request from envelope if wrapped
    const rawReq =
      "payload" in batchRequest &&
      typeof batchRequest.payload === "object" &&
      batchRequest.payload !== null
        ? (batchRequest as ProtocolMessageEnvelope<ObservationBatchRequest>).payload
        : (batchRequest as ObservationBatchRequest);

    const eventCount = Array.isArray(rawReq.observations) ? rawReq.observations.length : 0;
    const byteSize = rawByteSize ?? JSON.stringify(batchRequest).length;

    // 2. Enforce Quotas and Rate Limits
    await this.quotaLimiter.checkBatch(
      context.accountId,
      context.workspaceId,
      context.deviceId ?? rawReq.deviceId,
      eventCount,
      byteSize,
    );

    // 3. Validate Tenant and Device Boundaries (Anti-Spoofing)
    if (
      context.workspaceId &&
      context.workspaceId !== "system" &&
      rawReq.workspaceId &&
      rawReq.workspaceId !== context.workspaceId
    ) {
      throw new TenantMismatchError(
        `Cross-tenant workspace spoofing detected: token workspace '${context.workspaceId}' does not match request workspace '${rawReq.workspaceId}'`,
        "workspaceId",
        context.workspaceId,
        rawReq.workspaceId,
      );
    }

    if (
      context.installationId &&
      rawReq.installationId &&
      rawReq.installationId !== context.installationId
    ) {
      throw new TenantMismatchError(
        `Installation mismatch: authenticated installation '${context.installationId}' does not match request installation '${rawReq.installationId}'`,
        "installationId",
        context.installationId,
        rawReq.installationId,
      );
    }

    if (context.deviceId && rawReq.deviceId && rawReq.deviceId !== context.deviceId) {
      throw new TenantMismatchError(
        `Device mismatch: authenticated device '${context.deviceId}' does not match request device '${rawReq.deviceId}'`,
        "deviceId",
        context.deviceId,
        rawReq.deviceId,
      );
    }

    // 4. Validate Batch Request Envelope, Compression, Ordering, and Event Schemas
    const validated: ValidatedBatch = this.validator.validateBatch(batchRequest, byteSize);
    const { request, observations, contentHash } = validated;

    // 5. Enforce Consent and Privacy Boundaries
    await this.consentGuard.validateBatchConsent(
      context.accountId,
      context.workspaceId,
      context.deviceId ?? request.deviceId,
      observations,
      context.rawUploadConsent,
    );

    // 6. Check for Deduplication / Idempotency / Conflict
    const dedupeResult = await this.deduplicator.checkDuplicate(
      request.installationId,
      request.workspaceId,
      request.batchId,
      contentHash,
      request.cursor,
    );

    if (dedupeResult.isConflict) {
      throw new BatchConflictError(
        dedupeResult.reason ??
          `Conflicting batch: batchId '${request.batchId}' already exists with altered content`,
        request.batchId,
        request.installationId,
        request.workspaceId,
        request.cursor,
        dedupeResult.existingReceipt,
      );
    }

    if (dedupeResult.isDuplicate && dedupeResult.existingReceipt) {
      // Idempotent exact duplicate retry: increment duplicate counter and return existing acknowledgement
      const existing = dedupeResult.existingReceipt;
      try {
        await this.receiptRepo.incrementDuplicateCount(existing.receiptId);
      } catch {
        // Non-fatal
      }

      const prevAck = existing.responsePayload ?? {
        batchId: request.batchId,
        status: "accepted",
        acceptedCount: existing.acceptedCount,
        rejectedCount: 0,
        cursorAck: existing.sourceCursor ?? request.cursor,
        errors: [],
        deadLetters: [],
      };

      return prevAck;
    }

    // 7. Atomic DB Transaction: Record Ingestion Receipt and Enqueue Outbox Job
    const currentHighestCursor = await this.receiptRepo.getHighestContiguousCursor(
      request.installationId,
      request.workspaceId,
    );
    const cursorAck = this.computeHighestCursor(currentHighestCursor, request.cursor, observations);

    const response: ObservationBatchResponse = {
      batchId: request.batchId,
      status: "accepted",
      acceptedCount: observations.length,
      rejectedCount: 0,
      cursorAck,
      errors: [],
      deadLetters: [],
    };

    const receiptInput = {
      batchId: request.batchId,
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      deviceId: request.deviceId,
      accountId: context.accountId,
      sourceCursors: request.cursor ? [request.cursor] : [],
      sourceCursor: request.cursor,
      contentHash,
      acceptedCount: observations.length,
      status: "accepted" as const,
      responsePayload: response,
    };

    const outboxPayload = {
      batchId: request.batchId,
      accountId: context.accountId,
      workspaceId: request.workspaceId,
      deviceId: request.deviceId,
      installationId: request.installationId,
      cursor: request.cursor,
      cursorAck,
      contentHash,
      acceptedCount: observations.length,
      observations,
      ingestedAt: new Date().toISOString(),
    };

    const outboxHeaders: Record<string, string> = {};
    if (context.traceId) outboxHeaders.traceId = context.traceId;
    if (context.correlationId) outboxHeaders.correlationId = context.correlationId;

    if (this.dbPool) {
      await this.dbPool.transaction(async (txClient: Queryable) => {
        // a. Record ingestion receipt
        await this.receiptRepo.createReceipt(receiptInput, txClient);

        // b. Insert transactional outbox job
        await OutboxRepository.insert(txClient, {
          accountId: context.accountId,
          workspaceId: request.workspaceId,
          aggregateType: "observation-batch",
          aggregateId: request.batchId,
          eventType: "store-observation-batch",
          payload: outboxPayload,
          headers: outboxHeaders,
        });
      });
    } else {
      // Standalone repository fallback
      await this.receiptRepo.createReceipt(receiptInput);
    }

    // Privacy & Zero-leakage observability:
    // Log ONLY metadata, never raw payloads or observation contents.
    const durationMs = Date.now() - startTime;
    this.logSafeIngestionMetric({
      batchId: request.batchId,
      accountId: context.accountId,
      workspaceId: request.workspaceId,
      installationId: request.installationId,
      deviceId: request.deviceId,
      acceptedCount: observations.length,
      contentHash,
      durationMs,
    });

    return response;
  }

  /**
   * Safe metric logging asserting zero raw payload or transcript byte leakage.
   */
  private logSafeIngestionMetric(meta: {
    batchId: string;
    accountId: string;
    workspaceId: string;
    installationId: string;
    deviceId?: string;
    acceptedCount: number;
    contentHash: string;
    durationMs: number;
  }): void {
    // Structured telemetry/audit line containing only safe identifiers & metrics
    const safeLog = JSON.stringify({
      level: "info",
      event: "observation_batch_ingested",
      batchId: meta.batchId,
      accountId: meta.accountId,
      workspaceId: meta.workspaceId,
      installationId: meta.installationId,
      deviceId: meta.deviceId,
      acceptedCount: meta.acceptedCount,
      contentHash: meta.contentHash,
      durationMs: meta.durationMs,
    });

    // Write to process stdout/internal logger if required without leaking event contents
    if (process.env.NODE_ENV === "test-debug") {
      process.stdout.write(`${safeLog}\n`);
    }
  }

  /**
   * Expose internal consent manager for configuration in tests/services.
   */
  getConsentManager(): ConsentManager {
    return this.consentManager;
  }

  /**
   * Expose internal quota limiter for testing/configuration.
   */
  getQuotaLimiter(): QuotaLimiter {
    return this.quotaLimiter;
  }

  /**
   * Expose internal receipt repository.
   */
  getReceiptRepository(): IngestionReceiptRepository {
    return this.receiptRepo;
  }
}

/**
 * Factory function creating an ObservationIngestionService instance.
 */
export function createObservationIngestionService(
  options: ObservationIngestionServiceOptions = {},
): ObservationIngestionService {
  return new ObservationIngestionService(options);
}
