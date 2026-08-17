/**
 * Custom error thrown when tenant or device rate/quota limits are exceeded (HTTP 429).
 */
export class QuotaExceededError extends Error {
  public readonly limitType: "requests" | "events" | "bytes" | "batch_size";
  public readonly limitValue: number;
  public readonly currentValue: number;
  public readonly retryAfterSeconds: number;

  constructor(
    message: string,
    limitType: "requests" | "events" | "bytes" | "batch_size",
    limitValue: number,
    currentValue: number,
    retryAfterSeconds = 60,
  ) {
    super(message);
    this.name = "QuotaExceededError";
    this.limitType = limitType;
    this.limitValue = limitValue;
    this.currentValue = currentValue;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Quota and rate limiter configuration.
 */
export interface QuotaLimits {
  maxRequestsPerMinute?: number;      // Default 600
  maxEventsPerMinute?: number;        // Default 50,000
  maxBytesPerMinute?: number;         // Default 100MB
  maxBatchSizeBytes?: number;         // Default 10MB
  maxDecompressedSizeBytes?: number;  // Default 50MB
  maxEventsPerBatch?: number;         // Default 1,000
}

export const DEFAULT_QUOTA_LIMITS: Required<QuotaLimits> = {
  maxRequestsPerMinute: 600,
  maxEventsPerMinute: 50_000,
  maxBytesPerMinute: 100 * 1024 * 1024,
  maxBatchSizeBytes: 10 * 1024 * 1024,
  maxDecompressedSizeBytes: 50 * 1024 * 1024,
  maxEventsPerBatch: 1000,
};

interface BucketEntry {
  timestamp: number;
  requests: number;
  events: number;
  bytes: number;
}

/**
 * Per-tenant and per-device rate limiter and quota enforcer.
 * Employs sliding window tracking to prevent abusive traffic and ensure fair QoS.
 */
export class QuotaLimiter {
  private limits: Required<QuotaLimits>;
  private buckets = new Map<string, BucketEntry[]>();

  constructor(limits: QuotaLimits = {}) {
    this.limits = { ...DEFAULT_QUOTA_LIMITS, ...limits };
  }

  private buildKey(accountId: string, workspaceId: string, deviceId?: string): string {
    return deviceId ? `${accountId}:${workspaceId}:${deviceId}` : `${accountId}:${workspaceId}`;
  }

  private cleanOldBuckets(key: string, now: number, windowMs = 60_000): BucketEntry[] {
    const existing = this.buckets.get(key) ?? [];
    const cutoff = now - windowMs;
    const active = existing.filter((b) => b.timestamp > cutoff);
    this.buckets.set(key, active);
    return active;
  }

  /**
   * Checks batch request parameters and enforces limits.
   * Throws QuotaExceededError if rate, event, or size limits are exceeded.
   */
  async checkBatch(
    accountId: string,
    workspaceId: string,
    deviceId: string | undefined,
    eventCount: number,
    payloadSizeBytes: number,
  ): Promise<void> {
    const now = Date.now();
    const key = this.buildKey(accountId, workspaceId, deviceId);

    // 1. Check single batch limits first
    if (payloadSizeBytes > this.limits.maxBatchSizeBytes) {
      throw new QuotaExceededError(
        `Batch payload size (${payloadSizeBytes} bytes) exceeds limit of ${this.limits.maxBatchSizeBytes} bytes`,
        "batch_size",
        this.limits.maxBatchSizeBytes,
        payloadSizeBytes,
        0,
      );
    }

    if (eventCount > this.limits.maxEventsPerBatch) {
      throw new QuotaExceededError(
        `Batch event count (${eventCount}) exceeds maximum allowed per batch (${this.limits.maxEventsPerBatch})`,
        "events",
        this.limits.maxEventsPerBatch,
        eventCount,
        0,
      );
    }

    // 2. Check sliding window aggregate limits
    const activeBuckets = this.cleanOldBuckets(key, now);

    let totalRequests = 1;
    let totalEvents = eventCount;
    let totalBytes = payloadSizeBytes;

    for (const b of activeBuckets) {
      totalRequests += b.requests;
      totalEvents += b.events;
      totalBytes += b.bytes;
    }

    if (totalRequests > this.limits.maxRequestsPerMinute) {
      throw new QuotaExceededError(
        `Request rate limit exceeded (${totalRequests}/${this.limits.maxRequestsPerMinute} req/min)`,
        "requests",
        this.limits.maxRequestsPerMinute,
        totalRequests,
        60,
      );
    }

    if (totalEvents > this.limits.maxEventsPerMinute) {
      throw new QuotaExceededError(
        `Event throughput quota exceeded (${totalEvents}/${this.limits.maxEventsPerMinute} events/min)`,
        "events",
        this.limits.maxEventsPerMinute,
        totalEvents,
        60,
      );
    }

    if (totalBytes > this.limits.maxBytesPerMinute) {
      throw new QuotaExceededError(
        `Bandwidth quota exceeded (${totalBytes}/${this.limits.maxBytesPerMinute} bytes/min)`,
        "bytes",
        this.limits.maxBytesPerMinute,
        totalBytes,
        60,
      );
    }

    // Record this request into the bucket
    activeBuckets.push({
      timestamp: now,
      requests: 1,
      events: eventCount,
      bytes: payloadSizeBytes,
    });
    this.buckets.set(key, activeBuckets);
  }

  /**
   * Resets all quota counters (useful in testing).
   */
  reset(): void {
    this.buckets.clear();
  }
}
