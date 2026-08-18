#!/usr/bin/env node

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

import crypto from "node:crypto";
import process from "node:process";

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
};

/**
 * Represents a single recorded fault lifecycle event.
 * @typedef {Object} FaultEvent
 * @property {string} id
 * @property {string} faultType
 * @property {number} injectedAt
 * @property {number|null} clearedAt
 * @property {number|null} recoveryDurationMs
 * @property {string} status - "active" | "cleared" | "failed"
 * @property {Record<string, unknown>} params
 * @property {string[]} logs
 */

/**
 * Core Fault Injector Controller
 */
export class FaultInjector {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.verbose]
   */
  constructor(options = {}) {
    this.verbose = options.verbose ?? false;
    /** @type {Map<string, FaultEvent>} */
    this.activeFaults = new Map();
    /** @type {FaultEvent[]} */
    this.history = [];
    /** @type {Map<string, Function>} */
    this.interceptors = new Map();
    this.clockSkewOffsetMs = 0;
  }

  /**
   * Log an operational event.
   * @param {string} msg
   */
  log(msg) {
    if (this.verbose) {
      console.log(`[FAULT-INJECTOR ${new Date().toISOString()}] ${msg}`);
    }
  }

  /**
   * Inject a specific fault scenario.
   * @param {string} faultType - One of FAULT_TYPES
   * @param {Record<string, unknown>} [params]
   * @returns {FaultEvent}
   */
  injectFault(faultType, params = {}) {
    const id = `fault_${crypto.randomUUID().slice(0, 8)}`;
    const event = {
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

    // Apply active fault effects
    switch (faultType) {
      case FAULT_TYPES.CLOCK_SKEW: {
        this.clockSkewOffsetMs = Number(params.offsetMs ?? 300000); // default +5m
        break;
      }
      default:
        break;
    }

    return event;
  }

  /**
   * Check if a specific fault is active.
   * @param {string} faultType
   * @returns {boolean}
   */
  isFaultActive(faultType) {
    return this.activeFaults.has(faultType);
  }

  /**
   * Get active fault details.
   * @param {string} faultType
   * @returns {FaultEvent|undefined}
   */
  getFault(faultType) {
    return this.activeFaults.get(faultType);
  }

  /**
   * Clear an active fault and measure recovery time (RTO).
   * @param {string} faultType
   * @returns {FaultEvent|null}
   */
  clearFault(faultType) {
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

  /**
   * Clear all active faults.
   */
  clearAllFaults() {
    for (const faultType of Array.from(this.activeFaults.keys())) {
      this.clearFault(faultType);
    }
  }

  /**
   * Get simulated current time taking clock skew into account.
   * @returns {number}
   */
  getCurrentTime() {
    return Date.now() + this.clockSkewOffsetMs;
  }

  /**
   * Intercept and simulate provider behavior (e.g. LLM rate limit or 503 outage).
   * @template T
   * @param {() => Promise<T>} realCall
   * @returns {Promise<T>}
   */
  async wrapProviderCall(realCall) {
    if (this.isFaultActive(FAULT_TYPES.PROVIDER_OUTAGE_RATE_LIMIT)) {
      const fault = this.getFault(FAULT_TYPES.PROVIDER_OUTAGE_RATE_LIMIT);
      const isRateLimit = fault?.params.rateLimit ?? true;
      if (isRateLimit) {
        const error = new Error("Upstream LLM Provider HTTP 429: Rate Limit Exceeded");
        /** @type {any} */ (error).status = 429;
        /** @type {any} */ (error).retryAfterSeconds = 2;
        throw error;
      }
      const error = new Error("Upstream LLM Provider HTTP 503: Service Unavailable");
      /** @type {any} */ (error).status = 503;
      throw error;
    }
    return realCall();
  }

  /**
   * Intercept and simulate database queries during failover / restart.
   * @template T
   * @param {() => Promise<T>} queryFn
   * @returns {Promise<T>}
   */
  async wrapDatabaseQuery(queryFn) {
    if (this.isFaultActive(FAULT_TYPES.DATABASE_RESTART_FAILOVER)) {
      const error = new Error(
        "Connection terminated unexpectedly (PostgreSQL restart/failover simulation)",
      );
      /** @type {any} */ (error).code = "57P01"; // admin_shutdown
      throw error;
    }
    return queryFn();
  }

  /**
   * Intercept and simulate object store operations.
   * @template T
   * @param {() => Promise<T>} storeFn
   * @param {Object} [options]
   * @param {boolean} [options.digestMismatch]
   * @returns {Promise<T>}
   */
  async wrapObjectStoreOperation(storeFn, options = {}) {
    if (this.isFaultActive(FAULT_TYPES.OBJECT_STORE_ERRORS)) {
      const fault = this.getFault(FAULT_TYPES.OBJECT_STORE_ERRORS);
      if (fault?.params.digestMismatch || options.digestMismatch) {
        const error = new Error(
          "Object checksum digest mismatch: expected sha256 does not match received buffer",
        );
        /** @type {any} */ (error).code = "DIGEST_MISMATCH";
        throw error;
      }
      const error = new Error("S3/MinIO HTTP 500: InternalServerError");
      /** @type {any} */ (error).code = "InternalError";
      throw error;
    }
    if (this.isFaultActive(FAULT_TYPES.DISK_PRESSURE)) {
      const error = new Error("ENOSPC: no space left on device, write failed");
      /** @type {any} */ (error).code = "ENOSPC";
      throw error;
    }
    return storeFn();
  }

  /**
   * Intercept and simulate queue dequeue / delivery.
   * @template T
   * @param {T} envelope
   * @returns {Promise<T[]>} Returns an array of envelopes (e.g. duplicate redelivery)
   */
  async wrapQueueDelivery(envelope) {
    if (this.isFaultActive(FAULT_TYPES.QUEUE_DELAY_REDELIVERY)) {
      const fault = this.getFault(FAULT_TYPES.QUEUE_DELAY_REDELIVERY);
      const delayMs = Number(fault?.params.delayMs ?? 100);
      const duplicate = Boolean(fault?.params.duplicate ?? true);
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (duplicate) {
        // Return original + duplicate redelivery envelope with same payload
        return [envelope, { ...envelope }];
      }
    }
    return [envelope];
  }

  /**
   * Intercept and simulate signing key verification.
   * @param {string} keyId
   * @returns {boolean}
   */
  verifySigningKeyActive(keyId) {
    if (this.isFaultActive(FAULT_TYPES.SIGNING_KEY_STATE_CHANGE)) {
      const fault = this.getFault(FAULT_TYPES.SIGNING_KEY_STATE_CHANGE);
      const revokedKeyId = fault?.params.revokedKeyId ?? "staging-ed25519-primary-2026";
      if (keyId === revokedKeyId) {
        return false;
      }
    }
    return true;
  }

  /**
   * Generate an execution report.
   * @returns {Object}
   */
  generateReport() {
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

// CLI Execution
if (process.argv[1] && process.argv[1].endsWith("staging-fault-injector.mjs")) {
  const args = process.argv.slice(2);
  const scenario = args.find((a) => a.startsWith("--scenario="))?.split("=")[1] ?? "all";
  const durationMs = Number(args.find((a) => a.startsWith("--duration="))?.split("=")[1] ?? 5000);

  const injector = new FaultInjector({ verbose: true });
  console.log(`\n🔥 Tool Evolver Staging Fault Injector`);
  console.log(`Scenario: ${scenario} | Duration: ${durationMs}ms\n`);

  if (scenario === "all") {
    console.log("Simulating full fault injection sequence across 10 vectors...");
    for (const [key, type] of Object.entries(FAULT_TYPES)) {
      injector.injectFault(type, { simulated: true });
      injector.clearFault(type);
    }
  } else if (FAULT_TYPES[scenario.toUpperCase()]) {
    const faultType = FAULT_TYPES[scenario.toUpperCase()];
    injector.injectFault(faultType);
    setTimeout(() => {
      injector.clearFault(faultType);
      console.log(
        "\n📊 Fault Injection Report:\n",
        JSON.stringify(injector.generateReport(), null, 2),
      );
    }, durationMs);
  } else {
    console.error(`Unknown fault scenario: ${scenario}`);
    process.exit(1);
  }

  console.log("\n📊 Final Fault Report:\n", JSON.stringify(injector.generateReport(), null, 2));
}
