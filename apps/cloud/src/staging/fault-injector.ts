/**
 * Tool Evolver Staging Chaos & Fault Injection Framework
 *
 * Simulates real-world staging faults across 10 critical operational dimensions:
 * 1. Provider Outage & Rate Limiting (LLM 429/503)
 * 2. Queue Delay & Duplicate Redelivery
 * 3. Worker Crash & Abrupt Process Interruption
 * 4. API & Control Plane Disconnect
 * 5. Database Restart & Failover Simulation
 * 6. Object Storage S3 500 / Digest Corruption
 * 7. Signing Key State Change & Revocation
 * 8. Disk Space Pressure (ENOSPC)
 * 9. Clock Skew & Time Drift
 * 10. Offline Client Backlog & Burst Replay
 */

import { randomUUID } from "node:crypto";

/**
 * Enumeration of all supported fault types.
 */
export const FAULT_TYPES = {
  PROVIDER_OUTAGE_RATE_LIMIT: "provider_outage_rate_limit",
  QUEUE_DELAY_REDELIVERY: "queue_delay_redelivery",
  WORKER_CRASH: "worker_crash",
  API_CONTROL_DISCONNECT: "api_control_disconnect",
  DATABASE_RESTART_FAILOVER: "database_restart_failover",
  OBJECT_STORE_ERRORS: "object_store_errors",
  SIGNING_KEY_STATE_CHANGE: "signing_key_state_change",
  DISK_PRESSURE: "disk_pressure",
  CLOCK_SKEW: "clock_skew",
  OFFLINE_CLIENT_BACKLOG: "offline_client_backlog",
} as const;

export type FaultType = (typeof FAULT_TYPES)[keyof typeof FAULT_TYPES];

export interface FaultEvent {
  id: string;
  faultType: FaultType;
  injectedAt: number;
  clearedAt: number | null;
  recoveryDurationMs: number | null;
  status: "active" | "cleared" | "failed";
  params: Record<string, unknown>;
  logs: string[];
}

export interface FaultInjectorOptions {
  verbose?: boolean;
}

export class FaultInjector {
  readonly verbose: boolean;
  readonly activeFaults = new Map<FaultType, FaultEvent>();
  readonly history: FaultEvent[] = [];
  clockSkewOffsetMs = 0;

  constructor(options: FaultInjectorOptions = {}) {
    this.verbose = options.verbose ?? false;
  }

  log(msg: string): void {
    if (this.verbose) {
      console.log(`[FAULT-INJECTOR ${new Date().toISOString()}] ${msg}`);
    }
  }

  injectFault(faultType: FaultType, params: Record<string, unknown> = {}): FaultEvent {
    const id = `fault_${randomUUID().slice(0, 8)}`;
    const event: FaultEvent = {
      id,
      faultType,
      injectedAt: Date.now(),
      clearedAt: null,
      recoveryDurationMs: null,
      status: "active",
      params: { ...params },
      logs: [`Injected fault ${faultType} with params: ${JSON.stringify(params)}`],
    };

    this.activeFaults.set(faultType, event);
    this.history.push(event);
    this.log(`🚨 Injected fault: [${faultType}] (ID: ${id})`);

    if (faultType === FAULT_TYPES.CLOCK_SKEW) {
      this.clockSkewOffsetMs = Number(params.offsetMs ?? 300000);
    }

    return event;
  }

  isFaultActive(faultType: FaultType): boolean {
    return this.activeFaults.has(faultType);
  }

  getFault(faultType: FaultType): FaultEvent | undefined {
    return this.activeFaults.get(faultType);
  }

  clearFault(faultType: FaultType): FaultEvent | null {
    const event = this.activeFaults.get(faultType);
    if (!event) {
      return null;
    }

    const now = Date.now();
    event.clearedAt = now;
    event.recoveryDurationMs = now - event.injectedAt;
    event.status = "cleared";
    event.logs.push(
      `Cleared fault at ${new Date(now).toISOString()} (Recovery Time: ${event.recoveryDurationMs}ms)`,
    );

    this.activeFaults.delete(faultType);
    this.log(`✅ Cleared fault: [${faultType}] (RTO: ${event.recoveryDurationMs}ms)`);

    if (faultType === FAULT_TYPES.CLOCK_SKEW) {
      this.clockSkewOffsetMs = 0;
    }

    return event;
  }

