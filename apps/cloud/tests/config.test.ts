import { describe, expect, it } from "vitest";
import { CloudConfigSchema, loadConfig, redactConfig, redactDatabaseUrl } from "../src/config.js";

describe("Cloud Configuration", () => {
  it("should load default configuration when no overrides are provided", () => {
    const config = loadConfig();

    expect(config.database.port).toBe(5432);
    expect(config.database.database).toBe("tool_evolver");
    expect(config.storage.provider).toBe("memory");
    expect(config.queue.provider).toBe("memory");
    expect(config.queue.concurrency).toBe(10);
    expect(config.auth.tokenTtlSeconds).toBe(86400);
    expect(config.server.port).toBe(8080);
    expect(config.server.logLevel).toBe("info");
  });

  it("should apply explicit configuration overrides", () => {
    const config = loadConfig({
      server: {
        port: 9090,
        host: "127.0.0.1",
        logLevel: "debug",
        bodyLimitBytes: 5242880,
        requestTimeoutMs: 15000,
        corsOrigins: ["https://example.com"],
      },
      queue: {
        provider: "memory",
        concurrency: 25,
        pollIntervalMs: 500,
        visibilityTimeoutMs: 15000,
        maxAttempts: 5,
        deadLetterThreshold: 5,
        backoffBaseMs: 2000,
      },
    });

    expect(config.server.port).toBe(9090);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.logLevel).toBe("debug");
    expect(config.queue.concurrency).toBe(25);
    expect(config.queue.maxAttempts).toBe(5);
  });

  it("should redact sensitive fields in redactConfig", () => {
    const config = loadConfig({
      database: {
        url: "postgres://myuser:secretpassword123@db.example.com:5432/mydb",
        host: "db.example.com",
        port: 5432,
        database: "mydb",
        user: "myuser",
        password: "secretpassword123",
        ssl: true,
        maxConnections: 10,
        idleTimeoutMs: 10000,
        connectionTimeoutMs: 2000,
      },
      storage: {
        provider: "s3",
        bucket: "my-bucket",
        region: "us-west-2",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        forcePathStyle: false,
      },
      auth: {
        jwtSecret: "super-secret-jwt-key-32-chars-long",
        deviceTokenSecret: "super-secret-device-token-32-chars",
        issuer: "test-issuer",
        audience: "test-aud",
        tokenTtlSeconds: 3600,
      },
    });

    const redacted = redactConfig(config);

    expect(redacted.database.password).toBe("[REDACTED]");
    expect(redacted.database.url).toContain("myuser:******@db.example.com");
    expect(redacted.storage.secretAccessKey).toBe("[REDACTED]");
    expect(redacted.storage.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(redacted.auth.jwtSecret).toBe("[REDACTED]");
    expect(redacted.auth.deviceTokenSecret).toBe("[REDACTED]");
    expect(redacted.server.port).toBe(8080);
  });

  it("should mask credentials from database URLs properly", () => {
    const masked = redactDatabaseUrl("postgresql://admin:supersecret@10.0.0.1:5432/evolver");
    expect(masked).not.toContain("supersecret");
    expect(masked).toContain("admin:******@10.0.0.1:5432/evolver");
  });

  it("should throw validation error on invalid configuration parameters", () => {
    expect(() => {
      CloudConfigSchema.parse({
        database: { port: -1 },
        storage: {},
        queue: {},
        auth: {},
        server: {},
      });
    }).toThrow();
  });
});
