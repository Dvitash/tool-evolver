import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import { JSON_RPC_ERROR_CODES } from "../src/protocol/errors.js";
import type {
  InitializeResult,
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse,
} from "../src/protocol/types.js";
import { FakeGatewayRouter } from "../src/router.js";

describe("MCP Initialization & Capability Negotiation", () => {
  it("initializes successfully with Claude Code client", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    const initReq = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: {
          name: "claude-code",
          version: "1.0.4",
        },
        capabilities: {
          roots: { listChanged: true },
        },
      },
    };

    const resp = (await gateway.handleMessage(
      conn.connectionId,
      initReq
    )) as JsonRpcSuccessResponse<InitializeResult>;

    expect(resp.error).toBeUndefined();
    expect(resp.result.protocolVersion).toBe("2024-11-05");
    expect(resp.result.capabilities.tools?.listChanged).toBe(true);
    expect(resp.result.serverInfo.name).toBe("tool-evolver-mcp");
    expect(conn.harnessId).toBe("claude-code");
    expect(conn.isInitialized).toBe(true);
  });

  it("initializes successfully with Codex CLI client", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    const initReq = {
      jsonrpc: "2.0" as const,
      id: "codex-init-1",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: {
          name: "openai-codex-cli",
          version: "0.9.0",
        },
        capabilities: {},
      },
    };

    const resp = (await gateway.handleMessage(
      conn.connectionId,
      initReq
    )) as JsonRpcSuccessResponse<InitializeResult>;

    expect(resp.error).toBeUndefined();
    expect(conn.harnessId).toBe("codex");
    expect(conn.isInitialized).toBe(true);
  });

  it("initializes successfully with Oh My Pi (OMP) client", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    const initReq = {
      jsonrpc: "2.0" as const,
      id: "omp-init-0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: {
          name: "oh-my-pi",
          version: "2.0.0",
        },
        capabilities: {
          roots: { listChanged: true },
        },
      },
    };

    const resp = (await gateway.handleMessage(
      conn.connectionId,
      initReq
    )) as JsonRpcSuccessResponse<InitializeResult>;

    expect(resp.error).toBeUndefined();
    expect(conn.harnessId).toBe("omp");
    expect(conn.isInitialized).toBe(true);
  });

  it("rejects tool calls prior to initialize request", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    const listReq = {
      jsonrpc: "2.0" as const,
      id: 10,
      method: "tools/list",
      params: {},
    };

    const resp = (await gateway.handleMessage(
      conn.connectionId,
      listReq
    )) as JsonRpcErrorResponse;

    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
  });

  it("handles ping request", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    const pingReq = {
      jsonrpc: "2.0" as const,
      id: "ping-1",
      method: "ping",
      params: {},
    };

    const resp = (await gateway.handleMessage(
      conn.connectionId,
      pingReq
    )) as JsonRpcSuccessResponse<Record<string, unknown>>;

    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({});
  });
});
