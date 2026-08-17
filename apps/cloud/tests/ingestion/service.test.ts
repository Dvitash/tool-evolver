import { NormalizedSessionEvent } from "@tool-evolver/contracts";
import { ObservationBatchRequest } from "@tool-evolver/protocol";
import { describe, expect, it } from "vitest";
import { ConsentManager } from "../../src/auth/consent.js";
import {
  MemoryDatabasePool,
  OutboxRepository,
  runMigrations,
} from "../../src/db/index.js";
import {
  RawConsentRequiredError,
} from "../../src/ingestion/consent-guard.js";
import {
  BatchConflictError,
} from "../../src/ingestion/deduplicator.js";
import {
  IngestionContext,
  ObservationIngestionService,
  TenantMismatchError,
} from "../../src/ingestion/service.js";

describe("ObservationIngestionService", () => {
  const accountId = "acc-cloud-1";
  const workspaceId = "ws-cloud-1";
  const deviceId = "dev-cloud-1";
  const installationId = "inst-cloud-1";

  const sampleObs1: NormalizedSessionEvent = {
    eventId: "evt-obs-1",
    schemaVersion: "1.0.0",
    sessionId: "sess-001",
    timestamp: "2026-08-17T12:00:00.000Z",
    causalRef: { causalSequence: 0 },
    redaction: {
      isRedacted: true,
      redactedFields: ["authHeader"],
      redactionStrategy: "mask",
      scrubbedPatterns: [],
    },
    type: "message",
    role: "user",
    content: "Run deployment build",
  };

  const sampleObs2: NormalizedSessionEvent = {
    eventId: "evt-obs-2",
    schemaVersion: "1.0.0",
    sessionId: "sess-001",
    timestamp: "2026-08-17T12:00:01.000Z",
    causalRef: { causalSequence: 1, parentId: "evt-obs-1" },
    redaction: {
      isRedacted: true,
      redactedFields: [],
      redactionStrategy: "none",
      scrubbedPatterns: [],
    },
    type: "message",
    role: "assistant",
    content: "Building packages...",
  };

  const validBatch: ObservationBatchRequest = {
    batchId: "batch-100",
    workspaceId,
    deviceId,
    installationId,
    cursor: "seq-1",
    compressed: false,
    compression: "none",
    observations: [sampleObs1, sampleObs2],
  };

  const context: IngestionContext = {
    accountId,
    workspaceId,
    deviceId,
    installationId,
    traceId: "trace-test-1",
    correlationId: "corr-test-1",
    scopes: ["observations:write"],
  };

  async function setupService() {
    const dbPool = new MemoryDatabasePool();
    await runMigrations(dbPool);
    const consentManager = new ConsentManager();
    const service = new ObservationIngestionService({
      dbPool,
      consentManager,
    });
    return { service, dbPool, consentManager };
  }

  it("should accept valid batch, create ingestion receipt, enqueue outbox job, and acknowledge contiguous cursor", async () => {
    const { service, dbPool } = await setupService();

    const response = await service.ingestBatch(context, validBatch);

    expect(response.status).toBe("accepted");
    expect(response.acceptedCount).toBe(2);
    expect(response.rejectedCount).toBe(0);
    expect(response.batchId).toBe("batch-100");
    expect(response.cursorAck).toBe("seq-1");

    // Verify receipt in database
    const receiptsResult = await dbPool.query(
      "SELECT * FROM ingestion_receipts WHERE batch_id = $1",
      ["batch-100"],
    );
    expect(receiptsResult.rows.length).toBe(1);
    expect(receiptsResult.rows[0].accepted_count).toBe(2);
    expect(receiptsResult.rows[0].status).toBe("accepted");

    // Verify outbox job
    const pendingOutbox = await OutboxRepository.fetchPending(dbPool);
    expect(pendingOutbox.length).toBe(1);
    expect(pendingOutbox[0].eventType).toBe("store-observation-batch");
    expect(pendingOutbox[0].aggregateType).toBe("observation-batch");
    expect(pendingOutbox[0].aggregateId).toBe("batch-100");
    expect((pendingOutbox[0].payload as { acceptedCount: number }).acceptedCount).toBe(2);
  });

  it("should return identical idempotent acknowledgement on exact duplicate retry without duplicate outbox jobs", async () => {
    const { service, dbPool } = await setupService();

    // First ingestion
    const firstAck = await service.ingestBatch(context, validBatch);
    expect(firstAck.status).toBe("accepted");

    const outboxAfterFirst = await OutboxRepository.fetchPending(dbPool);
    expect(outboxAfterFirst.length).toBe(1);

    // Duplicate ingestion (same batchId, same content)
    const duplicateAck = await service.ingestBatch(context, validBatch);
    expect(duplicateAck.batchId).toBe(firstAck.batchId);
    expect(duplicateAck.acceptedCount).toBe(firstAck.acceptedCount);
    expect(duplicateAck.cursorAck).toBe(firstAck.cursorAck);

    // Verify no new outbox job was created
    const outboxAfterSecond = await OutboxRepository.fetchPending(dbPool);
    expect(outboxAfterSecond.length).toBe(1);

    // Verify duplicate counter was incremented in DB
    const receiptsResult = await dbPool.query(
      "SELECT * FROM ingestion_receipts WHERE batch_id = $1",
      ["batch-100"],
    );
    expect(receiptsResult.rows[0].duplicate_count).toBe(1);
  });

  it("should reject conflicting batch (same batchId, altered content) with 409 BatchConflictError", async () => {
    const { service } = await setupService();

    await service.ingestBatch(context, validBatch);

    // Submit same batch ID with altered observation content
    const alteredObs: NormalizedSessionEvent = {
      ...sampleObs2,
      eventId: "evt-altered",
      timestamp: "2026-08-17T12:00:05.000Z",
    };

    const conflictingBatch: ObservationBatchRequest = {
      ...validBatch,
      observations: [sampleObs1, alteredObs],
    };

    await expect(service.ingestBatch(context, conflictingBatch)).rejects.toThrow(BatchConflictError);
  });

  it("should reject cross-tenant and cross-workspace spoofing attempts with TenantMismatchError", async () => {
    const { service } = await setupService();

    // Workspace spoofing
    const spoofedBatch: ObservationBatchRequest = {
      ...validBatch,
      workspaceId: "ws-different-tenant",
    };

    await expect(service.ingestBatch(context, spoofedBatch)).rejects.toThrow(TenantMismatchError);

    // Installation mismatch
    const mismatchedInstallation: ObservationBatchRequest = {
      ...validBatch,
      installationId: "inst-spoofed",
    };

    await expect(service.ingestBatch(context, mismatchedInstallation)).rejects.toThrow(TenantMismatchError);
  });

  it("should reject raw-bearing payload without explicit raw consent", async () => {
    const { service } = await setupService();

    const rawEvent: NormalizedSessionEvent = {
      ...sampleObs1,
      metadata: { rawTranscript: true },
    };

    const rawBatch: ObservationBatchRequest = {
      ...validBatch,
      observations: [rawEvent],
    };

    await expect(service.ingestBatch(context, rawBatch)).rejects.toThrow(RawConsentRequiredError);

    // With raw upload consent, it succeeds
    const rawConsentContext: IngestionContext = {
      ...context,
      rawUploadConsent: true,
    };

    const accepted = await service.ingestBatch(rawConsentContext, rawBatch);
    expect(accepted.status).toBe("accepted");
  });

  it("should compute contiguous cursor advancement across sequential batches", async () => {
    const { service } = await setupService();

    // Batch 1: cursor seq-1
    const res1 = await service.ingestBatch(context, {
      ...validBatch,
      batchId: "batch-seq-1",
      cursor: "seq-1",
      observations: [sampleObs1],
    });
    expect(res1.cursorAck).toBe("seq-1");

    // Batch 2: cursor seq-2
    const res2 = await service.ingestBatch(context, {
      ...validBatch,
      batchId: "batch-seq-2",
      cursor: "seq-2",
      observations: [sampleObs2],
    });
    expect(res2.cursorAck).toBe("seq-2");
  });

  it("should never leak observation payload bytes in telemetry / log output", async () => {
    const { service } = await setupService();

    const loggedOutput: string[] = [];
    const originalWrite = process.stdout.write;
    process.env.NODE_ENV = "test-debug";

    // Intercept stdout
    process.stdout.write = (chunk: string | Uint8Array) => {
      loggedOutput.push(String(chunk));
      return true;
    };

    try {
      await service.ingestBatch(context, validBatch);

      const logsCombined = loggedOutput.join("");
      expect(logsCombined).toContain("observation_batch_ingested");
      expect(logsCombined).toContain("batch-100");

      // Privacy assertion: zero observation payload words or text in logs
      expect(logsCombined).not.toContain("Run deployment build");
      expect(logsCombined).not.toContain("Building packages...");
    } finally {
      process.stdout.write = originalWrite;
      delete process.env.NODE_ENV;
    }
  });
});
