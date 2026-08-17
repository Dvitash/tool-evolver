import type { ToolManifest } from "@tool-evolver/contracts";
import { describe, expect, it, vi } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import type { JsonRpcMessage, JsonRpcNotification } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";

function makeTestManifest(id: string, name: string): ToolManifest {
  const base = {
    id,
    name,
    version: "1.0.0",
    description: `Test tool ${name}`,
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    runtime: {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
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
        allowedProtocols: ["https" as const],
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
    scope: "workspace" as const,
    metadata: {},
    createdAt: "2026-08-17T12:00:00.000Z",
  };

  return {
    ...base,
    digest: computeManifestDigest(base),
  };
}

describe("CatalogRefreshCoordinator - End-to-End Gateway Integration", () => {
  it("coordinates full lifecycle: registry mutation -> coordinator dispatch -> gateway notification -> tools/list verification", async () => {
    const registry = new ToolRegistry({ debounceMs: 0 });
    const router = createRegistryGatewayRouter(registry);

    const gateway = new LocalMcpGateway({
      router,
      registry,
      refreshCoordinatorOptions: {
        debounceMs: 0,
        verificationTimeoutMs: 10_000,
      },
    });

    expect(gateway.refreshCoordinator).toBeDefined();

    const notificationsReceived: JsonRpcNotification[] = [];
    const connection = gateway.createConnection({
      connectionId: "conn-e2e",
      harnessId: "test-harness",
      sendMessage: (msg: JsonRpcMessage) => {
        if (!("id" in msg) || msg.id === undefined) {
          notificationsReceived.push(msg as JsonRpcNotification);
        }
      },
    });

    // Initialize the connection with tools.listChanged capability
    await gateway.handleMessage(connection.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: true },
        },
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    expect(connection.isInitialized).toBe(true);

    // Initial tools list
    const initialListResp = await gateway.handleMessage(connection.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(initialListResp?.result).toBeDefined();

    // Now register a new tool in the registry for this workspace
    const manifest = makeTestManifest("tool_e2e_1", "e2e_test_tool");
    await registry.registerTool(manifest, undefined, {
      workspaceId: connection.workspaceContext.workspaceId,
    });

    // Allow async coordinator dispatch to settle
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notificationsReceived.length).toBeGreaterThanOrEqual(1);
    const listChangedNotif = notificationsReceived.find(
      (n) => n.method === "notifications/tools/list_changed",
    );
    expect(listChangedNotif).toBeDefined();

    const attempts = gateway.refreshCoordinator!.getAttempts({
      connectionId: connection.connectionId,
    });
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0]?.primaryOutcome).toBe("native_sent");

    const pendingVerifs = gateway.refreshCoordinator!.getVerifications({ status: "pending" });
    expect(pendingVerifs.length).toBeGreaterThanOrEqual(1);

    // Client responds to notification by requesting tools/list
    const updatedListResp = await gateway.handleMessage(connection.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    expect(updatedListResp?.result).toBeDefined();

    // Verifier should now observe tools/list
    const observedVerifs = gateway.refreshCoordinator!.getVerifications({ status: "observed" });
    expect(observedVerifs.length).toBeGreaterThanOrEqual(1);
    expect(observedVerifs[0]?.observedVia).toBe("tools_list");

    const updatedAttempts = gateway.refreshCoordinator!.getAttempts({
      connectionId: connection.connectionId,
    });
    expect(updatedAttempts[0]?.verificationStatus).toBe("observed");
    expect(updatedAttempts[0]?.outcomes).toContain("native_observed");

    gateway.close();
  });
});
