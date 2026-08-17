import { describe, expect, it } from "vitest";
import { QuotaExceededError, QuotaLimiter } from "../../src/ingestion/quota.js";

describe("QuotaLimiter", () => {
  const accountId = "acc-test";
  const workspaceId = "ws-test";
  const deviceId = "dev-test";

  it("should permit requests within normal limits", async () => {
    const limiter = new QuotaLimiter({
      maxRequestsPerMinute: 10,
      maxEventsPerMinute: 100,
      maxBatchSizeBytes: 1024 * 1024,
    });

    await expect(
      limiter.checkBatch(accountId, workspaceId, deviceId, 5, 1000),
    ).resolves.toBeUndefined();
  });

  it("should reject single batch exceeding maxBatchSizeBytes", async () => {
    const limiter = new QuotaLimiter({ maxBatchSizeBytes: 1000 });

    await expect(limiter.checkBatch(accountId, workspaceId, deviceId, 1, 2000)).rejects.toThrow(
      QuotaExceededError,
    );
  });

  it("should reject single batch exceeding maxEventsPerBatch", async () => {
    const limiter = new QuotaLimiter({ maxEventsPerBatch: 10 });

    await expect(limiter.checkBatch(accountId, workspaceId, deviceId, 15, 500)).rejects.toThrow(
      QuotaExceededError,
    );
  });

  it("should enforce request rate limit in sliding window", async () => {
    const limiter = new QuotaLimiter({ maxRequestsPerMinute: 3 });

    // Request 1, 2, 3 ok
    await limiter.checkBatch(accountId, workspaceId, deviceId, 1, 100);
    await limiter.checkBatch(accountId, workspaceId, deviceId, 1, 100);
    await limiter.checkBatch(accountId, workspaceId, deviceId, 1, 100);

    // 4th request in same window exceeds limit
    await expect(limiter.checkBatch(accountId, workspaceId, deviceId, 1, 100)).rejects.toThrow(
      QuotaExceededError,
    );
  });

  it("should enforce event throughput limit in sliding window", async () => {
    const limiter = new QuotaLimiter({ maxEventsPerMinute: 50 });

    // 30 events ok
    await limiter.checkBatch(accountId, workspaceId, deviceId, 30, 100);

    // 30 more events exceeds 50 limit
    await expect(limiter.checkBatch(accountId, workspaceId, deviceId, 30, 100)).rejects.toThrow(
      QuotaExceededError,
    );
  });

  it("should enforce bandwidth bytes quota in sliding window", async () => {
    const limiter = new QuotaLimiter({ maxBytesPerMinute: 5000 });

    // 3000 bytes ok
    await limiter.checkBatch(accountId, workspaceId, deviceId, 1, 3000);

    // 3000 more bytes exceeds 5000 limit
    await expect(limiter.checkBatch(accountId, workspaceId, deviceId, 1, 3000)).rejects.toThrow(
      QuotaExceededError,
    );
  });
});
