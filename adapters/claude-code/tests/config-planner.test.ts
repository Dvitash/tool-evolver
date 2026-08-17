import {
  ConfigPreconditionFailedError,
  type HarnessWorkspace,
  InMemoryConfigFsBridge,
} from "@tool-evolver/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  applyClaudeMcpConfig,
  generatePlannedClaudeConfig,
  planClaudeMcpConfig,
  rollbackClaudeMcpConfig,
  verifyClaudeMcpConfig,
} from "../src/config-planner.js";

describe("Claude Code MCP Config Planner", () => {
  const mockWorkspace: HarnessWorkspace = {
    workspaceId: "ws-test-1",
    name: "test-workspace",
    rootPath: "/workspace/project",
    harnessId: "claude-code",
    configPath: "/workspace/project/.claude.json",
    mcpConfigPath: "/workspace/project/.claude.json",
    metadata: {},
  };

  it("generates planned configuration from empty or null content", () => {
    const planned = generatePlannedClaudeConfig(null, "http://127.0.0.1:4545/sse");
    const parsed = JSON.parse(planned);

    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers["tool-evolver"]).toEqual({
      type: "sse",
      url: "http://127.0.0.1:4545/sse",
    });
  });

  it("preserves unrelated MCP servers and other root configuration keys", () => {
    const initialConfig = JSON.stringify(
      {
        theme: "dark",
        allowedTools: ["Bash", "Edit"],
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
          sqlite: {
            command: "uvx",
            args: ["mcp-server-sqlite", "--db-path", "/db.sqlite"],
          },
        },
      },
      null,
      2,
    );

    const planned = generatePlannedClaudeConfig(initialConfig, "http://127.0.0.1:4545/sse");
    const parsed = JSON.parse(planned);

    expect(parsed.theme).toBe("dark");
    expect(parsed.allowedTools).toEqual(["Bash", "Edit"]);
    expect(parsed.mcpServers.github).toBeDefined();
    expect(parsed.mcpServers.sqlite).toBeDefined();
    expect(parsed.mcpServers["tool-evolver"]).toEqual({
      type: "sse",
      url: "http://127.0.0.1:4545/sse",
    });
  });

  it("is idempotent when gateway is already configured with identical URL", () => {
    const initialConfig = generatePlannedClaudeConfig(null, "http://127.0.0.1:4545/sse");
    const secondPlan = generatePlannedClaudeConfig(initialConfig, "http://127.0.0.1:4545/sse");

    expect(secondPlan).toBe(initialConfig);
  });

  it("executes atomic plan, apply, backup, and byte-for-byte rollback", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const initialContent = `${JSON.stringify(
      {
        theme: "light",
        mcpServers: {
          postgres: { url: "postgresql://localhost:5432" },
        },
      },
      null,
      2,
    )}\n`;

    await fsBridge.writeFile(mockWorkspace.configPath, initialContent);

    // 1. Plan mutation
    const plan = await planClaudeMcpConfig(mockWorkspace, "http://127.0.0.1:4545/sse", fsBridge);

    expect(plan.harnessId).toBe("claude-code");
    expect(plan.targetPath).toBe(mockWorkspace.configPath);
    expect(plan.preconditionHash).toBeTruthy();
    expect(plan.plannedContent).toContain("tool-evolver");

    // 2. Apply mutation
    const backup = await applyClaudeMcpConfig(plan, fsBridge);

    expect(backup.targetPath).toBe(mockWorkspace.configPath);
    expect(backup.originalContent).toBe(initialContent);

    const updatedContent = await fsBridge.readFile(mockWorkspace.configPath);
    expect(updatedContent).toContain("tool-evolver");
    expect(updatedContent).toContain("postgres");
    const isVerified = await verifyClaudeMcpConfig(
      mockWorkspace,
      "http://127.0.0.1:4545/sse",
      fsBridge,
    );
    expect(isVerified).toBe(true);

    // 4. Rollback mutation
    await rollbackClaudeMcpConfig(backup, fsBridge);

    const restoredContent = await fsBridge.readFile(mockWorkspace.configPath);
    expect(restoredContent).toBe(initialContent);
    expect(restoredContent).not.toContain("tool-evolver");
  });

  it("fails precondition check if file was modified externally before apply", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    await fsBridge.writeFile(mockWorkspace.configPath, '{"initial": 1}\n');

    const plan = await planClaudeMcpConfig(mockWorkspace, "http://127.0.0.1:4545/sse", fsBridge);

    // Concurrently alter target file
    await fsBridge.writeFile(mockWorkspace.configPath, '{"concurrent_change": 2}\n');

    await expect(applyClaudeMcpConfig(plan, fsBridge)).rejects.toThrow(
      ConfigPreconditionFailedError,
    );
  });

  it("verifies gateway URL presence correctly", async () => {
    const fsBridge = new InMemoryConfigFsBridge();

    expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

    await fsBridge.writeFile(
      mockWorkspace.configPath,
      JSON.stringify({
        mcpServers: {
          "tool-evolver": { url: "http://127.0.0.1:4545/sse", type: "sse" },
        },
      }),
    );

    expect(await verifyClaudeMcpConfig(mockWorkspace, "http://127.0.0.1:4545/sse", fsBridge)).toBe(
      true,
    );
    expect(await verifyClaudeMcpConfig(mockWorkspace, "http://wrong-url:9999", fsBridge)).toBe(
      false,
    );
  });
});
