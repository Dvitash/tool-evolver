import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { TelemetryBatchRequest, TelemetryBatchResponse } from "../../src/analytics/types.js";
import { createAuthService } from "../../src/auth/index.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool, runMigrations } from "../../src/db/index.js";
import { createCloudServer } from "../../src/server/index.js";

describe("Telemetry Ingestion HTTP API (POST /v1/telemetry/batch)", () => {
  const sampleBatch: TelemetryBatchRequest = {
    batchId: "batch_http_001",
    deviceId: "dev_http_1",
    installationId: "inst_http_1",
    workspaceId: "ws_http_1",
    timestamp: "2026-08-17T12:00:00.000Z",
    metrics: [
      {
        metricName: "tool.execution_duration_ms",
        value: 120,
        unit: "ms",
        tags: { toolId: "build_tool", version: "1.0.0", status: "success" },
        timestamp: "2026-08-17T12:00:00.000Z",
      },
    ],
    invocations: [
      {
        invocationId: "inv_http_1",
        sessionId: "sess_http_1",
        workspaceId: "ws_http_1",
        toolId: "build_tool",
        toolVersion: "1.0.0",
        startedAt: "2026-08-17T11:59:59.000Z",
        completedAt: "2026-08-17T12:00:00.000Z",
        durationMs: 1000,
        status: "success",
        inputDigest: "e".repeat(64),
      },
    ],
  };

  async function createTestServer() {
    const config = loadConfig({
      auth: { jwtSecret: "test-super-secret-key-32-chars-long!" },
      server: {
        port: 0,
        host: "127.0.0.1",
        logLevel: "info",
        bodyLimitBytes: 10485760,
        requestTimeoutMs: 5000,
        corsOrigins: ["*"],
      },
    });
    const dbPool = new MemoryDatabasePool();
    await runMigrations(dbPool);

    const authService = createAuthService({
      config: config.auth,
    });

    const server = createCloudServer({
      config,
      dbPool,
      authService,
    });

    const port = await server.start(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;

    const now = new Date();
    const { accessToken: token } = authService.tokens.issueAccessToken({
      accountId: "acc_http_1",
      workspaceId: "ws_http_1",
      deviceId: "dev_http_1",
      installationId: "inst_http_1",
      scopes: ["telemetry:write"],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    });

    return {
      server,
      authService,
      token,
      baseUrl,
      dbPool,
      stop: async () => {
        await server.stop();
        await dbPool.end();
      },
    };
  }

  it("should accept valid telemetry batch request with 200 OK", async () => {
    const { baseUrl, token, stop } = await createTestServer();

    try {
      const res = await fetch(`${baseUrl}/v1/telemetry/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sampleBatch),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TelemetryBatchResponse;
      expect(data.batchId).toBe(sampleBatch.batchId);
      expect(data.status).toBe("accepted");
      expect(data.processedCount).toBe(2);
    } finally {
      await stop();
    }
  });

  it("should decompress and accept gzip encoded telemetry payload", async () => {
    const { baseUrl, token, stop } = await createTestServer();

    try {
      const compressed = gzipSync(Buffer.from(JSON.stringify(sampleBatch)));

      const res = await fetch(`${baseUrl}/v1/telemetry/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          Authorization: `Bearer ${token}`,
        },
        body: compressed,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TelemetryBatchResponse;
      expect(data.batchId).toBe(sampleBatch.batchId);
    } finally {
      await stop();
    }
  });

  it("should reject request with 403 when token lacks telemetry:write scope", async () => {
    const { baseUrl, authService, stop } = await createTestServer();

    try {
      const now = new Date();
      const { accessToken: readOnlyToken } = authService.tokens.issueAccessToken({
        accountId: "acc_http_1",
        workspaceId: "ws_http_1",
        deviceId: "dev_http_1",
        installationId: "inst_http_1",
        scopes: ["catalog:read"],
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      });

      const res = await fetch(`${baseUrl}/v1/telemetry/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${readOnlyToken}`,
        },
        body: JSON.stringify(sampleBatch),
      });

      expect(res.status).toBe(403);
    } finally {
      await stop();
    }
  });

  it("should return 409 Conflict when batchId is reused with altered payload", async () => {
    const { baseUrl, token, stop } = await createTestServer();

    try {
      // 1. Initial submission
      const res1 = await fetch(`${baseUrl}/v1/telemetry/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sampleBatch),
      });
      expect(res1.status).toBe(200);

      // 2. Conflict submission
      const alteredBatch = {
        ...sampleBatch,
        metrics: [
          {
            metricName: "tool.execution_duration_ms",
            value: 9999, // Altered
            tags: { toolId: "build_tool" },
            timestamp: "2026-08-17T12:00:00.000Z",
          },
        ],
      };

      const res2 = await fetch(`${baseUrl}/v1/telemetry/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(alteredBatch),
      });
      expect(res2.status).toBe(409);
    } finally {
      await stop();
    }
  });

  it("should return 400 Bad Request when payload violates SchemaGuard", async () => {
    const { baseUrl, token, stop } = await createTestServer();

    try {
      const secretBatch = {
        ...sampleBatch,
        metrics: [
          {
            metricName: "tool.execution_duration_ms",
            value: 120,
            tags: {
              toolId: "build_tool",
              status: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M",
            },
            timestamp: "2026-08-17T12:00:00.000Z",
          },
        ],
      };

      const res = await fetch(`${baseUrl}/v1/telemetry/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(secretBatch),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; violations?: string[] };
      expect(data.error).toBe("SCHEMA_GUARD_VALIDATION_ERROR");
      expect(data.violations).toBeDefined();
    } finally {
      await stop();
    }
  });
});
