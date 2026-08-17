import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import {
  collectStatus,
  formatStatusForTerminal,
  parseStatusFlags,
  statusCommand,
} from "../src/commands/status.js";

function createMockFsBridge(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    async readFile(filePath: string): Promise<string | null> {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async exists(filePath: string): Promise<boolean> {
      return files.has(filePath);
    },
    async mkdirp(_dirPath: string): Promise<void> {},
    async copyFile(src: string, dest: string): Promise<void> {
      const c = files.get(src);
      if (c !== undefined) files.set(dest, c);
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
    async chmod(_filePath: string, _mode: number): Promise<void> {},
  };
}

describe("status command & collector", () => {
  const homeDir = "/home/testuser";
  const toolEvolverHome = path.join(homeDir, ".tool-evolver");

  it("parses CLI status flags correctly", () => {
    const flags1 = parseStatusFlags([
      "--json",
      "--home",
      "/custom/home",
      "--socket",
      "/custom/sock",
    ]);
    expect(flags1.json).toBe(true);
    expect(flags1.home).toBe("/custom/home");
    expect(flags1.socket).toBe("/custom/sock");

    const flags2 = parseStatusFlags(["-h"]);
    expect(flags2.help).toBe(true);
  });

  it("collects comprehensive status report", async () => {
    const claudePath = path.join(homeDir, ".claude.json");
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    const ompPath = path.join(homeDir, ".omp", "config.json");

    const fsBridge = createMockFsBridge({
      [claudePath]: JSON.stringify({
        mcpServers: { "tool-evolver": { url: "http://localhost:9400" } },
      }),
      [codexPath]: "[mcp_servers.tool-evolver]\nurl = 'http://localhost:9400'\n",
      [ompPath]: JSON.stringify({
        mcpServers: { "tool-evolver": { url: "http://localhost:9400" } },
      }),
    });

    const summary = await collectStatus({
      home: homeDir,
      fsBridge,
    });

    expect(summary.service).toBeDefined();
    expect(summary.ipc).toBeDefined();
    expect(summary.cloud).toBeDefined();
    expect(summary.tools.metaToolsCount).toBeGreaterThanOrEqual(4);
    expect(summary.harnesses.length).toBe(3);

    const claudeHarness = summary.harnesses.find((h) => h.id === "claude-code");
    expect(claudeHarness?.configured).toBe(true);
  });

  it("formats terminal output with all essential sections", async () => {
    const summary = {
      service: {
        installed: true,
        active: true,
        enabled: true,
        platform: "systemd",
        serviceName: "tool-evolver.service",
        pid: 9999,
      },
      ipc: {
        connected: true,
        pingLatencyMs: 2,
        daemonVersion: "0.1.0",
        uptimeSeconds: 300,
      },
      cloud: {
        authenticated: true,
        workspaceId: "ws_prod",
        deviceId: "dev_laptop",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        expired: false,
        scopes: ["device:connect", "observations:write"],
      },
      tools: {
        metaToolsCount: 4,
        metaTools: ["search_tools", "get_tool_schema", "invoke_tool", "manage_tools"],
        activeCustomToolsCount: 2,
      },
      harnesses: [
        {
          id: "claude-code",
          name: "Claude Code",
          installed: true,
          configured: true,
          configPath: "/home/user/.claude.json",
        },
      ],
    };

    const terminalOutput = formatStatusForTerminal(summary);
    expect(terminalOutput).toContain("TOOL EVOLVER SYSTEM STATUS");
    expect(terminalOutput).toContain("[Daemon Service]");
    expect(terminalOutput).toContain("PID:        9999");
    expect(terminalOutput).toContain("[IPC & Subsystems]");
    expect(terminalOutput).toContain("[Cloud Authentication]");
    expect(terminalOutput).toContain("Workspace:  ws_prod");
    expect(terminalOutput).toContain("[Tools & MCP Catalog]");
    expect(terminalOutput).toContain("[Agent Harness Connections]");
    expect(terminalOutput).toContain("Claude Code");
  });

  it("executes statusCommand with --json emitting valid json", async () => {
    const stdoutChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    try {
      const exitCode = await statusCommand(["--json", "--home", homeDir], {
        fsBridge: createMockFsBridge(),
      });

      expect(exitCode).toBe(0);
      const fullOutput = stdoutChunks.join("");
      const parsed = JSON.parse(fullOutput);
      expect(parsed.service).toBeDefined();
      expect(parsed.tools).toBeDefined();
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });
});
