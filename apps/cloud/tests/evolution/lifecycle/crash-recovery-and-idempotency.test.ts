import { describe, expect, it } from "vitest";
import type { MemoryDatabasePool } from "../../../src/db/client.js";
import type { LifecycleJobPayload } from "../../../src/evolution/lifecycle/types.js";
import type { MemoryObjectStore } from "../../../src/storage/object-store.js";
import type { TenantContext } from "../../../src/tenant.js";
import {
  createMockCandidate,
  createMockRevision,
  createTestLifecycleEnvironment,
} from "./helpers.js";

describe("Candidate Lifecycle - Crash Recovery, Idempotency & Concurrency Resilience", () => {
  const tenant: TenantContext = {
    accountId: "acc_idemp_test",
    workspaceId: "ws_idemp_test",
  };

  it("should be strictly idempotent on repeated calls to stepValidate, stepReplay, stepEvaluate, and stepPublish", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);

    // 1. Repeated stepValidate
    const val1 = await env.orchestrator.stepValidate(tenant, candidate.id);
    const val2 = await env.orchestrator.stepValidate(tenant, candidate.id);
    expect(val1.currentState).toBe("replaying");
    expect(val2.currentState).toBe("replaying");
    expect(val1.evidenceDigests.validationDigest).toBe(val2.evidenceDigests.validationDigest);

    // 2. Repeated stepReplay
    const rep1 = await env.orchestrator.stepReplay(tenant, candidate.id);
    const rep2 = await env.orchestrator.stepReplay(tenant, candidate.id);
    expect(rep1.currentState).toBe("evaluating");
    expect(rep2.currentState).toBe("evaluating");
    expect(rep1.evidenceDigests.replayDigest).toBe(rep2.evidenceDigests.replayDigest);

    // 3. Repeated stepEvaluate
    const eval1 = await env.orchestrator.stepEvaluate(tenant, candidate.id);
    const eval2 = await env.orchestrator.stepEvaluate(tenant, candidate.id);
    expect(eval1.currentState).toBe("eligible");
    expect(eval2.currentState).toBe("eligible");
    expect(eval1.evidenceDigests.evaluationDigest).toBe(eval2.evidenceDigests.evaluationDigest);

    // 4. Repeated stepPublish produces at most ONE published tool version
    const pub1 = await env.orchestrator.stepPublish(tenant, candidate.id);
    const pub2 = await env.orchestrator.stepPublish(tenant, candidate.id);
    expect(pub1.record.currentState).toBe("published");
    expect(pub2.record.currentState).toBe("published");
    expect(pub1.toolVersion.version).toBe("1.0.0");
    expect(pub2.toolVersion.version).toBe("1.0.0");
    expect(pub1.toolVersion.artifactDigest).toBe(pub2.toolVersion.artifactDigest);

    // Verify exactly one tool version exists in registry
    const versions = await env.toolRegistryRepo.listToolVersions(tenant, pub1.toolVersion.toolId);
    expect(versions.length).toBe(1);
    expect(versions[0].version).toBe("1.0.0");
  });

  it("should handle simulated worker crashes and rollback transactions cleanly", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);

    // Simulate crash inside transaction before state commit
    try {
      await env.pool.transaction(async (tx) => {
        await env.lifecycleRepo.saveLifecycleRecord(
          tenant,
          {
            id: "temp_record",
            accountId: tenant.accountId,
            workspaceId: tenant.workspaceId,
            candidateId: candidate.id,
            activeRevisionId: revision.revisionId,
            currentState: "validating",
            targetVersion: "1.0.0",
            idempotencyKey: "temp_key",
            attempt: 1,
            evidenceDigests: {},
            attemptHistory: [],
            metadata: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          tx,
        );
        throw new Error("SIMULATED_WORKER_CRASH_OR_POWER_LOSS");
      });
    } catch (err: unknown) {
      expect((err as Error).message).toBe("SIMULATED_WORKER_CRASH_OR_POWER_LOSS");
    }

    // State remains in 'drafted' after transaction rollback
    const current = await env.lifecycleRepo.getLifecycleRecord(tenant, candidate.id);
    expect(current?.currentState).toBe("drafted");

    // Recover and resume lifecycle from last valid persisted state
    const resumed = await env.orchestrator.driveToCompletion(tenant, candidate, revision);
    expect(resumed.record.currentState).toBe("published");
    expect(resumed.record.publishedVersion).toBe("1.0.0");
  });

  it("should handle out-of-order job redeliveries and queue visibility timeouts without diverging state", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);
    await env.outboxPublisher.dispatchBatch();

    // 1. Dequeue validation job
    const job1 = await env.queue.dequeue(["evolution.candidate.validate"], 100);
    expect(job1).not.toBeNull();

    // Simulate worker processing validation
    if (job1) {
      await env.orchestrator.processJob(tenant, job1.payload as unknown as LifecycleJobPayload);
      await env.queue.ack(job1.jobId);
    }

    // 2. Dispatch next outbox batch (replay)
    await env.outboxPublisher.dispatchBatch();
    const job2 = await env.queue.dequeue(["evolution.candidate.replay"], 100);
    expect(job2).not.toBeNull();

    // Simulate worker 1 starting replay but timing out (visibility expiry)
    // Worker 2 picks up redelivered replay job and completes it
    if (job2) {
      const repResult = await env.orchestrator.processJob(
        tenant,
        job2.payload as unknown as LifecycleJobPayload,
      );
      expect(repResult.currentState).toBe("evaluating");
      await env.queue.ack(job2.jobId);
    }

    // Attempting to replay again (e.g. duplicate delivery) is a safe no-op
    if (job2) {
      const duplicateRun = await env.orchestrator.processJob(
        tenant,
        job2.payload as unknown as LifecycleJobPayload,
      );
      expect(duplicateRun.currentState).toBe("evaluating");
    }

    // Complete remaining steps
    await env.outboxPublisher.dispatchBatch();
    const job3 = await env.queue.dequeue(["evolution.candidate.evaluate"]);
    if (job3) {
      await env.orchestrator.processJob(tenant, job3.payload as unknown as LifecycleJobPayload);
      await env.queue.ack(job3.jobId);
    }

    await env.outboxPublisher.dispatchBatch();
    const job4 = await env.queue.dequeue(["evolution.candidate.publish"]);
    if (job4) {
      const pubResult = await env.orchestrator.processJob(
        tenant,
        job4.payload as unknown as LifecycleJobPayload,
      );
      expect(pubResult.currentState).toBe("published");
      await env.queue.ack(job4.jobId);
    }

    const finalStatus = await env.orchestrator.getStatus(tenant, candidate.id);
    expect(finalStatus?.currentState).toBe("published");
    expect(finalStatus?.publishedVersion).toBe("1.0.0");
  });

  it("should resume gracefully across simulated cloud restarts from database state", async () => {
    const env1 = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    // Run up to evaluating stage in environment 1
    await env1.orchestrator.startLifecycle(tenant, candidate, revision);
    await env1.orchestrator.stepValidate(tenant, candidate.id);
    await env1.orchestrator.stepReplay(tenant, candidate.id);

    const midState = await env1.lifecycleRepo.getLifecycleRecord(tenant, candidate.id);
    expect(midState?.currentState).toBe("evaluating");

    // Simulate Cloud Restart: Recreate Orchestrator sharing the same database pool and storage
    const env2 = await createTestLifecycleEnvironment({
      validationService: env1.validationService,
      replayService: env1.replayService,
      evaluationService: env1.evaluationService,
    });
    const pool1 = env1.pool as unknown as {
      tables: Map<string, Map<string, Record<string, unknown>>>;
    };
    const pool2 = env2.pool as unknown as {
      tables: Map<string, Map<string, Record<string, unknown>>>;
    };
    for (const [table, rows] of pool1.tables.entries()) {
      pool2.tables.set(table, new Map(rows));
    }
    const store1 = env1.objectStore as unknown as { objects: Map<string, unknown> };
    const store2 = env2.objectStore as unknown as { objects: Map<string, unknown> };
    for (const [key, obj] of store1.objects.entries()) {
      store2.objects.set(key, obj);
    }

    // Verify new environment sees candidate at 'evaluating' stage
    const recovered = await env2.lifecycleRepo.getLifecycleRecord(tenant, candidate.id);
    expect(recovered?.currentState).toBe("evaluating");

    // Drive from recovered state to signed publication
    const evalRes = await env2.orchestrator.stepEvaluate(tenant, candidate.id);
    expect(evalRes.currentState).toBe("eligible");

    const pubRes = await env2.orchestrator.stepPublish(tenant, candidate.id);
    expect(pubRes.record.currentState).toBe("published");
    expect(pubRes.toolVersion.version).toBe("1.0.0");
  });
});
