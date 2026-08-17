import { describe, expect, it, beforeEach } from "vitest";
import {
  TelemetryBatchConflictError,
  TelemetryDeduplicator,
} from "../../src/analytics/deduplicator.js";
import type { TelemetryBatchRequest } from "../../src/analytics/types.js";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";

describe("TelemetryDeduplicator: Idempotent Batch Processing & Conflict Detection", () => {
  let pool: MemoryDatabasePool;
  let deduplicator: TelemetryDeduplicator;

  const sampleBatch: TelemetryBatchRequest = {
    batchId: "batch_dedup_001",
    deviceId: "dev_dedup_001",
    installationId: "inst_dedup_001",
    workspaceId: "ws_dedup_001",
    timestamp: "2026-08-17T12:00:00.000Z",
    metrics: [
      {
        metricName: "tool.invocation",
        value: 1,
        tags: { toolId: "bash_tool", status: "success" },
        timestamp: "2026-08-17T12:00:00.000Z",
      },
    ],
    invocations: [],
  };

  beforeEach(async () => {
    pool = new MemoryDatabasePool();
    await runMigrations(pool);
    deduplicator = new TelemetryDeduplicator(pool);
  });

  it("should process a new batch and record receipt", async () => {
    const hash = deduplicator.computeBatchContentHash(sampleBatch);
    const result = await deduplicator.checkAndRecord(
      sampleBatch.workspaceId,
      sampleBatch.batchId,
      hash,
      1,
      { deviceId: sampleBatch.deviceId, installationId: sampleBatch.installationId },
    );

    expect(result.duplicate).toBe(false);
    expect(result.acceptedCount).toBe(1);
    expect(result.duplicateCount).toBe(0);
    expect(result.receiptId).toBeDefined();
  });

  it("should detect duplicate submission of identical batch idempotently", async () => {
    const hash = deduplicator.computeBatchContentHash(sampleBatch);

    // First attempt
    const res1 = await deduplicator.checkAndRecord(
      sampleBatch.workspaceId,
      sampleBatch.batchId,
      hash,
      1,
    );
    expect(res1.duplicate).toBe(false);

    // Second identical attempt
    const res2 = await deduplicator.checkAndRecord(
      sampleBatch.workspaceId,
      sampleBatch.batchId,
      hash,
      1,
    );
    expect(res2.duplicate).toBe(true);
    expect(res2.acceptedCount).toBe(1);
    expect(res2.duplicateCount).toBe(1);

    // Third identical attempt
    const res3 = await deduplicator.checkAndRecord(
      sampleBatch.workspaceId,
      sampleBatch.batchId,
      hash,
      1,
    );
    expect(res3.duplicate).toBe(true);
    expect(res3.duplicateCount).toBe(2);
  });

  it("should throw TelemetryBatchConflictError when batchId is reused with altered content", async () => {
    const hash1 = deduplicator.computeBatchContentHash(sampleBatch);

    // Initial submission
    await deduplicator.checkAndRecord(
      sampleBatch.workspaceId,
      sampleBatch.batchId,
      hash1,
      1,
    );

    // Altered batch payload with same batchId
    const alteredBatch: TelemetryBatchRequest = {
      ...sampleBatch,
      metrics: [
        {
          metricName: "tool.invocation",
          value: 999, // Changed value
          tags: { toolId: "bash_tool", status: "error" },
          timestamp: "2026-08-17T12:05:00.000Z",
        },
      ],
    };
    const hash2 = deduplicator.computeBatchContentHash(alteredBatch);
    expect(hash1).not.toBe(hash2);

    await expect(
      deduplicator.checkAndRecord(
        alteredBatch.workspaceId,
        alteredBatch.batchId,
        hash2,
        1,
      ),
    ).rejects.toThrow(TelemetryBatchConflictError);
  });

  it("should work in-memory when database pool is not provided", async () => {
    const memoryDedup = new TelemetryDeduplicator();
    const hash = memoryDedup.computeBatchContentHash(sampleBatch);

    const first = await memoryDedup.checkAndRecord(
      sampleBatch.workspaceId,
      sampleBatch.batchId,
      hash,
      1,
    );
    expect(first.duplicate).toBe(false);

    const second = await memoryDedup.checkAndRecord(
      sampleBatch.workspaceId,
      sampleBatch.batchId,
      hash,
      1,
    );
    expect(second.duplicate).toBe(true);

    const alteredHash = "different_hash_value";
    await expect(
      memoryDedup.checkAndRecord(
        sampleBatch.workspaceId,
        sampleBatch.batchId,
        alteredHash,
        1,
      ),
    ).rejects.toThrow(TelemetryBatchConflictError);
  });
});
