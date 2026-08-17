import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryConfigFsBridge } from "@tool-evolver/harness-contracts";
import { describe, expect, it } from "vitest";
import { CodexCliAdapter, CodexHarnessAdapter } from "../src/adapter.js";

describe("CodexHarnessAdapter", () => {
  it("initializes with correct id, name, and version", () => {
    const adapter = new CodexHarnessAdapter();
    expect(adapter.id).toBe("codex-cli");
    expect(adapter.name).toBe("Codex CLI");
    expect(adapter.version).toBe("0.1.0");

    // Check alias
    const aliasAdapter = new CodexCliAdapter();
    expect(aliasAdapter.id).toBe("codex-cli");
  });

  it("reports full adapter capabilities with observation fidelity and refresh", () => {
    const adapter = new CodexHarnessAdapter();
    const caps = adapter.getCapabilities();

    expect(caps.supportsMultiWorkspace).toBe(true);
    expect(caps.supportsConcurrentSessions).toBe(true);
    expect(caps.features.atomicConfig).toBe(true);
    expect(caps.features.fileTailing).toBe(true);
    expect(caps.features.subagents).toBe(true);
    expect(caps.fidelity.transcriptAvailability).toBe("file_tail");
    expect(caps.fidelity.toolCallVisibility).toBe("full");
    expect(caps.fidelity.toolResultVisibility).toBe("full");
    expect(caps.refresh.requiresSessionRestart).toBe(true);
  });

  it("probes installation via discovery module", async () => {
    const adapter = new CodexHarnessAdapter({
      pathLookup: async () => "/usr/local/bin/codex",
      executor: async () => ({ stdout: "codex 0.45.0", stderr: "", exitCode: 0 }),
    });

    const install = await adapter.probeInstallation();
    expect(install.status).toBe("ready");
    expect(install.version).toBe("0.45.0");
  });

  it("discovers workspaces and lists/finds sessions in session root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-test-"));
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Create mock session files
    const sess1Path = path.join(sessionsDir, "sess_01.jsonl");
    const sess2Path = path.join(sessionsDir, "sess_02.jsonl");
    await fs.writeFile(sess1Path, '{"type":"user_message","content":"Hi"}\n', "utf8");
    await fs.writeFile(sess2Path, '{"type":"user_message","content":"Hello"}\n', "utf8");

    const adapter = new CodexHarnessAdapter({
      customSessionRoot: sessionsDir,
    });

    const workspaces = await adapter.listWorkspaces();
    expect(workspaces).toHaveLength(1);
    const ws = workspaces[0]!;
    expect(ws.metadata?.sessionRoot).toBe(sessionsDir);

    const sessions = await adapter.listSessions(ws);
    expect(sessions).toHaveLength(2);

    const activeSession = await adapter.getActiveSession(ws);
    expect(activeSession).toBeDefined();
    expect(["sess_01", "sess_02"]).toContain(activeSession?.sessionId);

    // Create event source from session
    const source = await adapter.createEventSource(activeSession!);
    expect(source).toBeDefined();
    const records = await source.readNext();
    expect(records.length).toBeGreaterThanOrEqual(1);

    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("executes config mutation planning, application, and verification", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const adapter = new CodexHarnessAdapter({ fsBridge });

    const workspaces = await adapter.listWorkspaces();
    const ws = workspaces[0]!;

    const plan = await adapter.planMcpConfig(ws, "http://127.0.0.1:4000/sse");
    expect(plan.plannedContent).toContain("[mcp_servers.tool_evolver_gateway]");

    const backup = await adapter.applyMcpConfig(plan);
    expect(backup.targetPath).toBe(ws.configPath);

    const verified = await adapter.verifyMcpConfig(ws);
    expect(verified).toBe(true);
  });

  it("notifies catalog refresh", async () => {
    const adapter = new CodexHarnessAdapter();
    const workspaces = await adapter.listWorkspaces();
    const ws = workspaces[0]!;

    const result = await adapter.notifyCatalogRefresh(ws, {
      addedToolIds: ["tool_new_01"],
      updatedToolIds: [],
      removedToolIds: [],
      catalogVersion: "2.0.0",
      timestamp: "2026-08-17T12:00:00.000Z",
    });

    expect(result.outcome).toBe("next_session_required");
    expect(result.requiresRestart).toBe(true);
  });
});