  clearAllFaults(): void {
    for (const faultType of Array.from(this.activeFaults.keys())) {
      this.clearFault(faultType);
    }
  }

  getCurrentTime(): number {
    return Date.now() + this.clockSkewOffsetMs;
  }

  async wrapProviderCall<T>(realCall: () => Promise<T>): Promise<T> {
    if (this.isFaultActive(FAULT_TYPES.PROVIDER_OUTAGE_RATE_LIMIT)) {
      const fault = this.getFault(FAULT_TYPES.PROVIDER_OUTAGE_RATE_LIMIT);
      const isRateLimit = fault?.params.rateLimit ?? true;
      if (isRateLimit) {
        const error = new Error("Upstream LLM Provider HTTP 429: Rate Limit Exceeded");
        Object.assign(error, { status: 429, retryAfterSeconds: 2 });
        throw error;
      }
      const error = new Error("Upstream LLM Provider HTTP 503: Service Unavailable");
      Object.assign(error, { status: 503 });
      throw error;
    }
    return realCall();
  }

  async wrapDatabaseQuery<T>(queryFn: () => Promise<T>): Promise<T> {
    if (this.isFaultActive(FAULT_TYPES.DATABASE_RESTART_FAILOVER)) {
      const error = new Error(
        "Connection terminated unexpectedly (PostgreSQL restart/failover simulation)",
      );
      Object.assign(error, { code: "57P01" });
      throw error;
    }
    return queryFn();
  }

  async wrapObjectStoreOperation<T>(
    storeFn: () => Promise<T>,
    options: { digestMismatch?: boolean } = {},
  ): Promise<T> {
    if (this.isFaultActive(FAULT_TYPES.OBJECT_STORE_ERRORS)) {
      const fault = this.getFault(FAULT_TYPES.OBJECT_STORE_ERRORS);
      if (fault?.params.digestMismatch || options.digestMismatch) {
        const error = new Error(
          "Object checksum digest mismatch: expected sha256 does not match received buffer",
        );
        Object.assign(error, { code: "DIGEST_MISMATCH" });
        throw error;
      }
      const error = new Error("S3/MinIO HTTP 500: InternalServerError");
      Object.assign(error, { code: "InternalError" });
      throw error;
    }
    if (this.isFaultActive(FAULT_TYPES.DISK_PRESSURE)) {
      const error = new Error("ENOSPC: no space left on device, write failed");
      Object.assign(error, { code: "ENOSPC" });
      throw error;
    }
    return storeFn();
  }

  async wrapQueueDelivery<T>(envelope: T): Promise<T[]> {
    if (this.isFaultActive(FAULT_TYPES.QUEUE_DELAY_REDELIVERY)) {
      const fault = this.getFault(FAULT_TYPES.QUEUE_DELAY_REDELIVERY);
      const delayMs = Number(fault?.params.delayMs ?? 100);
      const duplicate = Boolean(fault?.params.duplicate ?? true);
      if (delayMs > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, delayMs);
        await promise;
      }
      if (duplicate) {
        return [envelope, { ...envelope }];
      }
    }
    return [envelope];
  }

  verifySigningKeyActive(keyId: string): boolean {
    if (this.isFaultActive(FAULT_TYPES.SIGNING_KEY_STATE_CHANGE)) {
      const fault = this.getFault(FAULT_TYPES.SIGNING_KEY_STATE_CHANGE);
      const revokedKeyId = fault?.params.revokedKeyId ?? "staging-ed25519-primary-2026";
      if (keyId === revokedKeyId) {
        return false;
      }
    }
    return true;
  }

  generateReport(): {
    timestamp: string;
    totalInjected: number;
    currentlyActive: number;
    clearedCount: number;
    averageRecoveryTimeMs: number;
    history: FaultEvent[];
  } {
    const totalInjected = this.history.length;
    const currentlyActive = this.activeFaults.size;
    const cleared = this.history.filter((h) => h.status === "cleared");
    const avgRtoMs =
      cleared.length > 0
        ? Math.round(
            cleared.reduce((acc, curr) => acc + (curr.recoveryDurationMs ?? 0), 0) / cleared.length,
          )
        : 0;

    return {
      timestamp: new Date().toISOString(),
      totalInjected,
      currentlyActive,
      clearedCount: cleared.length,
      averageRecoveryTimeMs: avgRtoMs,
      history: this.history,
    };
  }
}
