import os from "node:os";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway, redactSensitiveText } from "../src/gateway.js";
import { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES } from "../src/protocol/errors.js";
import type { JsonRpcErrorResponse } from "../src/protocol/types.js";
import { FakeGatewayRouter } from "../src/router.js";

describe("Error Mapping & Sensitive Redaction", () => {
  it("redacts sensitive tokens and API keys from text", () => {
    const raw = "Failed request with sk-1234567890abcdefghijklmn and Bearer my-secret-jwt-token";
    const scrubbed = redactSensitiveText(raw);

    expect(scrubbed).not.toContain("sk-1234567890abcdefghijklmn");
    expect(scrubbed).not.toContain("my-secret-jwt-token");
    expect(scrubbed).toContain("[REDACTED_SECRET]");
  });

  it("redacts host user home paths from error messages", () => {
    const home = os.homedir();
    const raw = `Cannot open file at ${home}/private/keys/id_rsa.pub or /Users/john_doe/repo/file.ts`;
    const scrubbed = redactSensitiveText(raw);

    if (home.length > 1) {
      expect(scrubbed).not.toContain(home);
    }
    expect(scrubbed).toContain("<HOME>");
  });

  it("redacts tool thrown exceptions through gateway tools/call", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-client" },
        capabilities: {},
      },
    });

    const home = os.homedir();
    const secretMsg = `Database connection failed at ${home}/.secrets/db.key using sk-1234567890abcdef12345`;

    const resp = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "fail_tool",
        arguments: {
          errorMessage: secretMsg,
        },
      },
    })) as JsonRpcErrorResponse;

    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(JSON_RPC_ERROR_CODES.INTERNAL_ERROR);
    expect(resp.error.message).not.toContain("sk-1234567890abcdef12345");
    if (home.length > 1) {
      expect(resp.error.message).not.toContain(home);
    }
    expect(resp.error.message).toContain("[REDACTED_SECRET]");
    expect(resp.error.message).toContain("<HOME>");
  });

  it("maps unknown methods to METHOD_NOT_FOUND", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-client" },
        capabilities: {},
      },
    });

    const resp = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "unsupported/method",
      params: {},
    })) as JsonRpcErrorResponse;

    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it("maps invalid tool call parameters to INVALID_PARAMS", async () => {
    const router = new FakeGatewayRouter();
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-client" },
        capabilities: {},
      },
    });

    const resp = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        // Missing name
        arguments: {},
      },
    })) as JsonRpcErrorResponse;

    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
  });
});
