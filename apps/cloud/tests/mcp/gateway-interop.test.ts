/**
 * @tool-evolver/cloud - Gateway Interoperability & Wire Protocol Tests
 */

import { describe, expect, it } from "vitest";
import {
  CatalogSnapshotResponseSchema,
  type CatalogSnapshotResponse,
} from "@tool-evolver/protocol";
import {
  CloudCatalogService,
  CloudMcpServer,
  createCloudCatalogService,
  createCloudMcpServer,
} from "../../src/mcp/index.js";
import { createAuthService } from "../../src/auth/index.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool } from "../../src/db/index.js";
import { createCloudServer } from "../../src/server/index.js";

describe("Cloud MCP - Gateway Interoperability & Wire Protocol", () => {
  const config = loadConfig({
    server: { port: 0, host: "127.0.0.1", logLevel: "info", bodyLimitBytes: 1048576, requestTimeoutMs: 5000, cors: { origin: "*", allowHeaders: ["*"], allowMethods: ["*"] } },
    auth: { allowAnonymous: false, jwtSecret: "test-secret-at-least-32-chars-long-for-hmac", tokenTtlSeconds: 3600 },
  });

  const tenant = {
    accountId: "acc-gw-1",
    workspaceId: "ws-gw-1",
  };

  async function setupServer() {
    const dbPool = new MemoryDatabasePool();
    const authService = createAuthService({ config: config.auth });
    const catalogService = createCloudCatalogService({ dbPool });
    const mcpServer = createCloudMcpServer({ catalogService });

    const server = createCloudServer({
      config,
      dbPool,
      authService,
      catalogService,
      mcpServer,
    });

    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
      server,
      baseUrl,
      catalogService,
      mcpServer,
      stop: () => server.stop(),
    };
  }

  it("serves GET /v1/catalog/snapshot compliant with CatalogSnapshotResponseSchema", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/catalog/snapshot`, {
        method: "GET",
        headers: {
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as CatalogSnapshotResponse;

      const parsed = CatalogSnapshotResponseSchema.safeParse(json);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.tools.length).toBeGreaterThanOrEqual(4);
        expect(parsed.data.checksum).toBeDefined();
        expect(parsed.data.tools.map((t) => t.id)).toContain("get_evolution_status");
        expect(parsed.data.tools.map((t) => t.id)).toContain("get_tool_lineage");
      }
    } finally {
      await stop();
    }
  });

  it("serves POST /v1/catalog/snapshot with currentVersion and scope filtering", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/catalog/snapshot`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({
          currentVersion: "v0-none",
          filterScopes: ["platform"],
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = CatalogSnapshotResponseSchema.safeParse(json);
      expect(parsed.success).toBe(true);
    } finally {
      await stop();
    }
  });

  it("serves POST /v1/tools/invoke gateway compatibility endpoint", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/tools/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({
          toolId: "echo",
          arguments: { message: "Invoked via Gateway proxy forwarder" },
          context: {
            workspaceId: tenant.workspaceId,
            sessionId: "sess-gw-100",
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.isError).toBe(false);
      expect(json.content[0].type).toBe("text");

      const parsed = JSON.parse(json.content[0].text);
      expect(parsed.echoed).toBe("Invoked via Gateway proxy forwarder");
      expect(parsed.workspaceId).toBe(tenant.workspaceId);
    } finally {
      await stop();
    }
  });

  it("serves platform tools via /v1/tools/invoke returning typed JSON payload", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/tools/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({
          toolId: "get_evolution_status",
          arguments: { timeframe: "24h" },
          context: {
            workspaceId: tenant.workspaceId,
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.isError).toBe(false);

      const report = JSON.parse(json.content[0].text);
      expect(report.workspaceId).toBe(tenant.workspaceId);
      expect(report.observations).toBeDefined();
      expect(report.evaluation).toBeDefined();
      expect(report.deployments).toBeDefined();
    } finally {
      await stop();
    }
  });
});
