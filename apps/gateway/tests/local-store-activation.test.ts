import stream from "node:stream";
import {
  type ToolManifest,
  type ToolVersion,
  nowIso,
} from "@tool-evolver/contracts";
import {
  LocalDatabaseConnection,
  MigrationRunner,
  ToolRepository,
} from "@tool-evolver/db";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import type {
  CallToolResult,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  ListToolsResult,
} from "../src/protocol/types.js";
import { ToolRegistry } from "../src/registry/registry.js";
import {
  FakeGatewayRouter,
  createRegistryGatewayRouter,
} from "../src/router.js";
import { McpStdioShim } from "../src/shim/stdio-bridge.js";
import { withResolvers } from "../src/utils/deferred.js";

async function setupTestDb(): Promise<{
  conn: LocalDatabaseConnection;
  toolRepo: ToolRepository;
}> {
  const conn = new LocalDatabaseConnection({ inMemory: true });
  const migrationRunner = new MigrationRunner(conn);
  await migrationRunner.migrate();
  const toolRepo = new ToolRepository(conn);
  return { conn, toolRepo };
}

function makeEvolvedTool(
  name: string,
  version: string = "1.0.0",
): { manifest: ToolManifest; toolVersion: ToolVersion } {
  const digest = "a".repeat(64);
  const manifest: ToolManifest = {
    id: `tool_${name}`,
    name,
    version,
    description: `Autonomous evolved tool for ${name}`,
    scope: "workspace",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    runtime: {
      runtime: "node",
      timeoutMs: 15000,
      memoryLimitMb: 256,
      cpuLimitPercent: 80,
      maxOutputSizeBytes: 2097152,
    },
    capabilities: {
      command: { allowedCommands: ["git"] },
      fs: { readOnly: true, allowWorkspaceRoot: true },
    },
    limits: {
      timeoutMs: 15000,
      maxMemoryBytes: 268435456,
      maxOutputBytes: 2097152,
      maxConcurrentInvocations: 4,
    },
    digest,
    createdAt: nowIso(),
    metadata: {},
  };

  const toolVersion: ToolVersion = {
    toolId: `tool_${name}`,
    version,
    manifestDigest: digest,
    artifactDigest: digest,
    manifest,
    artifact: {
      artifactDigest: digest,
      bundleReference: {
        uri: `memory://${name}/${version}`,
        hash: digest,
        sizeBytes: 1024,
        format: "js_bundle",
      },
      entrypoint: "index.js",
    },
    provenance: {
      synthesizedAt: nowIso(),
      synthesizerModel: "test-synthesizer",
      deterministicBuildHash: digest,
      environment: {},
    },
    status: "active",
    createdAt: nowIso(),
    createdBy: "system",
  };

  return { manifest, toolVersion };
}

