/**
 * @tool-evolver/cloud - Cloud MCP Server & Protocol Tests
 */

import { describe, expect, it } from "vitest";
import {
  CloudCatalogService,
  CloudMcpServer,
  MCP_ERROR_CODES,
  createCloudCatalogService,
  createCloudMcpServer,
} from "../../src/mcp/index.js";
import { createAuthService } from "../../src/auth/index.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool } from "../../src/db/index.js";
import { createCloudServer } from "../../src/server/index.js";

describe("Cloud MCP Server - Protocol & Transport", () => {
  const config = loadConfig({
    server: { port: 0, host: "127.0.0.1", logLevel: "info", bodyLimitBytes: 1048576, requestTimeoutMs: 5000, cors: { origin: "*", allowHeaders: ["*"], allowMethods: ["*"] } },
    auth: { allowAnonymous: false, jwtSecret: "test-secret-at-least-32-chars-long-for-hmac", tokenTtlSeconds: 3600 },
  });

  const tenant = {
    accountId: "acc-test-1",
    workspaceId: "ws-test-1",
  };

  const headers = {
    "content-type": "application/json",
    "x-account-id": tenant.accountId,
    "x-workspace-id": tenant.workspaceId,
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

  it("handles standard initialize handshake", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe("2.0");
      expect(json.id).toBe(1);
      expect(json.result.protocolVersion).toBe("2024-11-05");
      expect(json.result.capabilities.tools.listChanged).toBe(true);
      expect(json.result.serverInfo.name).toBe("@tool-evolver/cloud");
    } finally {
      await stop();
    }
  });

  it("lists all available tools with inputSchema", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe("2.0");
      expect(json.id).toBe(2);
      expect(Array.isArray(json.result.tools)).toBe(true);

      const toolNames = json.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain("echo");
      expect(toolNames).toContain("status");
      expect(toolNames).toContain("get_evolution_status");
      expect(toolNames).toContain("get_tool_lineage");

      const echoTool = json.result.tools.find((t: { name: string }) => t.name === "echo");
      expect(echoTool.inputSchema.type).toBe("object");
      expect(echoTool.inputSchema.properties.message).toBeDefined();
    } finally {
      await stop();
    }
  });

  it("executes tools/call successfully through middleware pipeline", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "call-1",
          method: "tools/call",
          params: {
            name: "echo",
            arguments: {
              message: "Hello MCP from cloud",
              payload: { foo: "bar" },
            },
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe("2.0");
      expect(json.id).toBe("call-1");
      expect(json.result.isError).toBe(false);
      expect(json.result.content[0].type).toBe("text");

      const parsedContent = JSON.parse(json.result.content[0].text);
      expect(parsedContent.echoed).toBe("Hello MCP from cloud");
      expect(parsedContent.payload).toEqual({ foo: "bar" });
      expect(parsedContent.workspaceId).toBe(tenant.workspaceId);
    } finally {
      await stop();
    }
  });

  it("responds to ping with empty object", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "ping",
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result).toEqual({});
    } finally {
      await stop();
    }
  });

  it("returns METHOD_NOT_FOUND for unsupported methods", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "unsupported/method",
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(MCP_ERROR_CODES.METHOD_NOT_FOUND);
    } finally {
      await stop();
    }
  });

  it("returns INVALID_PARAMS on missing required tool parameters", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "echo",
            arguments: {}, // Missing required 'message'
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
      expect(json.error.message).toContain("Missing required parameter: 'message'");
    } finally {
      await stop();
    }
  });

  it("returns RESOURCE_NOT_FOUND for non-existent tool", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "non_existent_tool_xyz",
            arguments: {},
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(MCP_ERROR_CODES.RESOURCE_NOT_FOUND);
    } finally {
      await stop();
    }
  });

  it("supports batch JSON-RPC requests", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 10, method: "ping" },
          { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "echo", arguments: { message: "batch-1" } } },
        ]),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(2);
      expect(json[0].id).toBe(10);
      expect(json[1].id).toBe(11);
      expect(JSON.parse(json[1].result.content[0].text).echoed).toBe("batch-1");
    } finally {
      await stop();
    }
  });

  it("handles cancellation via notifications/cancelled", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      // Start a tool call with long delay in the background
      const callPromise = fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "long-op-1",
          method: "tools/call",
          params: {
            name: "test_failure",
            arguments: {
              mode: "delay",
              delayMs: 2000,
            },
          },
        }),
      });

      // Allow request to register
      await new Promise((r) => setTimeout(r, 50));

      // Send cancel notification
      const cancelRes = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            requestId: "long-op-1",
            reason: "User aborted operation",
          },
        }),
      });
      expect(cancelRes.status).toBe(204);

      // Await response from original call
      const res = await callPromise;
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(MCP_ERROR_CODES.CANCELLED);
    } finally {
      await stop();
    }
  });

  it("supports SSE connection endpoint /v1/mcp/sse", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp/sse`, {
        method: "GET",
        headers: {
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body?.getReader();
      expect(reader).toBeDefined();

      if (reader) {
        const chunk = await reader.read();
        const text = new TextDecoder().decode(chunk.value);
        expect(text).toContain("event: endpoint");
        expect(text).toContain("/v1/mcp?sessionId=");
        await reader.cancel();
      }
    } finally {
      await stop();
    }
  });
});
