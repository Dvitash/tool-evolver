import {
  type HarnessWorkspace,
  InMemoryConfigFsBridge,
  type StrictHarnessAdapter,
} from "@tool-evolver/harness-contracts";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, ClaudeHarnessAdapter } from "../src/adapter.js";

describe("ClaudeHarnessAdapter", () => {
  const mockWorkspace: HarnessWorkspace = {
    workspaceId: "ws-adapter-test",
    name: "adapter-test",
    rootPath: "/workspace/app",
    harnessId: "claude-code",
    configPath: "/workspace/app/.claude.json",
    mcpConfigPath: "/workspace/app/.claude.json",
    activeSessionId: "session-active-1",
    metadata: {},
  };

  it("satisfies StrictHarnessAdapter contract interface", () => {
    const adapter: StrictHarnessAdapter = new ClaudeHarnessAdapter();

    expect(adapter.id).toBe("claude-code");
    expect(adapter.name).toBe("Claude Code");
    expect(adapter.version).toBe("0.1.0");
    expect(adapter.supportedHarnessVersions.length).toBeGreaterThan(0);
  });

  it("reports accurate capabilities and fidelity rating", () => {
    const adapter = new ClaudeHarnessAdapter();
    const caps = adapter.getCapabilities();

    expect(caps.fidelity.transcriptAvailability).toBe("file_tail");
    expect(caps.fidelity.toolCallVisibility).toBe("full");
    expect(caps.fidelity.toolResultVisibility).toBe("full");
    expect(caps.fidelity.subagentVisibility).toBe("shallow");
    expect(caps.fidelity.mcpListChange).toBe("unsupported");
    expect(caps.fidelity.contextNudge).toBe("via_prompt");
    expect(caps.fidelity.overallScore).toBe(78);

    expect(caps.refresh.supportsNativeListChange).toBe(false);
    expect(caps.refresh.supportsContextNudge).toBe(true);
    expect(caps.refresh.requiresSessionRestart).toBe(false);
  });

  it("executes full adapter integration flow", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const mockExec = async () => ({ stdout: "claude 0.2.14\n", stderr: "" });

    const adapter = new ClaudeHarnessAdapter({
      fsBridge,
      execFn: mockExec,
    });

    // 1. Probe installation
    const installation = await adapter.probeInstallation({
      customExecutablePath: "/usr/bin/claude",
      customConfigPath: mockWorkspace.configPath,
    });
    expect(installation).not.toBeNull();
    expect(installation?.isInstalled).toBe(true);
    expect(installation?.version).toBe("0.2.14");

    // 2. Resolve sessions
    const activeSession = await adapter.resolveActiveSession(mockWorkspace);
    expect(activeSession).not.toBeNull();
    expect(activeSession?.sessionId).toBe("session-active-1");

    // 3. Plan & Apply MCP Config
    const plan = await adapter.planMcpConfig(mockWorkspace, "http://127.0.0.1:4545/sse");
    expect(plan.harnessId).toBe("claude-code");

    const backup = await adapter.applyMcpConfig(plan);
    expect(backup.targetPath).toBe(mockWorkspace.configPath);

    const verified = await adapter.verifyMcpConfig(mockWorkspace);
    expect(verified).toBe(true);

    // 4. Open Event Source
    expect(activeSession).not.toBeNull();
    if (!activeSession) throw new Error("Expected active session");
    const eventSource = await adapter.openEventSource(activeSession);
    expect(eventSource).toBeDefined();
    expect(eventSource.getCursor()).toBeDefined();
    await eventSource.close();

    // 5. Notify Catalog Refresh
    const refreshResult = await adapter.notifyCatalogRefresh(mockWorkspace, {
      addedToolIds: ["new_tool"],
      updatedToolIds: [],
      removedToolIds: [],
      catalogVersion: "1.1.0",
      timestamp: "2026-08-17T12:00:00.000Z",
    });
    expect(refreshResult.outcome).toBe("context_nudge");
    expect(refreshResult.catalogVersion).toBe("1.1.0");
  });

  it("supports backward-compatible alias and mock execution", async () => {
    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize();

    const res = await adapter.execute(
      { id: "tool-1", name: "test_tool", version: "1.0.0", description: "desc" },
      { key: "value" },
    );

    expect(res).toEqual({
      adapter: "claude-code",
      toolId: "tool-1",
      input: { key: "value" },
      output: "claude-code-response",
    });
  });
});
