import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import { MCP_ERROR_CODES } from "../src/protocol/errors.js";
import type {
  CallToolResult,
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse,
  ListToolsResult,
} from "../src/protocol/types.js";
import { FakeGatewayRouter } from "../src/router.js";

describe("Multi-Client Concurrency & Workspace Isolation", () => {
  it("isolates workspace context between concurrent connections", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });

    // Client 1 in Repo A
    const connA = gateway.createConnection({ cwd: "/home/user/project-a" });
    await gateway.handleMessage(connA.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "claude-code" },
        capabilities: {},
        rootUri: "file:///home/user/project-a",
      },
    });

    // Client 2 in Repo B
    const connB = gateway.createConnection({ cwd: "/home/user/project-b" });
    await gateway.handleMessage(connB.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "openai-codex" },
        capabilities: {},
        rootUri: "file:///home/user/project-b",
      },
    });

    expect(connA.workspaceContext.workspaceId).not.toBe(connB.workspaceContext.workspaceId);

    // Call workspace_info tool on both
    const respA = (await gateway.handleMessage(connA.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workspace_info" },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    const respB = (await gateway.handleMessage(connB.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workspace_info" },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    const infoA = JSON.parse(respA.result.content[0].text);
    const infoB = JSON.parse(respB.result.content[0].text);

    expect(infoA.canonicalRoot).toContain("project-a");
    expect(infoB.canonicalRoot).toContain("project-b");
    expect(infoA.workspaceId).toBe(connA.workspaceContext.workspaceId);
    expect(infoB.workspaceId).toBe(connB.workspaceContext.workspaceId);
  });

  it("enforces workspace-scoped tool isolation", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });

    const connA = gateway.createConnection({ cwd: "/workspace/alpha" });
    await gateway.handleMessage(connA.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "client-a" },
        capabilities: {},
        rootUri: "file:///workspace/alpha",
      },
    });

    const connB = gateway.createConnection({ cwd: "/workspace/beta" });
    await gateway.handleMessage(connB.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "client-b" },
        capabilities: {},
        rootUri: "file:///workspace/beta",
      },
    });

    // Register tool only for Workspace A
    router.registerTool(
      {
        name: "alpha_exclusive_tool",
        inputSchema: { type: "object" },
      },
      async () => ({ content: [{ type: "text", text: "alpha only" }] }),
      connA.workspaceContext.workspaceId,
    );

    // Check tools/list on A vs B
    const listA = (await gateway.handleMessage(connA.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as JsonRpcSuccessResponse<ListToolsResult>;

    const listB = (await gateway.handleMessage(connB.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as JsonRpcSuccessResponse<ListToolsResult>;

    expect(listA.result.tools.some((t) => t.name === "alpha_exclusive_tool")).toBe(true);
    expect(listB.result.tools.some((t) => t.name === "alpha_exclusive_tool")).toBe(false);

    // Calling from B should fail
    const callB = (await gateway.handleMessage(connB.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "alpha_exclusive_tool" },
    })) as JsonRpcErrorResponse;

    expect(callB.error).toBeDefined();
    expect(callB.error.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
  });

  it("enforces rate limits on rapid requests", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({
      router,
      rateLimitBurst: 4,
      rateLimitRps: 1,
    });
    const conn = gateway.createConnection();

    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "rate-limited-client" },
        capabilities: {},
      },
    });

    // Consume burst capacity
    const r1 = await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
    });
    const r2 = await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "ping",
    });
    const r3 = await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "ping",
    });

    expect(r1?.error).toBeUndefined();
    expect(r2?.error).toBeUndefined();
    expect(r3?.error).toBeUndefined();

    // 4th should be rate limited
    const r4 = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 5,
      method: "ping",
    })) as JsonRpcErrorResponse;

    expect(r4.error).toBeDefined();
    expect(r4.error.code).toBe(MCP_ERROR_CODES.RATE_LIMITED);
  });
});
