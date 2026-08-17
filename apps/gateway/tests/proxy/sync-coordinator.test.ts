import type { ToolManifest } from "@tool-evolver/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { MockCloudMcpService } from "../../src/proxy/mock-service.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";

function makeTool(id: string, name: string, version = "1.0.0"): ToolManifest {
  const base = {
    id,
    name,
    version,
    description: `Tool ${name}`,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
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
        allowWorkspaceRoot: false,
        allowTemp: false,
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
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
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

describe("CloudCatalogSyncCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles emergency revocation invalidation events immediately", async () => {
    const workspaceId = "ws_sync_test";
    const registry = new ToolRegistry();
    const mockService = new MockCloudMcpService({ workspaceId });
    const cache = new CloudCatalogCache();

    const tool1 = makeTool("cloud_tool_a", "tool_a");
    const tool2 = makeTool("cloud_tool_b", "tool_b");
    mockService.addTool(tool1);
    mockService.addTool(tool2);

    const client = new CloudCatalogClient({
      workspaceId,
      snapshotFetcher: async (req, signal) => mockService.handleCatalogSnapshot(req, signal),
    });

    const router = new CloudInvocationRouter({ mockService, catalogCache: cache });
    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId,
    });

    // Initial sync
    await syncCoordinator.sync();
    expect(cache.getTool("cloud_tool_a", workspaceId)).not.toBeNull();
    expect(cache.getTool("cloud_tool_b", workspaceId)).not.toBeNull();
    expect(await registry.getTool("cloud_tool_a", workspaceId)).toBeDefined();
    expect(await registry.getTool("cloud_tool_b", workspaceId)).toBeDefined();

    // Invalidation: Emergency Revocation of tool_a
    mockService.removeTool("cloud_tool_a");
    await syncCoordinator.handleInvalidation({
      type: "server.catalog_invalidation",
      workspaceId,
      toolIds: ["cloud_tool_a"],
      reason: "emergency_revocation",
      timestamp: new Date().toISOString(),
    });

    // Tool A immediately removed from cache
    expect(cache.getTool("cloud_tool_a", workspaceId)).toBeNull();
    // Tool B remains intact
    expect(cache.getTool("cloud_tool_b", workspaceId)).not.toBeNull();
  });

  it("handles version published and triggers incremental resync", async () => {
    const workspaceId = "ws_sync_test";
    const registry = new ToolRegistry();
    const mockService = new MockCloudMcpService({ workspaceId });
    const cache = new CloudCatalogCache();

    const tool1 = makeTool("tool_v1", "dynamic_tool", "1.0.0");
    mockService.addTool(tool1);

    const client = new CloudCatalogClient({
      workspaceId,
      snapshotFetcher: async (req, signal) => mockService.handleCatalogSnapshot(req, signal),
    });

    const router = new CloudInvocationRouter({ mockService, catalogCache: cache });
    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId,
    });

    await syncCoordinator.sync();
    expect(cache.getTool("tool_v1", workspaceId)?.version).toBe("1.0.0");

    // Add new version on cloud
    const tool2 = makeTool("tool_v1", "dynamic_tool", "1.1.0");
    mockService.addTool(tool2);

    // Invalidation event
    await syncCoordinator.handleInvalidation({
      type: "server.catalog_invalidation",
      workspaceId,
      toolIds: ["tool_v1"],
      reason: "version_published",
      timestamp: new Date().toISOString(),
    });

    // Resynced to new version
    expect(cache.getTool("tool_v1", workspaceId)?.version).toBe("1.1.0");
  });

  it("manages background periodic sync lifecycle", async () => {
    const workspaceId = "ws_sync_test";
    const registry = new ToolRegistry();
    const mockService = new MockCloudMcpService({ workspaceId });
    const cache = new CloudCatalogCache();

    let fetchCount = 0;
    const client = new CloudCatalogClient({
      workspaceId,
      snapshotFetcher: async (req, signal) => {
        fetchCount++;
        return mockService.handleCatalogSnapshot(req, signal);
      },
    });

    const router = new CloudInvocationRouter({ mockService, catalogCache: cache });
    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId,
      syncIntervalMs: 1000,
    });

    expect(syncCoordinator.isRunning()).toBe(false);

    syncCoordinator.startPeriodicSync(1000);
    expect(syncCoordinator.isRunning()).toBe(true);

    // Advance fake timer asynchronously to allow microtasks/promises to resolve
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchCount).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchCount).toBeGreaterThanOrEqual(2);

    syncCoordinator.stopPeriodicSync();
    expect(syncCoordinator.isRunning()).toBe(false);

    const countAfterStop = fetchCount;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchCount).toBe(countAfterStop);
  });
});
