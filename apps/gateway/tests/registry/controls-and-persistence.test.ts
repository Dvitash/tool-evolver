import type { ToolManifest } from "@tool-evolver/contracts";
import { createInMemoryStateStore } from "@tool-evolver/db";
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

describe("ToolRegistry - User Pin, Disable & SQLite Persistence", () => {
  it("locks tool version when pinned and respects pin during catalog resolution", async () => {
    const registry = new ToolRegistry();
    const manifestV1 = makeManifest({ id: "tool_pinned", name: "toolPinned", version: "1.0.0" });
    const manifestV2 = makeManifest({ id: "tool_pinned", name: "toolPinned", version: "2.0.0" });

    await registry.stageToolVersion(manifestV1);
    await registry.stageToolVersion(manifestV2);

    await registry.activateToolVersion("tool_pinned", "1.0.0", "ws-pin");
    await registry.pinToolVersion("tool_pinned", "1.0.0", "ws-pin");

    const controls = await registry.controls.getControls("ws-pin");
    expect(controls.pinnedVersions["tool_pinned"]).toBe("1.0.0");

    const catalog = await registry.resolveCatalog("ws-pin");
    expect(catalog.tools["tool_pinned"].version).toBe("1.0.0");
  });

  it("omits disabled tools from resolved catalog and restores on enable", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ id: "tool_toggle", name: "toolToggle", version: "1.0.0" });

    await registry.stageToolVersion(manifest);
    await registry.activateToolVersion("tool_toggle", "1.0.0", "ws-disable");

    const before = await registry.resolveCatalog("ws-disable");
    expect(before.tools["tool_toggle"]).toBeDefined();

    // Disable tool
    await registry.disableTool("tool_toggle", "ws-disable");
    const disabledCatalog = await registry.resolveCatalog("ws-disable");
    expect(disabledCatalog.tools["tool_toggle"]).toBeUndefined();

    // Enable tool
    await registry.enableTool("tool_toggle", "ws-disable");
    const enabledCatalog = await registry.resolveCatalog("ws-disable");
    expect(enabledCatalog.tools["tool_toggle"]).toBeDefined();
  });

  it("persists user pin and disable controls across gateway restart using @tool-evolver/db", async () => {
    const store = await createInMemoryStateStore();
    const conn = store.getConnection();

    const registry1 = new ToolRegistry({ db: conn });
    const manifest = makeManifest({ id: "tool_persist", name: "toolPersist", version: "1.0.0" });

    await registry1.stageToolVersion(manifest);
    await registry1.activateToolVersion("tool_persist", "1.0.0", "ws-db");
    await registry1.pinToolVersion("tool_persist", "1.0.0", "ws-db");
    await registry1.disableTool("tool_other", "ws-db");

    // Simulate gateway restart with same database connection
    const registry2 = new ToolRegistry({ db: conn });
    await registry2.stageToolVersion(manifest);
    await registry2.activateToolVersion("tool_persist", "1.0.0", "ws-db");

    const reloadedControls = await registry2.controls.getControls("ws-db");
    expect(reloadedControls.pinnedVersions["tool_persist"]).toBe("1.0.0");
    expect(reloadedControls.disabledTools).toContain("tool_other");

    const reloadedCatalog = await registry2.resolveCatalog("ws-db");
    expect(reloadedCatalog.tools["tool_persist"].version).toBe("1.0.0");
  });
});
