import type { ToolManifest } from "@tool-evolver/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_ERROR_CODES, McpProtocolError } from "../../src/protocol/errors.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { MockCloudMcpService } from "../../src/proxy/mock-service.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

function makeManifest(id: string, name: string, scope = "workspace" as const): ToolManifest {
  const base = {
    id,
    name,
    version: "1.0.0",
    description: `Tool ${name}`,
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
    },
    runtime: {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 10485760 },
      net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https" as const], allowLocalhost: false, denyPrivateRanges: true },
      command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
      secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
      limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
    },
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope,
    metadata: {},
    createdAt: "2026-08-17T12:00:00.000Z",
  };

  return {
    ...base,
    digest: computeManifestDigest(base),
  };
}

const mockWorkspaceContext: WorkspaceContext = {
  workspaceId: "ws_offline_test",
  sessionId: "sess_offline_test",
  accountId: "acc_1",
  gitRoot: "/workspaces/proj",
  harnessId: "test-harness",
  canonicalRoot: "/workspaces/proj",
  isSymlinked: false,
  symlinkChain: [],
};

describe("Offline Degradation & Fault Tolerance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves local tools and meta-tools 100% operational when cloud goes offline", async () => {
    const workspaceId = "ws_offline_test";
    const registry = new ToolRegistry();
    const mockService = new MockCloudMcpService({ workspaceId });
    const cache = new CloudCatalogCache();
    const circuitBreaker = new CloudCircuitBreaker({ failureThreshold: 1 });

    // 1. Register local tool
    const localTool = makeManifest("local_eval", "eval_expression");
    let localExecuted = false;
    await registry.registerTool({
      toolId: localTool.id,
      name: localTool.name,
      version: localTool.version,
      manifest: localTool,
      scope: "workspace",
      status: "active",
      workspaceId,
      handler: async () => {
        localExecuted = true;
        return { content: [{ type: "text", text: "local result: 42" }] };
      },
    });

    // 2. Register cloud tool via sync
    const cloudTool = makeManifest("cloud_weather", "get_weather");
    mockService.addTool(cloudTool, undefined, async () => {
      return { content: [{ type: "text", text: "cloud weather: 68F" }] };
    });

    const client = new CloudCatalogClient({
      workspaceId,
      circuitBreaker,
      snapshotFetcher: async (req, signal) => mockService.handleCatalogSnapshot(req, signal),
    });

    const router = new CloudInvocationRouter({
      circuitBreaker,
      catalogCache: cache,
      mockService,
    });

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId,
    });

    await syncCoordinator.sync();

    const gatewayRouter = createRegistryGatewayRouter(registry);

    // Initial check: both tools listed and working
    const initialTools = await gatewayRouter.listTools(mockWorkspaceContext);
    expect(initialTools.map((t) => t.name)).toContain("eval_expression");
    expect(initialTools.map((t) => t.name)).toContain("get_weather");

    const localRes1 = await gatewayRouter.callTool(mockWorkspaceContext, "eval_expression", {});
    expect(localExecuted).toBe(true);
    expect(localRes1.content[0]).toEqual({ type: "text", text: "local result: 42" });

    // 3. Simulate cloud going offline
    mockService.simulateOffline(true);
    circuitBreaker.recordFailure(new Error("Cloud disconnected"));
    expect(circuitBreaker.getState()).toBe("OPEN");
    expect(circuitBreaker.getHealth().status).toBe("offline");

    await syncCoordinator.markOffline("Cloud disconnected");

    // Check availability in cache
    const availability = cache.getToolAvailability("cloud_weather", workspaceId);
    expect(availability.availability).toBe("stale");

    // 4. Local tool STILL works 100% with zero interruption!
    localExecuted = false;
    const localRes2 = await gatewayRouter.callTool(mockWorkspaceContext, "eval_expression", {});
    expect(localExecuted).toBe(true);
    expect(localRes2.content[0]).toEqual({ type: "text", text: "local result: 42" });

    // 5. Calling cloud tool while offline fails immediately (no silent queuing!)
    try {
      await gatewayRouter.callTool(mockWorkspaceContext, "get_weather", {});
      expect.unreachable("Cloud tool should fail while offline");
    } catch (err) {
      expect(err).toBeInstanceOf(McpProtocolError);
      expect((err as McpProtocolError).code).toBe(MCP_ERROR_CODES.CONNECTION_CLOSED);
    }
  });

  it("blocks execution past hard expiry even if cloud tool is cached", async () => {
    const workspaceId = "ws_offline_test";
    const cache = new CloudCatalogCache({
      freshTtlMs: 1000,
      hardExpiryMs: 5000,
    });
    const mockService = new MockCloudMcpService({ workspaceId });
    const circuitBreaker = new CloudCircuitBreaker();

    const tool = makeManifest("cloud_calc", "calculate_mortgage");
    mockService.addTool(tool);

    const client = new CloudCatalogClient({
      workspaceId,
      circuitBreaker,
      snapshotFetcher: async (req, signal) => mockService.handleCatalogSnapshot(req, signal),
    });

    const router = new CloudInvocationRouter({
      circuitBreaker,
      catalogCache: cache,
      mockService,
    });

    // Ingest snapshot into cache
    const snapshot = await client.fetchCatalogSnapshot();
    cache.setSnapshot(snapshot, { workspaceId });

    // Initially fresh
    expect(cache.getToolAvailability("cloud_calc", workspaceId).availability).toBe("fresh");

    // Advance fake timer past soft TTL (1000ms) but before hard expiry (5000ms)
    vi.advanceTimersByTime(2000);
    expect(cache.getToolAvailability("cloud_calc", workspaceId).availability).toBe("stale");

    // Tool can still be called while within hard expiry and cloud online
    const res = await router.forwardInvocation("cloud_calc", {}, mockWorkspaceContext);
    expect(res).toBeDefined();

    // Advance fake timer past hard expiry (5000ms total)
    vi.advanceTimersByTime(4000);
    expect(cache.getToolAvailability("cloud_calc", workspaceId).availability).toBe("expired");

    // Execution MUST be blocked past hard expiry!
    try {
      await router.forwardInvocation("cloud_calc", {}, mockWorkspaceContext);
      expect.unreachable("Execution past hard expiry must be blocked");
    } catch (err) {
      expect(err).toBeInstanceOf(McpProtocolError);
      expect((err as McpProtocolError).code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
      expect((err as McpProtocolError).message).toContain("expired past hard");
    }
  });

  it("restores cloud tool functionality when network connection recovers", async () => {
    const workspaceId = "ws_offline_test";
    const registry = new ToolRegistry();
    const mockService = new MockCloudMcpService({ workspaceId });
    const cache = new CloudCatalogCache();
    const circuitBreaker = new CloudCircuitBreaker({
      failureThreshold: 1,
      successThreshold: 1,
      resetTimeoutMs: 1000,
    });

    const tool = makeManifest("cloud_translate", "translate_text");
    mockService.addTool(tool, undefined, async (params) => {
      return { content: [{ type: "text", text: `Translated: ${params.input}` }] };
    });

    const client = new CloudCatalogClient({
      workspaceId,
      circuitBreaker,
      snapshotFetcher: async (req, signal) => mockService.handleCatalogSnapshot(req, signal),
    });

    const router = new CloudInvocationRouter({
      circuitBreaker,
      catalogCache: cache,
      mockService,
    });

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId,
    });

    await syncCoordinator.sync();

    const gatewayRouter = createRegistryGatewayRouter(registry);

    // Initial success
    const res1 = await gatewayRouter.callTool(mockWorkspaceContext, "translate_text", { input: "hello" });
    expect(res1.content[0]).toEqual({ type: "text", text: "Translated: hello" });

    // Disconnect
    mockService.simulateOffline(true);
    circuitBreaker.recordFailure(new Error("Net error"));
    expect(circuitBreaker.getState()).toBe("OPEN");

    // Call fails
    await expect(gatewayRouter.callTool(mockWorkspaceContext, "translate_text", { input: "hello" })).rejects.toThrow();

    // Reconnect & advance cooldown timer
    mockService.simulateOnline();
    vi.advanceTimersByTime(1100);
    expect(circuitBreaker.getState()).toBe("HALF_OPEN");

    // Call succeeds and resets circuit to CLOSED
    const res2 = await gatewayRouter.callTool(mockWorkspaceContext, "translate_text", { input: "world" });
    expect(res2.content[0]).toEqual({ type: "text", text: "Translated: world" });
    expect(circuitBreaker.getState()).toBe("CLOSED");
    expect(circuitBreaker.getHealth().status).toBe("online");
  });
});