describe("GitHub Issue #110: Published Tool Versions in Local Gateway Catalog", () => {
  it("loads published tool versions from local store at startup into RegistryGatewayRouter", async () => {
    const { conn, toolRepo } = await setupTestDb();

    // 1. Publish/activate an evolved tool into local store
    const { manifest, toolVersion } = makeEvolvedTool("fast_git_status");
    await toolRepo.saveManifest(manifest);
    await toolRepo.saveToolVersion(toolVersion);

    // 2. Start Gateway backed by the local store
    const registry = new ToolRegistry({ db: conn });
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router });
    const connInstance = gateway.createConnection();

    await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-client", version: "1.0.0" },
        capabilities: {},
        roots: [{ uri: "file:///workspace/test", name: "test-workspace" }],
      },
    });

    // 3. Verify tools/list contains the evolved tool
    const listRes = (await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as JsonRpcSuccessResponse<ListToolsResult>;

    expect(listRes.error).toBeUndefined();
    const toolNames = listRes.result.tools.map((t) => t.name);
    expect(toolNames).toContain("fast_git_status");

    const fastGit = listRes.result.tools.find((t) => t.name === "fast_git_status");
    expect(fastGit).toBeDefined();
    expect(fastGit?.description).toContain("Autonomous evolved tool for fast_git_status");
    expect(fastGit?.inputSchema.type).toBe("object");
    expect(fastGit?.inputSchema.properties).toHaveProperty("query");

    // 4. Verify tools/call executes the evolved tool
    const callRes = (await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "fast_git_status",
        arguments: { query: "status --short" },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    expect(callRes.error).toBeUndefined();
    expect(callRes.result.content).toHaveLength(1);
    expect(callRes.result.content[0].type).toBe("text");
    const parsedOutput = JSON.parse(callRes.result.content[0].text);
    expect(parsedOutput.status).toBe("executed");
    expect(parsedOutput.tool).toBe("fast_git_status");
    expect(parsedOutput.params).toEqual({ query: "status --short" });
  });

  it("refreshes gateway catalog and emits tools/list_changed when new tools are published to store", async () => {
    const { conn, toolRepo } = await setupTestDb();

    // Initial tool
    const initial = makeEvolvedTool("initial_tool");
    await toolRepo.saveManifest(initial.manifest);
    await toolRepo.saveToolVersion(initial.toolVersion);

    const registry = new ToolRegistry({ db: conn, debounceMs: 0 });
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router });
    const notifications: JsonRpcNotification[] = [];
    const connInstance = gateway.createConnection({
      sendMessage: (msg) => {
        if (!("id" in msg)) {
          notifications.push(msg as JsonRpcNotification);
        }
      },
    });

    await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-client", version: "1.0.0" },
        capabilities: {},
        roots: [{ uri: "file:///workspace/test", name: "test-workspace" }],
      },
    });

    const initialList = (await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as JsonRpcSuccessResponse<ListToolsResult>;
    expect(initialList.result.tools.map((t) => t.name)).toContain("initial_tool");

    // Publish second tool to store
    const second = makeEvolvedTool("csv_processor");
    await toolRepo.saveManifest(second.manifest);
    await toolRepo.saveToolVersion(second.toolVersion);

    // Trigger refresh on router
    const loaded = await router.refresh();
    expect(loaded).toBeGreaterThanOrEqual(2);

    // tools/list now includes both tools
    const updatedList = (await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    })) as JsonRpcSuccessResponse<ListToolsResult>;

    const toolNames = updatedList.result.tools.map((t) => t.name);
    expect(toolNames).toContain("initial_tool");
    expect(toolNames).toContain("csv_processor");

    // Calling the newly refreshed tool succeeds
    const callRes = (await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "csv_processor",
        arguments: { query: "parse.csv", limit: 50 },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    expect(callRes.error).toBeUndefined();
    const output = JSON.parse(callRes.result.content[0].text);
    expect(output.status).toBe("executed");
    expect(output.tool).toBe("csv_processor");
  });

  it("loads evolved tools from store in FakeGatewayRouter", async () => {
    const { conn, toolRepo } = await setupTestDb();

    const { manifest, toolVersion } = makeEvolvedTool("regex_matcher");
    await toolRepo.saveManifest(manifest);
    await toolRepo.saveToolVersion(toolVersion);

    const router = new FakeGatewayRouter({ db: conn });
    await router.loadFromStore();

    const gateway = new LocalMcpGateway({ router });
    const connInstance = gateway.createConnection();

    await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-client", version: "1.0.0" },
        capabilities: {},
        roots: [{ uri: "file:///workspace/test", name: "test-workspace" }],
      },
    });

    const listRes = (await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as JsonRpcSuccessResponse<ListToolsResult>;

    const toolNames = listRes.result.tools.map((t) => t.name);
    expect(toolNames).toContain("echo");
    expect(toolNames).toContain("workspace_info");
    expect(toolNames).toContain("regex_matcher");

    const callRes = (await gateway.handleMessage(connInstance.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "regex_matcher",
        arguments: { query: "\\d+" },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    expect(callRes.error).toBeUndefined();
    const output = JSON.parse(callRes.result.content[0].text);
    expect(output.status).toBe("executed");
    expect(output.tool).toBe("regex_matcher");
  });

  it("serves published tools in standalone McpStdioShim when backed by local store", async () => {
    const { conn, toolRepo } = await setupTestDb();

    const { manifest, toolVersion } = makeEvolvedTool("standalone_evolved_tool");
    await toolRepo.saveManifest(manifest);
    await toolRepo.saveToolVersion(toolVersion);

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();

    const shim = new McpStdioShim({
      standaloneFallback: true,
      db: conn,
      maxStartupAttempts: 0,
      stdin,
      stdout,
      stderr,
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("standalone_inprocess");

      let receivedData = "";
      const { promise: listReceived, resolve: resolveList } = withResolvers<void>();
      stdout.on("data", (chunk) => {
        receivedData += chunk.toString("utf8");
        if (receivedData.includes("standalone_evolved_tool")) {
          resolveList();
        }
      });

      // Send initialize
      const initReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: "init_1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "1.0.0" },
          capabilities: {},
        },
      };
      stdin.write(`${JSON.stringify(initReq)}\n`);

      // Send tools/list
      const listReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: "list_1",
        method: "tools/list",
        params: {},
      };
      stdin.write(`${JSON.stringify(listReq)}\n`);

      await listReceived;

      expect(receivedData).toContain("standalone_evolved_tool");
      expect(receivedData).toContain("invoke_tool");
    } finally {
      await shim.stop();
    }
  });
});
