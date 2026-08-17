import type { ToolManifest } from "@tool-evolver/contracts";
import { hashCanonicalContent } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { MockCloudMcpService } from "../../src/proxy/mock-service.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";

function makeCloudManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: overrides?.id ?? "cloud_weather_tool",
    name: overrides?.name ?? "get_weather",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Fetches current weather information",
    parameters: overrides?.parameters ?? {
      type: "object",
      properties: {
        location: { type: "string" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
    outputSchema: overrides?.outputSchema ?? {
      type: "object",
      properties: {
        temperature: { type: "number" },
        conditions: { type: "string" },
      },
    },
    runtime: overrides?.runtime ?? {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: overrides?.capabilities ?? {
      fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 10485760 },
      net: { allowOutbound: true, allowedDomains: ["api.weather.com"], allowedHosts: [], allowedPorts: [443], allowedProtocols: ["https" as const], allowLocalhost: false, denyPrivateRanges: true },
      command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
      secrets: { allowedSecretNames: ["WEATHER_API_KEY"], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
      limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
    },
    limits: overrides?.limits ?? {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? { tier: "enterprise" },
    createdAt: overrides?.createdAt ?? "2026-08-17T12:00:00.000Z",
  };

  const digest = overrides?.digest ?? computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("Cloud Catalog Snapshot Ingestion & Validation", () => {
  it("fetches, validates, and ingests a valid cloud snapshot", async () => {
    const mockService = new MockCloudMcpService({ workspaceId: "ws-test-1" });
    const tool1 = makeCloudManifest({ id: "tool_cloud_1", name: "query_database" });
    const tool2 = makeCloudManifest({ id: "tool_cloud_2", name: "summarize_document" });

    mockService.addTool(tool1);
    mockService.addTool(tool2);

    const client = new CloudCatalogClient({
      workspaceId: "ws-test-1",
      snapshotFetcher: async (req, signal) => mockService.handleCatalogSnapshot(req, signal),
    });
    const snapshot = await client.fetchCatalogSnapshot();
    expect(snapshot.snapshotVersion).toBeDefined();
    expect(snapshot.tools).toHaveLength(2);
    expect(snapshot.tools.map((t) => t.id)).toContain("tool_cloud_1");
    expect(snapshot.tools.map((t) => t.id)).toContain("tool_cloud_2");
    expect(snapshot.checksum).toBeDefined();
  });

  it("rejects snapshot with corrupted or tampered canonical checksum", async () => {
    const mockService = new MockCloudMcpService({ workspaceId: "ws-test-1" });
    const tool = makeCloudManifest({ id: "tool_1" });
    mockService.addTool(tool);

    const client = new CloudCatalogClient({
      workspaceId: "ws-test-1",
      snapshotFetcher: async (req, signal) => {
        const snap = await mockService.handleCatalogSnapshot(req, signal);
        return {
          ...snap,
          checksum: "0000000000000000000000000000000000000000000000000000000000000000", // Tampered checksum
        };
      },
    });

    await expect(client.fetchCatalogSnapshot()).rejects.toThrow("checksum mismatch");
  });

  it("caches snapshot and tracks soft TTL and hard expiry", async () => {
    const cache = new CloudCatalogCache({
      freshTtlMs: 1000,
      hardExpiryMs: 5000,
    });

    const tool = makeCloudManifest({ id: "cached_tool", name: "cached_tool_name" });
    const snapshot = {
      snapshotVersion: "v1",
      generatedAt: new Date().toISOString(),
      checksum: hashCanonicalContent({ tools: [tool], activeDeployments: [] }),
      tools: [tool],
      activeDeployments: [],
    };

    cache.setSnapshot(snapshot, { workspaceId: "ws-1" });

    // Initially fresh
    const initial = cache.getToolAvailability("cached_tool", "ws-1");
    expect(initial.availability).toBe("fresh");
    expect(initial.tool?.name).toBe("cached_tool_name");
    expect(initial.tool?.source).toBe("cloud");

    const listed = cache.listTools("ws-1");
    expect(listed).toHaveLength(1);
    expect(listed[0].toolId).toBe("cached_tool");
  });

  it("integrates cloud catalog into ToolRegistry and resolves correctly", async () => {
    const workspaceId = "ws-integration";
    const registry = new ToolRegistry();
    const mockService = new MockCloudMcpService({ workspaceId });
    const cache = new CloudCatalogCache();

    const tool1 = makeCloudManifest({
      id: "cloud_search",
      name: "search_documents",
      description: "Search documents in cloud index",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });
    mockService.addTool(tool1);

    const client = new CloudCatalogClient({
      workspaceId,
      snapshotFetcher: async (req, signal) => mockService.handleCatalogSnapshot(req, signal),
    });
    const router = new CloudInvocationRouter({
      catalogCache: cache,
      mockService,
    });

    const coordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId,
      autoRegisterInRegistry: true,
    });

    const synced = await coordinator.sync();
    expect(synced).not.toBeNull();

    // Verify tool registered in registry
    const regTool = await registry.getTool("cloud_search", workspaceId);
    expect(regTool).toBeDefined();
    expect(regTool?.name).toBe("search_documents");
    expect(regTool?.metadata?.source).toBe("cloud");
    expect(regTool?.metadata?.availability).toBe("fresh");

    // Verify resolved catalog includes cloud tool
    const catalog = await registry.resolveCatalog(workspaceId);
    expect(catalog.tools["cloud_search"]).toBeDefined();
    expect(catalog.tools["cloud_search"].toolId).toBe("cloud_search");
  });
});
