import type { ToolManifest } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";

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

describe("ToolRegistry - Atomic Activation & Snapshots", () => {
  it("atomically creates immutable snapshots with monotonic revisions on activation", async () => {
    const registry = new ToolRegistry();
    const manifestA = makeManifest({ id: "tool_a", name: "toolA", version: "1.0.0" });
    const manifestB = makeManifest({ id: "tool_b", name: "toolB", version: "1.0.0" });

    await registry.stageToolVersion(manifestA);
    await registry.stageToolVersion(manifestB);

    const snapshot1 = await registry.activateToolVersion("tool_a", "1.0.0", "ws-snapshot");
    expect(snapshot1.tools["tool_a"]).toBeDefined();
    expect(snapshot1.tools["tool_b"]).toBeUndefined();
    expect(Object.isFrozen(snapshot1.tools)).toBe(true);

    const snapshot2 = await registry.activateToolVersion("tool_b", "1.0.0", "ws-snapshot");
    expect(snapshot2.tools["tool_a"]).toBeDefined();
    expect(snapshot2.tools["tool_b"]).toBeDefined();
    expect(registry.getRevision("ws-snapshot")).toBeGreaterThan(1);
    expect(snapshot2.digest).toBeTruthy();
    expect(snapshot2.digest).not.toEqual(snapshot1.digest);
  });

  it("advances monotonic revisions upon deactivation and updates catalog snapshot", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ id: "tool_c", name: "toolC", version: "1.0.0" });

    await registry.stageToolVersion(manifest);
    const snapActive = await registry.activateToolVersion("tool_c", "1.0.0", "ws-deact");
    expect(snapActive.tools["tool_c"]).toBeDefined();

    const snapDeact = await registry.deactivateTool("tool_c", "ws-deact");
    expect(snapDeact.tools["tool_c"]).toBeUndefined();
    expect(registry.getRevision("ws-deact")).toBeGreaterThan(1);
  });

  it("leverages LRU cache and invalidates on workspace update", async () => {
    const registry = new ToolRegistry();
    const manifestV1 = makeManifest({ id: "tool_cache", name: "toolCache", version: "1.0.0" });
    const manifestV2 = makeManifest({ id: "tool_cache", name: "toolCache", version: "2.0.0" });

    await registry.stageToolVersion(manifestV1);
    await registry.stageToolVersion(manifestV2);

    await registry.activateToolVersion("tool_cache", "1.0.0", "ws-cache");

    const resolved1 = await registry.resolveCatalog("ws-cache");
    expect(resolved1.tools["tool_cache"].version).toBe("1.0.0");
    expect(registry.cache.has("ws-cache")).toBe(true);

    // Activating v2 invalidates cache and builds new snapshot
    await registry.activateToolVersion("tool_cache", "2.0.0", "ws-cache");
    const resolved2 = await registry.resolveCatalog("ws-cache");

    expect(resolved2.tools["tool_cache"].version).toBe("2.0.0");
    expect(resolved2.digest).not.toEqual(resolved1.digest);
  });
});
