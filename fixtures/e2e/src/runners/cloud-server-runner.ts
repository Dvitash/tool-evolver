#!/usr/bin/env node
/**
 * @tool-evolver/e2e - Cloud Server Process Runner
 *
 * Executable entrypoint that boots a real, production-equivalent Cloud Service
 * in a dedicated OS subprocess with DB migrations, durable queue worker,
 * scheduler, outbox publisher, and HTTP API endpoints.
 */

import fs from "node:fs";
import process from "node:process";
import { HmacBenchmarkEvidenceVerifier, OpenAiCompatibleProvider, createCloudService } from "@tool-evolver/cloud";

function parseArgs(args: string[]): {
  port: number;
  storageDir?: string;
  inferenceUrl?: string;
  dbUrl?: string;
} {
  let port = Number.parseInt(process.env.PORT ?? "0", 10);
  let storageDir = process.env.STORAGE_DIR;
  let inferenceUrl = process.env.INFERENCE_BASE_URL;
  let dbUrl = process.env.DATABASE_URL ?? "memory://e2e-cloud-db";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && i + 1 < args.length) {
      port = Number.parseInt(args[++i], 10);
    } else if (arg === "--storage-dir" && i + 1 < args.length) {
      storageDir = args[++i];
    } else if (arg === "--inference-url" && i + 1 < args.length) {
      inferenceUrl = args[++i];
    } else if (arg === "--db-url" && i + 1 < args.length) {
      dbUrl = args[++i];
    }
  }

  return { port, storageDir, inferenceUrl, dbUrl };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.storageDir && !fs.existsSync(options.storageDir)) {
    fs.mkdirSync(options.storageDir, { recursive: true });
  }

  // Deterministic benchmark attestation verifier for E2E (secret never logged)
  const e2eBenchmarkSecret =
    process.env.E2E_BENCHMARK_SECRET ?? "e2e-deterministic-hmac-secret-32-bytes-long-2024!!";
  const e2eBenchmarkVerifier = new HmacBenchmarkEvidenceVerifier({
    issuer: "e2e-test-issuer",
    keyId: "e2e-test-key-1",
    secret: e2eBenchmarkSecret,
  });
  const cloudService = createCloudService({
    config: {
      server: {
        port: options.port,
        host: "127.0.0.1",
      },
      storage: {
        provider: "memory",
        bucket: "e2e-artifacts",
      },
      database: {
        url: options.dbUrl ?? "memory://e2e-cloud-db",
      },
    },
    benchmarkEvidenceVerifier: e2eBenchmarkVerifier,
  });

  // If mock inference URL is provided, register OpenAiCompatibleProvider in the model router
  if (options.inferenceUrl) {
    const mockProvider = new OpenAiCompatibleProvider({
      id: "mock-openai-http",
      name: "Mock OpenAI HTTP Provider",
      baseUrl: options.inferenceUrl,
      defaultModel: "gpt-4o",
    });
    cloudService.inferenceService.router.registerProvider(mockProvider);
  }

  const port = await cloudService.start(options.port);
  process.stdout.write(`[CLOUD_SERVICE_READY:${port}]\n`);

  const shutdown = async () => {
    process.stdout.write("[CLOUD_SERVICE_STOPPING]\n");
    await cloudService.shutdown();
    process.stdout.write("[CLOUD_SERVICE_STOPPED]\n");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error in Cloud Server Runner: ${(err as Error).message}\n`);
  process.exit(1);
});
