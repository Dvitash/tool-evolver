import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DaemonConfigSchema,
  IMMUTABLE_CONFIG_FIELDS,
  loadDaemonConfig,
  parseEnvConfig,
  redactConfig,
  redactSensitiveData,
  validateConfigUpdate,
} from "../src/config.js";

describe("config", () => {
  describe("DaemonConfigSchema defaults and validation", () => {
    it("provides expected default values", () => {
      const config = DaemonConfigSchema.parse({});
      expect(config.version).toBe("0.1.0");
      expect(config.logLevel).toBe("info");
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(9400);
      expect(config.cloudUrl).toBe("https://api.tool-evolver.dev");
      expect(config.cloudSyncEnabled).toBe(false);
      expect(config.telemetryEnabled).toBe(false);
      expect(config.heartbeatIntervalMs).toBe(3000);
      expect(config.lockStaleThresholdMs).toBe(15000);
      expect(config.shutdownTimeoutMs).toBe(10000);
      expect(config.maxWorkerMemoryMb).toBe(512);
      expect(config.workerExecutionTimeoutMs).toBe(30000);
    });

    it("rejects invalid port numbers", () => {
      expect(() => DaemonConfigSchema.parse({ port: -1 })).toThrow();
      expect(() => DaemonConfigSchema.parse({ port: 70000 })).toThrow();
    });

    it("rejects invalid log levels", () => {
      expect(() => DaemonConfigSchema.parse({ logLevel: "invalid_level" })).toThrow();
    });
  });

  describe("parseEnvConfig", () => {
    it("parses and maps TOOL_EVOLVER_* environment variables", () => {
      const mockEnv: Record<string, string> = {
        TOOL_EVOLVER_LOG_LEVEL: "debug",
        TOOL_EVOLVER_HOST: "0.0.0.0",
        TOOL_EVOLVER_PORT: "8080",
        TOOL_EVOLVER_SOCKET_PATH: "/custom/socket.sock",
        TOOL_EVOLVER_AUTH_TOKEN: "secret-token-123",
        TOOL_EVOLVER_CLOUD_URL: "https://cloud.custom.dev",
        TOOL_EVOLVER_CLOUD_API_KEY: "cloud-key-456",
        TOOL_EVOLVER_CLOUD_SYNC_ENABLED: "true",
        TOOL_EVOLVER_TELEMETRY_ENABLED: "1",
        TOOL_EVOLVER_STORAGE_DIR: "/custom/storage",
        TOOL_EVOLVER_SHUTDOWN_TIMEOUT_MS: "5000",
        TOOL_EVOLVER_MAX_WORKER_MEMORY_MB: "1024",
        TOOL_EVOLVER_WORKER_EXECUTION_TIMEOUT_MS: "60000",
      };

      const parsed = parseEnvConfig(mockEnv);

      expect(parsed.logLevel).toBe("debug");
      expect(parsed.host).toBe("0.0.0.0");
      expect(parsed.port).toBe(8080);
      expect(parsed.socketPath).toBe("/custom/socket.sock");
      expect(parsed.authToken).toBe("secret-token-123");
      expect(parsed.cloudUrl).toBe("https://cloud.custom.dev");
      expect(parsed.cloudApiKey).toBe("cloud-key-456");
      expect(parsed.cloudSyncEnabled).toBe(true);
      expect(parsed.telemetryEnabled).toBe(true);
      expect(parsed.storageDir).toBe("/custom/storage");
      expect(parsed.shutdownTimeoutMs).toBe(5000);
      expect(parsed.maxWorkerMemoryMb).toBe(1024);
      expect(parsed.workerExecutionTimeoutMs).toBe(60000);
    });
  });

  describe("loadDaemonConfig", () => {
    it("merges file config with defaults and env overrides", async () => {
      const tempDir = path.join(os.tmpdir(), `te-config-test-${Date.now()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });
      const configPath = path.join(tempDir, "config.json");

      const fileData = {
        port: 9500,
        logLevel: "warn",
        cloudSyncEnabled: true,
      };
      await fs.promises.writeFile(configPath, JSON.stringify(fileData), "utf-8");

      const mockEnv: Record<string, string> = {
        TOOL_EVOLVER_LOG_LEVEL: "error", // Env overrides file
      };

      const config = loadDaemonConfig({
        configPath,
        env: mockEnv,
        overrides: { port: 9600 }, // Explicit overrides take highest priority
      });

      expect(config.port).toBe(9600);
      expect(config.logLevel).toBe("error");
      expect(config.cloudSyncEnabled).toBe(true);
      expect(config.version).toBe("0.1.0"); // Default

      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe("Secret Redaction", () => {
    it("redacts sensitive fields in DaemonConfig", () => {
      const config = DaemonConfigSchema.parse({
        authToken: "super-secret-auth-token",
        cloudApiKey: "sensitive-cloud-api-key",
        moduleConfigs: {
          database: {
            password: "db-secret-password",
            host: "localhost",
          },
        },
        custom: {
          apiKey: "custom-api-key-value",
          normalField: "public-value",
        },
      });

      const redacted = redactConfig(config);

      expect(redacted.authToken).toBe("[REDACTED]");
      expect(redacted.cloudApiKey).toBe("[REDACTED]");
      expect(redacted.port).toBe(9400);

      const dbModule = (redacted.moduleConfigs as Record<string, unknown>).database as Record<
        string,
        unknown
      >;
      expect(dbModule.password).toBe("[REDACTED]");
      expect(dbModule.host).toBe("localhost");

      const customObj = redacted.custom as Record<string, unknown>;
      expect(customObj.apiKey).toBe("[REDACTED]");
      expect(customObj.normalField).toBe("public-value");
    });

    it("handles primitives and null in redactSensitiveData", () => {
      expect(redactSensitiveData(null)).toBe(null);
      expect(redactSensitiveData(undefined)).toBe(undefined);
      expect(redactSensitiveData(123)).toBe(123);
      expect(redactSensitiveData("test")).toBe("test");
    });
  });

  describe("validateConfigUpdate", () => {
    it("allows valid mutable updates", () => {
      const current = DaemonConfigSchema.parse({});
      const update = {
        logLevel: "debug" as const,
        port: 9800,
        cloudSyncEnabled: true,
      };

      const result = validateConfigUpdate(current, update);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.updatedConfig?.logLevel).toBe("debug");
      expect(result.updatedConfig?.port).toBe(9800);
      expect(result.updatedConfig?.cloudSyncEnabled).toBe(true);
    });

    it("rejects modifications to immutable fields", () => {
      const current = DaemonConfigSchema.parse({
        version: "0.1.0",
        storageDir: "/var/lib/storage",
        socketPath: "/run/daemon.sock",
      });

      for (const field of IMMUTABLE_CONFIG_FIELDS) {
        const update = { [field]: "modified-value" };
        const result = validateConfigUpdate(current, update);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes(field))).toBe(true);
      }
    });

    it("rejects updates that violate schema", () => {
      const current = DaemonConfigSchema.parse({});
      const update = {
        port: 999999, // Invalid port
      };

      const result = validateConfigUpdate(current, update);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
