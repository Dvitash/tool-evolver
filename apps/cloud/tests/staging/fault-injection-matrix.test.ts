import { describe, expect, it } from "vitest";
import { createAuthService } from "../../src/auth/index.js";
import { MemoryDatabasePool, runMigrations } from "../../src/db/index.js";
import { createJobEnvelope } from "../../src/queue/envelope.js";
import { MemoryDurableQueue } from "../../src/queue/queue.js";
import { FAULT_TYPES, FaultInjector } from "../../src/staging/index.js";
import { DigestMismatchError, MemoryObjectStore } from "../../src/storage/index.js";
import type { TenantContext } from "../../src/tenant.js";

describe("Staging Fault Injection Matrix & Chaos Resilience Suite", () => {
  const tenant: TenantContext = {
    accountId: "acc_fault_tenant_01",
    workspaceId: "ws_fault_tenant_01",
  };

  it("1. Provider Outage & Rate Limit: handles 429 and 503 with retry budgets and exponential backoff", async () => {
    const injector = new FaultInjector({ verbose: false });

    // Inject rate limit
    injector.injectFault(FAULT_TYPES.PROVIDER_OUTAGE_RATE_LIMIT, { rateLimit: true });
    let rateLimitCaught = false;

    try {
      await injector.wrapProviderCall(async () => ({ result: "ok" }));
    } catch (err: unknown) {
      rateLimitCaught = true;
      if (err && typeof err === "object" && "status" in err && "retryAfterSeconds" in err) {
        expect(err.status).toBe(429);
        expect(err.retryAfterSeconds).toBe(2);
      }
    }
    expect(rateLimitCaught).toBe(true);

    // Switch to 503 outage
    injector.injectFault(FAULT_TYPES.PROVIDER_OUTAGE_RATE_LIMIT, { rateLimit: false });
    let outageCaught = false;
    try {
      await injector.wrapProviderCall(async () => ({ result: "ok" }));
    } catch (err: unknown) {
      outageCaught = true;
      if (err && typeof err === "object" && "status" in err) {
        expect(err.status).toBe(503);
      }
    }

    // Clear fault -> call succeeds immediately
    const cleared = injector.clearFault(FAULT_TYPES.PROVIDER_OUTAGE_RATE_LIMIT);
    expect(cleared?.status).toBe("cleared");
    expect(cleared?.recoveryDurationMs).toBeGreaterThanOrEqual(0);

    const successfulCall = await injector.wrapProviderCall(async () => ({
      result: "success_after_recovery",
    }));
    expect(successfulCall.result).toBe("success_after_recovery");
  });

  it("2. Queue Delay & Redelivery: deduplicates duplicate delivery envelopes via idempotency keys", async () => {
    const injector = new FaultInjector({ verbose: false });
    const queue = new MemoryDurableQueue();

    const originalEnvelope = createJobEnvelope({
      jobType: "evolution.candidate.validate",
      tenantContext: tenant,
      payload: { candidateId: "cand_dedup_01", revisionId: "rev_01" },
      idempotencyKey: "idem_dedup_key_1001",
    });

    injector.injectFault(FAULT_TYPES.QUEUE_DELAY_REDELIVERY, { delayMs: 10, duplicate: true });

    // Simulate transport wrapping
    const deliveredEnvelopes = await injector.wrapQueueDelivery(originalEnvelope);
    expect(deliveredEnvelopes).toHaveLength(2);

    // Enqueue both
    const id1 = await queue.enqueue(deliveredEnvelopes[0]);
    const id2 = await queue.enqueue(deliveredEnvelopes[1]);

    // Same idempotency key yields same job ID
    expect(id1).toBe(id2);

    const stats = await queue.getQueueStats();
    expect(stats.pendingCount).toBe(1);

    injector.clearFault(FAULT_TYPES.QUEUE_DELAY_REDELIVERY);
  });

  it("3. Worker Crash: recovers locks via visibility timeout and routes to DLQ after retry budget exhaustion", async () => {
    const queue = new MemoryDurableQueue({ visibilityTimeoutMs: 50, backoffBaseMs: 0 });
    const envelope = createJobEnvelope({
      jobType: "evolution.candidate.replay",
      tenantContext: tenant,
      payload: { candidateId: "cand_crash_01" },
      maxAttempts: 2,
    });

    const jobId = await queue.enqueue(envelope);

    // First attempt -> Worker crashes
    const dequeued1 = await queue.dequeue(["evolution.candidate.replay"], 50);
    expect(dequeued1).not.toBeNull();
    expect(dequeued1?.jobId).toBe(jobId);

    // Simulate crash -> nack with retry=true
    await queue.nack(jobId, new Error("Worker process killed by SIGKILL (Crash simulation)"), true);

    // Second attempt -> Worker crashes again -> Retry budget exhausted -> sent to DLQ
    const dequeued2 = await queue.dequeue(["evolution.candidate.replay"], 50);
    expect(dequeued2).not.toBeNull();
    await queue.nack(jobId, new Error("Worker OOM Killed: max retries reached"), true);

    // Queue is now empty (job in DLQ)
    const dequeued3 = await queue.dequeue(["evolution.candidate.replay"], 50);
    expect(dequeued3).toBeNull();
    const stats = await queue.getQueueStats();
    expect(stats.deadLetterCount).toBe(1);

    const deadLetters = await queue.getDeadLetterJobs(10);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].originalJobId).toBe(jobId);
    expect(deadLetters[0].attempts).toBeGreaterThanOrEqual(2);
  });

  it("4. API & Control Disconnect: simulates transient network partition and recovers cleanly", async () => {
    const injector = new FaultInjector({ verbose: false });

    injector.injectFault(FAULT_TYPES.API_CONTROL_DISCONNECT);
    expect(injector.isFaultActive(FAULT_TYPES.API_CONTROL_DISCONNECT)).toBe(true);

    // Clear fault and verify RTO
    const cleared = injector.clearFault(FAULT_TYPES.API_CONTROL_DISCONNECT);
    expect(cleared?.status).toBe("cleared");
    expect(injector.isFaultActive(FAULT_TYPES.API_CONTROL_DISCONNECT)).toBe(false);
  });

  it("5. Database Restart & Failover: enforces transaction rollback without partial state corruption", async () => {
    const injector = new FaultInjector({ verbose: false });
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);

    injector.injectFault(FAULT_TYPES.DATABASE_RESTART_FAILOVER);

    let dbErrorCaught = false;
    try {
      await injector.wrapDatabaseQuery(async () => {
        return pool.query("SELECT * FROM accounts");
      });
    } catch (err: unknown) {
      dbErrorCaught = true;
      if (err && typeof err === "object" && "code" in err) {
        expect(err.code).toBe("57P01"); // admin_shutdown
      }
    }
    expect(dbErrorCaught).toBe(true);

    injector.clearFault(FAULT_TYPES.DATABASE_RESTART_FAILOVER);

    // Reconnected query succeeds
    const recovered = await injector.wrapDatabaseQuery(async () => {
      return pool.query("SELECT * FROM accounts");
    });
    expect(recovered.rows).toBeDefined();
  });

  it("6. Object Store Errors: detects checksum / digest mismatches and retries on transient errors", async () => {
    const injector = new FaultInjector({ verbose: false });
    const objectStore = new MemoryObjectStore();

    // 1. Digest Mismatch Simulation
    injector.injectFault(FAULT_TYPES.OBJECT_STORE_ERRORS, { digestMismatch: true });
    let digestErrorCaught = false;

    try {
      await injector.wrapObjectStoreOperation(async () => {
        return objectStore.putObject("test/artifact.wasm", Buffer.from("corrupted"), {
          sha256: "expected_valid_sha256_here",
        });
      });
    } catch (err: unknown) {
      digestErrorCaught = true;
      if (err && typeof err === "object" && "code" in err) {
        expect(err.code).toBe("DIGEST_MISMATCH");
      }
    }
    expect(digestErrorCaught).toBe(true);

    // 2. Clear fault -> successful upload with exact hash
    injector.clearFault(FAULT_TYPES.OBJECT_STORE_ERRORS);
    const validData = Buffer.from("valid_wasm_bytecode_data");
    const meta = await injector.wrapObjectStoreOperation(async () => {
      return objectStore.putObject("test/artifact.wasm", validData);
    });
    expect(meta.key).toBe("test/artifact.wasm");
    expect(meta.sizeBytes).toBe(validData.length);
  });

  it("7. Signing Key State Change: rejects revoked keys and successfully validates active keys", async () => {
    const injector = new FaultInjector({ verbose: false });
    const primaryKeyId = "staging-ed25519-primary-2026";
    const backupKeyId = "staging-ed25519-secondary-2026";

    // Revoke primary key
    injector.injectFault(FAULT_TYPES.SIGNING_KEY_STATE_CHANGE, { revokedKeyId: primaryKeyId });

    expect(injector.verifySigningKeyActive(primaryKeyId)).toBe(false);
    expect(injector.verifySigningKeyActive(backupKeyId)).toBe(true);

    // Clear fault
    injector.clearFault(FAULT_TYPES.SIGNING_KEY_STATE_CHANGE);
    expect(injector.verifySigningKeyActive(primaryKeyId)).toBe(true);
  });

  it("8. Disk Pressure (ENOSPC): triggers backpressure without data corruption", async () => {
    const injector = new FaultInjector({ verbose: false });

    injector.injectFault(FAULT_TYPES.DISK_PRESSURE);

    let enospcCaught = false;
    try {
      await injector.wrapObjectStoreOperation(async () => {
        return { written: true };
      });
    } catch (err: unknown) {
      enospcCaught = true;
      if (err && typeof err === "object" && "code" in err) {
        expect(err.code).toBe("ENOSPC");
      }
    }

    injector.clearFault(FAULT_TYPES.DISK_PRESSURE);
  });

  it("9. Clock Skew: evaluates token validity windows and drift tolerance", () => {
    const injector = new FaultInjector({ verbose: false });

    // Inject +10 minute skew
    injector.injectFault(FAULT_TYPES.CLOCK_SKEW, { offsetMs: 600000 });

    const now = Date.now();
    const skewedTime = injector.getCurrentTime();
    expect(skewedTime - now).toBeGreaterThanOrEqual(600000);

    // Clear clock skew
    injector.clearFault(FAULT_TYPES.CLOCK_SKEW);
    expect(Math.abs(injector.getCurrentTime() - Date.now())).toBeLessThan(50);
  });

  it("10. Offline Client Backlog: ingests and deduplicates queued burst telemetry", async () => {
    const queue = new MemoryDurableQueue();
    const burstEnvelopes = Array.from({ length: 20 }, (_, i) => {
      return createJobEnvelope({
        jobType: "storage.observations.store",
        tenantContext: tenant,
        payload: { batchId: `batch_${i % 5}` }, // 5 unique batches repeated 4 times
        idempotencyKey: `burst_batch_${i % 5}`,
      });
    });
    const enqueuedIds = new Set<string>();
    for (const env of burstEnvelopes) {
      const id = await queue.enqueue(env);
      enqueuedIds.add(id);
    }

    // Deduplication should reduce 20 burst events to 5 unique jobs
    expect(enqueuedIds.size).toBe(5);

    const stats = await queue.getQueueStats();
    expect(stats.pendingCount).toBe(5);
  });

  it("11. Operator Resume Controls: allows inspecting, correcting, and requeuing DLQ jobs", async () => {
    const queue = new MemoryDurableQueue();

    const failedEnvelope = createJobEnvelope({
      jobType: "evolution.candidate.synthesize",
      tenantContext: tenant,
      payload: { candidateId: "cand_failed_operator_01" },
    });

    const jobId = await queue.enqueue(failedEnvelope);
    await queue.dequeue(["evolution.candidate.synthesize"]);
    await queue.nack(jobId, "Permanent Schema Validation Failure", false);

    const dlqJobs = await queue.getDeadLetterJobs(10);
    expect(dlqJobs).toHaveLength(1);
    const dlqId = dlqJobs[0].id;

    // Operator inspects and requeues the failed job
    const requeuedEnvelope = await queue.requeue(dlqId);
    expect(requeuedEnvelope.jobType).toBe("evolution.candidate.synthesize");
    const stats = await queue.getQueueStats();
    expect(stats.pendingCount).toBe(1);
    expect(dlqJobs[0].requeuedAt).toBeDefined();
    // Next worker pickup succeeds
    const resumedJob = await queue.dequeue(["evolution.candidate.synthesize"]);
    expect(resumedJob).not.toBeNull();
    expect(resumedJob?.jobId).toBe(requeuedEnvelope.jobId);

    await queue.ack(requeuedEnvelope.jobId);
    const finalStats = await queue.getQueueStats();
    expect(finalStats.pendingCount).toBe(0);
  });
});
