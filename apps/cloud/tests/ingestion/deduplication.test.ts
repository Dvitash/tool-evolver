import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { IngestionDeduplicator } from "../../src/ingestion/deduplicator.js";
import { MemoryIngestionReceiptRepository } from "../../src/ingestion/receipt-repository.js";

describe("IngestionDeduplicator", () => {
  const installationId = "inst-001";
  const workspaceId = "ws-001";
  const batchId = "batch-001";
  const cursor = "seq-100";

  const event1: NormalizedSessionEvent = {
    eventId: "evt-001",
    schemaVersion: "1.0.0",
    sessionId: "sess-001",
    timestamp: "2026-08-17T12:00:00.000Z",
    causalRef: { causalSequence: 0 },
    redaction: {
      isRedacted: true,
      redactedFields: [],
      redactionStrategy: "none",
      scrubbedPatterns: [],
    },
    type: "message",
    role: "user",
    content: "Test prompt",
  };

  const event2: NormalizedSessionEvent = {
    ...event1,
    eventId: "evt-002",
    role: "assistant",
    content: "Test response",
  };

  it("should recognize new unseen batch as non-duplicate and non-conflict", async () => {
    const receiptRepo = new MemoryIngestionReceiptRepository();
    const deduplicator = new IngestionDeduplicator(receiptRepo);

    const contentHash = deduplicator.computeContentHash([event1], cursor);
    const result = await deduplicator.checkDuplicate(
      installationId,
      workspaceId,
      batchId,
      contentHash,
      cursor,
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.isConflict).toBe(false);
  });

  it("should return idempotent duplicate for exact same batch retry", async () => {
    const receiptRepo = new MemoryIngestionReceiptRepository();
    const deduplicator = new IngestionDeduplicator(receiptRepo);

    const contentHash = deduplicator.computeContentHash([event1], cursor);

    // Seed prior receipt
    await receiptRepo.createReceipt({
      batchId,
      installationId,
      workspaceId,
      sourceCursor: cursor,
      contentHash,
      acceptedCount: 1,
      status: "accepted",
    });

    const result = await deduplicator.checkDuplicate(
      installationId,
      workspaceId,
      batchId,
      contentHash,
      cursor,
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.isConflict).toBe(false);
    expect(result.existingReceipt).toBeDefined();
    expect(result.existingReceipt?.batchId).toBe(batchId);
  });

  it("should detect conflict when same batch ID is submitted with altered content", async () => {
    const receiptRepo = new MemoryIngestionReceiptRepository();
    const deduplicator = new IngestionDeduplicator(receiptRepo);

    const initialHash = deduplicator.computeContentHash([event1], cursor);

    await receiptRepo.createReceipt({
      batchId,
      installationId,
      workspaceId,
      sourceCursor: cursor,
      contentHash: initialHash,
      acceptedCount: 1,
      status: "accepted",
    });

    // Altered content
    const alteredHash = deduplicator.computeContentHash([event2], cursor);

    const result = await deduplicator.checkDuplicate(
      installationId,
      workspaceId,
      batchId,
      alteredHash,
      cursor,
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.isConflict).toBe(true);
    expect(result.reason).toContain(
      "Batch 'batch-001' already exists with a different content hash",
    );
  });

  it("should detect conflict when same cursor is submitted under different batch ID with altered content", async () => {
    const receiptRepo = new MemoryIngestionReceiptRepository();
    const deduplicator = new IngestionDeduplicator(receiptRepo);

    const initialHash = deduplicator.computeContentHash([event1], cursor);

    await receiptRepo.createReceipt({
      batchId: "batch-original",
      installationId,
      workspaceId,
      sourceCursor: cursor,
      contentHash: initialHash,
      acceptedCount: 1,
      status: "accepted",
    });

    // Different batch ID with different content for same cursor
    const alteredHash = deduplicator.computeContentHash([event2], cursor);

    const result = await deduplicator.checkDuplicate(
      installationId,
      workspaceId,
      "batch-different",
      alteredHash,
      cursor,
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.isConflict).toBe(true);
    expect(result.reason).toContain("Cursor 'seq-100' was already acknowledged");
  });
});
