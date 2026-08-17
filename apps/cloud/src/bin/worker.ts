#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../config.js";
import { createDatabasePool } from "../db/client.js";
import type { JobEnvelope } from "../queue/envelope.js";
import { createDurableQueue } from "../queue/queue.js";
import { WorkerRuntime } from "../queue/worker.js";
import {
  StoreObservationBatchConsumer,
  type StoreObservationBatchPayload,
} from "../storage/index.js";
import { createOpportunityDetectionService } from "../evolution/opportunity/index.js";

async function main() {
  const config = loadConfig();
  const pool = createDatabasePool(config.database);
  const queue = createDurableQueue(config.queue, pool);

  const worker = new WorkerRuntime(queue, {
    concurrency: config.queue.concurrency,
    pollIntervalMs: config.queue.pollIntervalMs,
    jobTimeoutMs: config.queue.visibilityTimeoutMs,
  });

  const obsConsumer = new StoreObservationBatchConsumer(pool);
  const opportunityService = createOpportunityDetectionService();

  // Register handlers
  worker.registerHandler("store-observation-batch", async (job) => {
    const typedJob = job as unknown as JobEnvelope<StoreObservationBatchPayload>;
    await obsConsumer.processJob(typedJob);
  });

  worker.registerHandler("observation.process", async (job) => {
    console.log(`[Worker] Processing observation for tenant ${job.tenantContext.accountId}:${job.tenantContext.workspaceId}`);
  });

  worker.registerHandler("evaluation.run", async (job) => {
    console.log(`[Worker] Running evaluation for tenant ${job.tenantContext.accountId}`);
  });

  worker.registerHandler("artifact.sync", async (job) => {
    console.log(`[Worker] Syncing artifact for tenant ${job.tenantContext.accountId}`);
  });

  worker.registerHandler("opportunity.detect", async (job) => {
    console.log(`[Worker] Running opportunity detection for tenant ${job.tenantContext.accountId}:${job.tenantContext.workspaceId}`);
  });

  console.log(`[Worker] Starting durable queue worker with concurrency ${config.queue.concurrency}...`);
  worker.start();

  const shutdown = async () => {
    console.log("[Worker] Shutting down gracefully...");
    await worker.stop();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1]?.endsWith("worker.js") || process.argv[1]?.endsWith("worker.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
