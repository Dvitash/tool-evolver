#!/usr/bin/env node
import process from "node:process";
import { createCloudService } from "../index.js";
import { createConfiguredBenchmarkEvidenceVerifier } from "../evolution/replay/benchmark-attestation.js";

async function main(): Promise<void> {
  const benchmarkEvidenceVerifier = createConfiguredBenchmarkEvidenceVerifier();
  const service = createCloudService({ benchmarkEvidenceVerifier });
  await service.initialize();

  console.log("[Worker] Durable cloud worker and scheduler started");

  const shutdown = async () => {
    console.log("[Worker] Shutting down gracefully...");
    await service.shutdown();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1]?.endsWith("worker.js") || process.argv[1]?.endsWith("worker.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
