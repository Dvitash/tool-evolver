import type { ToolManifest } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import { MCP_ERROR_CODES } from "../../src/protocol/errors.js";
import type {
  CallToolResult,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  ListToolsResult,
} from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: overrides?.id ?? "tool_1",
    name: overrides?.name ?? "test_tool",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Test tool description",
    parameters: overrides?.parameters ?? {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    runtime: overrides?.runtime ?? {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: overrides?.capabilities ?? {
      fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: true, allowTemp: true, denyPaths: [], maxFileSizeBytes: 10485760 },
      net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https" as const], allowLocalhost: false, denyPrivateRanges: true },
      command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
      secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
      limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
    },
    limits: overrides?.limits ?? {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T12:00:00.000Z",
  };

  const digest = overrides?.digest ?? computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("RegistryGatewayRouter & LocalMcpGateway Integration", () => {
  it("lists active catalog tools via tools/list", async () => {
    const registry = new ToolRegistry();
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    // Initialize connection with workspace root
    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
        rootUri: "file:///test/project-alpha",
      },
    });

    const wsId = conn.workspaceContext.workspaceId;

    const manifest = makeManifest({
      id: "tool_greet",
      name: "greet",
      description: "Greets a user",
      version: "1.0.0",
    });

    await registry.registerTool(manifest, undefined, { workspaceId: wsId });

    const listRes = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as JsonRpcSuccessResponse<ListToolsResult>;

    expect(listRes.result.tools).toHaveLength(1);
    expect(listRes.result.tools[0].name).toBe("greet");
    expect(listRes.result.tools[0].description).toBe("Greets a user");
  });

  it("calls an active tool with custom handler via tools/call", async () => {
    const registry = new ToolRegistry();
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
        rootUri: "file:///test/project-beta",
      },
    });

    const wsId = conn.workspaceContext.workspaceId;

    const manifest = makeManifest({
      id: "tool_add",
      name: "add",
      version: "1.0.0",
    });

    await registry.registerTool(
      {
        toolId: "tool_add",
        name: "add",
        version: "1.0.0",
        manifest,
        scope: "workspace",
        status: "active",
        workspaceId: wsId,
        handler: async (_ctx, params) => {
          const a = Number(params.a ?? 0);
          const b = Number(params.b ?? 0);
          return {
            content: [{ type: "text", text: String(a + b) }],
          };
        },
      },
      undefined,
      { workspaceId: wsId }
    );

    const callRes = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "add",
        arguments: { a: 15, b: 27 },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    expect(callRes.result.content[0].text).toBe("42");
  });

  it("rejects calling missing tools or disabled tools with TOOL_NOT_FOUND error", async () => {
    const registry = new ToolRegistry();
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection();

    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
        rootUri: "file:///test/project-gamma",
      },
    });

    const wsId = conn.workspaceContext.workspaceId;

    const manifest = makeManifest({
      id: "tool_secret",
      name: "secret_tool",
      version: "1.0.0",
    });

    await registry.registerTool(manifest, undefined, { workspaceId: wsId });
    await registry.disableTool("tool_secret", wsId);

    const callDisabled = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "secret_tool", arguments: {} },
    })) as JsonRpcErrorResponse;

    expect(callDisabled.error.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);

    const callMissing = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "non_existent_tool", arguments: {} },
    })) as JsonRpcErrorResponse;

    expect(callMissing.error.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
  });

  it("broadcasts notifications/tools/list_changed on registry catalog updates", async () => {
    const registry = new ToolRegistry({ debounceMs: 0 }); // immediate for test
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router });
    const notifications: JsonRpcNotification[] = [];
    const conn = gateway.createConnection({
      sendMessage: (msg) => {
        if (!("id" in msg)) {
          notifications.push(msg as JsonRpcNotification);
        }
      },
    });

    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
        rootUri: "file:///test/project-broadcast",
      },
    });

    // Complete initialization
    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    const wsId = conn.workspaceContext.workspaceId;

    const manifest = makeManifest({
      id: "tool_broadcast",
      name: "broadcast_tool",
      version: "1.0.0",
    });

    await registry.registerTool(manifest);
    await registry.activateToolVersion("tool_broadcast", "1.0.0", wsId);

    expect(
      notifications.some((n) => n.method === "notifications/tools/list_changed")
    ).toBe(true);
  });
});
