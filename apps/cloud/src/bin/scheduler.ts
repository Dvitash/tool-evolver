#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../config.js";
import { createDatabasePool } from "../db/client.js";
import { OutboxPublisher } from "../db/outbox.js";
import { JobScheduler } from "../queue/scheduler.js";

async function main() {
  const config = loadConfig();
  const pool = createDatabasePool(config.database);
  const outboxPublisher = new OutboxPublisher(pool);
  const scheduler = new JobScheduler();

  // Register outbox dispatch job
  scheduler.registerJob("outbox.dispatch", 2000, async () => {
    const dispatched = await outboxPublisher.dispatchBatch(50);
    if (dispatched > 0) {
      console.log(`[Scheduler] Dispatched ${dispatched} pending outbox event(s)`);
    }
  });

  // Register health logging
  scheduler.registerJob("health.heartbeat", 30000, async () => {
    console.log(`[Scheduler] Heartbeat OK - DB Connected: ${pool.isConnected()}`);
  });

  console.log("[Scheduler] Starting periodic background scheduler...");
  scheduler.start();

  const shutdown = async () => {
    console.log("[Scheduler] Shutting down scheduler...");
    scheduler.stop();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1]?.endsWith("scheduler.js") || process.argv[1]?.endsWith("scheduler.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
