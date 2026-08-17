#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../config.js";
import { createDatabasePool } from "../db/client.js";
import { createDurableQueue } from "../queue/queue.js";
import { WorkerRuntime } from "../queue/worker.js";

async function main() {
  const config = loadConfig();
  const pool = createDatabasePool(config.database);
  const queue = createDurableQueue(config.queue, pool);

  const worker = new WorkerRuntime(queue, {
    concurrency: config.queue.concurrency,
    pollIntervalMs: config.queue.pollIntervalMs,
    jobTimeoutMs: config.queue.visibilityTimeoutMs,
  });

  // Register default handlers
  worker.registerHandler("observation.process", async (job, signal) => {
    console.log(`[Worker] Processing observation for tenant ${job.tenantContext.accountId}:${job.tenantContext.workspaceId}`);
  });

  worker.registerHandler("evaluation.run", async (job, signal) => {
    console.log(`[Worker] Running evaluation for tenant ${job.tenantContext.accountId}`);
  });

  worker.registerHandler("artifact.sync", async (job, signal) => {
    console.log(`[Worker] Syncing artifact for tenant ${job.tenantContext.accountId}`);
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
