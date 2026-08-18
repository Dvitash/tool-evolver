import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MemoryDatabasePool, runMigrations } from "../src/db/index.js";
import { MemoryDurableQueue } from "../src/queue/index.js";
import { createCloudServer } from "../src/server/index.js";
import { MemoryObjectStore } from "../src/storage/index.js";

async function startServer(
  config = loadConfig({
    environment: "test",
    server: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "info",
      bodyLimitBytes: 1024,
      requestTimeoutMs: 5000,
      corsOrigins: ["https://allowed.example"],
    },
  }),
) {
  const dbPool = new MemoryDatabasePool();
  await runMigrations(dbPool);
  const server = createCloudServer({
    config,
    dbPool,
    objectStore: new MemoryObjectStore(),
    queue: new MemoryDurableQueue(),
  });
  const port = await server.start(0, "127.0.0.1");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await server.stop();
      await dbPool.end();
    },
  };
}

describe("Cloud production security hardening", () => {
  it("rejects insecure production configuration", () => {
    expect(() =>
      loadConfig({
        environment: "production",
        auth: {
          jwtSecret: "dev-jwt-secret-min-16-characters-long",
          deviceTokenSecret: "dev-device-token-secret-16-chars-long",
          issuer: "tool-evolver-cloud",
          audience: "tool-evolver-client",
          tokenTtlSeconds: 86400,
          allowDevAuth: true,
        },
      }),
    ).toThrow(/Unsafe production cloud configuration/);
  });

  it("does not accept development tenant headers in production", async () => {
    const config = loadConfig({
      environment: "production",
      database: {
        url: "postgres://service:strong-password@db.internal:5432/tool_evolver",
        host: "db.internal",
        port: 5432,
        database: "tool_evolver",
        user: "service",
        password: "strong-password",
        ssl: true,
        maxConnections: 20,
        idleTimeoutMs: 30000,
        connectionTimeoutMs: 5000,
      },
      storage: {
        provider: "s3",
        bucket: "tool-evolver-prod",
        region: "us-east-1",
        accessKeyId: "service-key",
        secretAccessKey: "service-secret",
        forcePathStyle: false,
      },
      queue: {
        provider: "postgres",
        concurrency: 10,
        pollIntervalMs: 1000,
        visibilityTimeoutMs: 30000,
        maxAttempts: 3,
        deadLetterThreshold: 3,
        backoffBaseMs: 1000,
      },
      auth: {
        jwtSecret: "production-jwt-secret-value-32-characters",
        deviceTokenSecret: "production-device-secret-value-32-chars",
        issuer: "tool-evolver-cloud",
        audience: "tool-evolver-client",
        tokenTtlSeconds: 3600,
        allowDevAuth: false,
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        logLevel: "info",
        bodyLimitBytes: 1024,
        requestTimeoutMs: 5000,
        corsOrigins: ["https://console.example"],
      },
    });
    const { baseUrl, stop } = await startServer(config);
    try {
      const response = await fetch(`${baseUrl}/v1/devices`, {
        headers: { "x-account-id": "victim", "x-workspace-id": "victim-workspace" },
      });
      expect(response.status).toBe(401);
    } finally {
      await stop();
    }
  });

  it("enforces request body limits and explicit CORS origins", async () => {
    const config = loadConfig({
      environment: "test",
      server: {
        host: "127.0.0.1",
        port: 0,
        logLevel: "info",
        bodyLimitBytes: 32,
        requestTimeoutMs: 5000,
        corsOrigins: ["https://allowed.example"],
      },
    });
    const { baseUrl, stop } = await startServer(config);
    try {
      const corsResponse = await fetch(`${baseUrl}/health/live`, {
        headers: { Origin: "https://evil.example" },
      });
      expect(corsResponse.headers.get("access-control-allow-origin")).toBeNull();
      const oversized = await fetch(`${baseUrl}/v1/accounts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-account-id": "acc-test",
          "x-workspace-id": "ws-test",
        },
        body: JSON.stringify({ data: "x".repeat(128) }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await stop();
    }
  });
});
