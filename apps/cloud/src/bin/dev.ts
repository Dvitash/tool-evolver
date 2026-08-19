#!/usr/bin/env node
import process from "node:process";
import { createCloudService } from "../index.js";

async function main() {
  console.log("[dev] Starting Tool Evolver cloud backend");
  console.log(`[dev] NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);
  console.log(`[dev] LOG_LEVEL=${process.env.LOG_LEVEL ?? "info"}`);
  console.log(`[dev] cwd=${process.cwd()}`);

  const cloud = createCloudService();
  const port = await cloud.start();
  console.log(
    `[dev] Cloud backend listening on ${cloud.config.server.host}:${port} (logLevel=${cloud.config.server.logLevel})`,
  );
  console.log("[dev] HTTP API, worker, scheduler, and inference provider are running");

  const shutdown = async (signal: string) => {
    console.log(`[dev] ${signal} received; stopping cloud backend...`);
    await cloud.stop();
    console.log("[dev] Cloud backend stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (process.argv[1]?.endsWith("dev.js") || process.argv[1]?.endsWith("dev.ts")) {
  main().catch((err) => {
    console.error("[dev] fatal error", err);
    process.exit(1);
  });
}
