import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("production model configuration", () => {
  it("requires a configured provider and disables deterministic fallback", () => {
    expect(() =>
      loadConfig({
        environment: "production",
        database: {
          url: "postgres://app:strong-password@db.example.com:5432/tool_evolver",
          host: "db.example.com",
          port: 5432,
          database: "tool_evolver",
          user: "app",
          password: "strong-password",
          ssl: true,
          maxConnections: 20,
          idleTimeoutMs: 30000,
          connectionTimeoutMs: 5000,
        },
        storage: {
          provider: "s3",
          bucket: "artifacts",
          region: "us-east-1",
          accessKeyId: "key",
          secretAccessKey: "secret",
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
          jwtSecret: "production-jwt-secret-32-characters",
          deviceTokenSecret: "production-device-secret-32-chars",
          issuer: "tool-evolver",
          audience: "tool-evolver-client",
          tokenTtlSeconds: 3600,
          allowDevAuth: false,
        },
        models: {
          provider: "disabled",
          providerId: "primary",
          model: "model",
          timeoutMs: 30000,
          allowDeterministicFallback: true,
        },
        server: {
          host: "0.0.0.0",
          port: 8080,
          logLevel: "info",
          bodyLimitBytes: 1048576,
          requestTimeoutMs: 30000,
          corsOrigins: ["https://app.example.com"],
        },
      }),
    ).toThrow(/structured inference provider is disabled/);
  });
});
