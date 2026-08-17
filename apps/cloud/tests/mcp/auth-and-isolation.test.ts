/**
 * @tool-evolver/cloud - Tenant Isolation & Authentication Security Tests
 */

import { describe, expect, it } from "vitest";
import { createAuthService } from "../../src/auth/index.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool } from "../../src/db/index.js";
import {
  CloudCatalogService,
  CloudMcpServer,
  MCP_ERROR_CODES,
  createCloudCatalogService,
  createCloudMcpServer,
} from "../../src/mcp/index.js";
import { createCloudServer } from "../../src/server/index.js";

describe("Cloud MCP - Tenant Isolation & Authentication Security", () => {
  const config = loadConfig({
    server: {
      port: 0,
      host: "127.0.0.1",
      logLevel: "info",
      bodyLimitBytes: 1048576,
      requestTimeoutMs: 5000,
      cors: { origin: "*", allowHeaders: ["*"], allowMethods: ["*"] },
    },
    auth: {
      allowAnonymous: false,
      jwtSecret: "test-secret-at-least-32-chars-long-for-hmac",
      tokenTtlSeconds: 3600,
    },
  });

  const tenantA = {
    accountId: "acc-alpha",
    workspaceId: "ws-alpha",
  };

  const tenantB = {
    accountId: "acc-beta",
    workspaceId: "ws-beta",
  };

  async function setupServer() {
    const dbPool = new MemoryDatabasePool();
    const authService = createAuthService({ config: config.auth });
    const catalogService = createCloudCatalogService({ dbPool });

    // Register a custom tool scoped to workspace A
    catalogService.registerTool({
      name: "secret_alpha_tool",
      description: "Secret tool belonging only to workspace alpha",
      source: "registry",
      scope: "workspace",
      manifest: {
        id: "secret_alpha_tool",
        name: "secret_alpha_tool",
        version: "1.0.0",
        description: "Secret tool belonging only to workspace alpha",
        schemaVersion: "1.0.0",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        runtime: {
          runtime: "builtin",
          timeoutMs: 30000,
          memoryLimitMb: 128,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 1048576,
        },
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: [],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 10485760,
          },
          net: {
            allowOutbound: false,
            allowedDomains: [],
            allowedHosts: [],
            allowedPorts: [],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
          command: {
            allowShellExecution: false,
            allowedCommands: [],
            allowedBinaries: [],
            forbiddenPatterns: [],
            allowEnvPassthrough: [],
          },
          secrets: {
            allowedSecretNames: [],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
          limits: {
            maxConcurrentExecutions: 4,
            maxCpuUsagePercent: 100,
            maxMemoryMb: 128,
            maxExecutionTimeMs: 30000,
            maxOutputSizeBytes: 1048576,
          },
        },
        limits: {
          timeoutMs: 30000,
          maxOutputBytes: 1048576,
          maxMemoryBytes: 134217728,
          maxConcurrentInvocations: 4,
        },
        scope: "workspace",
        digest: `sha256:${"a".repeat(64)}`,
        metadata: {
          workspaceId: "ws-alpha",
        },
        createdAt: new Date().toISOString(),
      },
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({
        content: [{ type: "text", text: "Alpha secret data" }],
        isError: false,
      }),
    });

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

  it("rejects anonymous requests with 401 Unauthorized", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      });

      expect(res.status).toBe(401);
    } finally {
      await stop();
    }
  });

  it("isolates workspace-scoped tools in tools/list", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      // 1. Query tools/list as Tenant A
      const resA = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenantA.accountId,
          "x-workspace-id": tenantA.workspaceId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "list-a",
          method: "tools/list",
        }),
      });

      expect(resA.status).toBe(200);
      const jsonA = await resA.json();
      const namesA = jsonA.result.tools.map((t: { name: string }) => t.name);
      expect(namesA).toContain("secret_alpha_tool");
      expect(namesA).toContain("echo");

      // 2. Query tools/list as Tenant B
      const resB = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenantB.accountId,
          "x-workspace-id": tenantB.workspaceId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "list-b",
          method: "tools/list",
        }),
      });

      expect(resB.status).toBe(200);
      const jsonB = await resB.json();
      const namesB = jsonB.result.tools.map((t: { name: string }) => t.name);
      // Tenant B MUST NOT see Tenant A's private tool
      expect(namesB).not.toContain("secret_alpha_tool");
      expect(namesB).toContain("echo");
    } finally {
      await stop();
    }
  });

  it("denies cross-tenant invocation of workspace-scoped tool", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      // Tenant B tries to call secret_alpha_tool
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenantB.accountId,
          "x-workspace-id": tenantB.workspaceId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "call-unauthorized",
          method: "tools/call",
          params: {
            name: "secret_alpha_tool",
            arguments: {},
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(MCP_ERROR_CODES.RESOURCE_NOT_FOUND);
      expect(json.error.message).toContain("not found in workspace 'ws-beta'");
    } finally {
      await stop();
    }
  });

  it("denies cross-tenant workspace querying in get_evolution_status", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      // Tenant B attempts to request status for workspace alpha
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenantB.accountId,
          "x-workspace-id": tenantB.workspaceId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "status-cross-tenant",
          method: "tools/call",
          params: {
            name: "get_evolution_status",
            arguments: {
              workspaceId: "ws-alpha", // Trying to peek at ws-alpha
            },
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(MCP_ERROR_CODES.RESOURCE_NOT_FOUND);
      expect(json.error.message).toContain(
        "Access denied: Cannot query status for workspace 'ws-alpha'",
      );
    } finally {
      await stop();
    }
  });

  it("denies cross-tenant lineage querying in get_tool_lineage", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      // Tenant B attempts to request lineage for workspace alpha
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenantB.accountId,
          "x-workspace-id": tenantB.workspaceId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "lineage-cross-tenant",
          method: "tools/call",
          params: {
            name: "get_tool_lineage",
            arguments: {
              toolId: "secret_alpha_tool",
              workspaceId: "ws-alpha",
            },
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(MCP_ERROR_CODES.RESOURCE_NOT_FOUND);
      expect(json.error.message).toContain(
        "Access denied: Cannot query tool lineage for workspace 'ws-alpha'",
      );
    } finally {
      await stop();
    }
  });
});
