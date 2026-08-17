#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../config.js";
import { createCloudServer } from "../server/api.js";

async function main() {
  const config = loadConfig();
  const server = createCloudServer({ config });

  const port = await server.start();
  console.log(`[API] Cloud API Server listening on port ${port} (${config.server.host}:${port})`);

  const shutdown = async () => {
    console.log("[API] Stopping API server gracefully...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1]?.endsWith("api.js") || process.argv[1]?.endsWith("api.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
