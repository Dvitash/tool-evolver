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

describe("ToolRegistry - Manual Rollback & Historical Snapshot Restoration", () => {
  it("rolls back to a previous snapshot by revision number, restoring referenced tool versions", async () => {
    const registry = new ToolRegistry();
    const manifestV1 = makeManifest({ id: "tool_compiler", name: "compiler", version: "1.0.0" });
    const manifestV2 = makeManifest({ id: "tool_compiler", name: "compiler", version: "2.0.0" });
    const manifestExtra = makeManifest({ id: "tool_linter", name: "linter", version: "1.0.0" });

    await registry.stageToolVersion(manifestV1);
    await registry.stageToolVersion(manifestV2);
    await registry.stageToolVersion(manifestExtra);

    // Rev 1: compiler@1.0.0
    const snapshotRev1 = await registry.activateToolVersion("tool_compiler", "1.0.0", "ws-rollback");
    const rev1 = registry.getRevision("ws-rollback");
    expect(snapshotRev1.tools["tool_compiler"].version).toBe("1.0.0");
    expect(snapshotRev1.tools["tool_linter"]).toBeUndefined();

    // Rev 2: compiler@2.0.0 and linter@1.0.0
    await registry.activateToolVersion("tool_compiler", "2.0.0", "ws-rollback");
    await registry.activateToolVersion("tool_linter", "1.0.0", "ws-rollback");

    const snapshotRev2 = await registry.resolveCatalog("ws-rollback");
    expect(snapshotRev2.tools["tool_compiler"].version).toBe("2.0.0");
    expect(snapshotRev2.tools["tool_linter"].version).toBe("1.0.0");

    // Perform rollback to rev 1
    const rolledBackSnapshot = await registry.rollbackCatalog("ws-rollback", rev1);

    expect(rolledBackSnapshot.tools["tool_compiler"]).toBeDefined();
    expect(rolledBackSnapshot.tools["tool_compiler"].version).toBe("1.0.0");
    expect(rolledBackSnapshot.tools["tool_linter"]).toBeUndefined();
    expect(registry.getRevision("ws-rollback")).toBeGreaterThan(rev1);
  });

  it("rolls back to a historical snapshot by snapshotId", async () => {
    const registry = new ToolRegistry();
    const manifestA = makeManifest({ id: "tool_a", name: "toolA", version: "1.0.0" });
    const manifestB = makeManifest({ id: "tool_b", name: "toolB", version: "1.0.0" });

    await registry.stageToolVersion(manifestA);
    await registry.stageToolVersion(manifestB);

    const initialSnapshot = await registry.activateToolVersion("tool_a", "1.0.0", "ws-snap-rb");
    await registry.activateToolVersion("tool_b", "1.0.0", "ws-snap-rb");

    const afterRollback = await registry.rollbackCatalog("ws-snap-rb", initialSnapshot.snapshotId);

    expect(afterRollback.tools["tool_a"]).toBeDefined();
    expect(afterRollback.tools["tool_b"]).toBeUndefined();
  });

  it("throws a descriptive error when target rollback revision does not exist", async () => {
    const registry = new ToolRegistry();
    await expect(
      registry.rollbackCatalog("ws-nonexistent", 999)
    ).rejects.toThrow(/Rollback failed: target revision\/snapshot '999' not found/);
  });
});
