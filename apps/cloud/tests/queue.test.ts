import { describe, expect, it } from "vitest";
import {
  JobEnvelope,
  JobScheduler,
  MemoryDurableQueue,
  WorkerRuntime,
  createJobEnvelope,
  deserializeEnvelope,
  serializeEnvelope,
} from "../src/queue/index.js";

describe("Durable Queue, Worker Runtime & Scheduler", () => {
  it("should create, serialize, and deserialize versioned job envelopes", () => {
    const envelope = createJobEnvelope({
      jobType: "evolution.evaluate",
      version: "1.0.0",
      tenantContext: {
        accountId: "acc-1",
        workspaceId: "ws-1",
      },
      causationId: "cause-100",
      correlationId: "corr-200",
      payload: { candidateId: "cand-42", scoreThreshold: 0.95 },
      maxAttempts: 3,
    });

    expect(envelope.jobId).toBeDefined();
    expect(envelope.attempt).toBe(1);
    expect(envelope.maxAttempts).toBe(3);

    const serialized = serializeEnvelope(envelope);
    const deserialized = deserializeEnvelope<typeof envelope.payload>(serialized);

    expect(deserialized.jobId).toBe(envelope.jobId);
    expect(deserialized.payload.candidateId).toBe("cand-42");
    expect(deserialized.tenantContext.accountId).toBe("acc-1");
  });

  it("should enforce idempotency keys during enqueue", async () => {
    const queue = new MemoryDurableQueue();

    const env1 = createJobEnvelope({
      jobType: "sync.observations",
      tenantContext: { accountId: "acc-1", workspaceId: "ws-1" },
      idempotencyKey: "unique-key-12345",
      payload: { count: 10 },
    });

    const env2 = createJobEnvelope({
      jobType: "sync.observations",
      tenantContext: { accountId: "acc-1", workspaceId: "ws-1" },
      idempotencyKey: "unique-key-12345",
      payload: { count: 20 },
    });

    const id1 = await queue.enqueue(env1);
    const id2 = await queue.enqueue(env2);

    expect(id1).toBe(env1.jobId);
    expect(id2).toBe(env1.jobId); // Returned existing jobId

    const stats = await queue.getQueueStats();
    expect(stats.pendingCount).toBe(1);
  });

  it("should process jobs concurrently with WorkerRuntime", async () => {
    const queue = new MemoryDurableQueue();
    const worker = new WorkerRuntime(queue, {
      concurrency: 5,
      pollIntervalMs: 50,
    });

    const processedJobIds: string[] = [];

    worker.registerHandler("task.process", async (job) => {
      processedJobIds.push(job.jobId);
    });

    // Enqueue 3 jobs
    for (let i = 0; i < 3; i++) {
      const env = createJobEnvelope({
        jobType: "task.process",
        tenantContext: { accountId: "acc-1", workspaceId: "ws-1" },
        payload: { index: i },
      });
      await queue.enqueue(env);
    }

    worker.start();

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 250));
    await worker.stop();

    expect(processedJobIds.length).toBe(3);
    const stats = await queue.getQueueStats();
    expect(stats.pendingCount).toBe(0);
    expect(stats.processingCount).toBe(0);
  });

  it("should route poison messages to Dead Letter Queue (DLQ) after max attempts and allow requeue", async () => {
    const queue = new MemoryDurableQueue({ backoffBaseMs: 10 });
    const worker = new WorkerRuntime(queue, {
      concurrency: 2,
      pollIntervalMs: 20,
      jobTimeoutMs: 1000,
    });

    let attemptCounter = 0;

    worker.registerHandler("failing.task", async () => {
      attemptCounter++;
      throw new Error("Persistent database failure");
    });

    const env = createJobEnvelope({
      jobType: "failing.task",
      tenantContext: { accountId: "acc-fail", workspaceId: "ws-fail" },
      maxAttempts: 2,
      payload: { data: "poison" },
    });

    await queue.enqueue(env);
    worker.start();

    // Wait for all retries and DLQ routing
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.stop();

    expect(attemptCounter).toBe(2);

    const stats = await queue.getQueueStats();
    expect(stats.deadLetterCount).toBe(1);

    const dlqJobs = await queue.getDeadLetterJobs();
    expect(dlqJobs.length).toBe(1);
    expect(dlqJobs[0].originalJobId).toBe(env.jobId);
    expect(dlqJobs[0].failureReason).toContain("Persistent database failure");
    expect(dlqJobs[0].attempts).toBe(2);

    // Operator requeues job
    const freshJob = await queue.requeue(dlqJobs[0].id);
    expect(freshJob.jobId).not.toBe(env.jobId);
    expect(freshJob.attempt).toBe(1);

    const freshStats = await queue.getQueueStats();
    expect(freshStats.pendingCount).toBe(1);
  });

  it("should enforce worker job timeout with AbortController", async () => {
    const queue = new MemoryDurableQueue();
    const worker = new WorkerRuntime(queue, {
      concurrency: 1,
      pollIntervalMs: 20,
      jobTimeoutMs: 100, // 100ms timeout
    });

    let aborted = false;

    worker.registerHandler("long.task", async (_, signal) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve();
      });
      // Simulate long execution
      setTimeout(resolve, 500);
      return promise;
    });

    const env = createJobEnvelope({
      jobType: "long.task",
      tenantContext: { accountId: "acc-1", workspaceId: "ws-1" },
      payload: {},
    });

    await queue.enqueue(env);
    worker.start();

    await new Promise((resolve) => setTimeout(resolve, 250));
    await worker.stop();

    expect(aborted).toBe(true);
  });

  it("should run recurring jobs with JobScheduler", async () => {
    const scheduler = new JobScheduler();
    let tickCount = 0;

    scheduler.registerJob("test.heartbeat", 50, async () => {
      tickCount++;
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(tickCount).toBeGreaterThanOrEqual(2);

    // Manual trigger
    await scheduler.trigger("test.heartbeat");
    expect(tickCount).toBeGreaterThanOrEqual(3);

    const jobs = scheduler.getScheduledJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].name).toBe("test.heartbeat");
    expect(jobs[0].runCount).toBeGreaterThanOrEqual(3);
    expect(jobs[0].errorCount).toBe(0);

    scheduler.stop();
  });
});
