import path from "node:path";
import {
  ConfigPreconditionFailedError,
  InMemoryConfigFsBridge,
  computeConfigHash,
} from "@tool-evolver/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  applyOmpMcpConfig,
  planOmpMcpConfig,
  resolveOmpConfigPath,
  rollbackOmpMcpConfig,
  verifyOmpMcpConfig,
} from "../src/config-planner.js";

describe("OMP Config Planner, MCP Registration, Idempotency & Rollback", () => {
  it("resolves config paths across custom, workspace, and global scopes", () => {
    const custom = resolveOmpConfigPath(undefined, { customConfigPath: "/custom/path.json" });
    expect(custom).toBe(resolveOmpConfigPath(undefined, { customConfigPath: "/custom/path.json" }));

    const globalHome = "/test/custom-home/.omp";
    const globalConfig = resolveOmpConfigPath(undefined, { ompHome: globalHome });
    expect(globalConfig).toBe(path.resolve(globalHome, "agent", "mcp.json"));

    const wsConfig = resolveOmpConfigPath({
      workspaceId: "ws-1",
      rootPath: "/repo/app",
      name: "app",
      harnessId: "omp",
      configPath: "/repo/app/.omp/agent/mcp.json",
      metadata: {},
    });
    expect(wsConfig).toContain(".omp");
    expect(wsConfig).toContain(path.join("agent", "mcp.json"));

    const explicitWsMcp = resolveOmpConfigPath({
      workspaceId: "ws-2",
      rootPath: "/repo/app2",
      name: "app2",
      harnessId: "omp",
      configPath: "/repo/app2/.omp/agent/mcp.json",
      mcpConfigPath: "/repo/app2/custom-mcp.json",
      metadata: {},
    });
    expect(explicitWsMcp).toBe(path.resolve("/repo/app2/custom-mcp.json"));
  });

  it("plans MCP config mutation on a missing / empty config file creating valid shape", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/test/home/.omp/agent/mcp.json";

    const plan = await planOmpMcpConfig({
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      customConfigPath: configPath,
      fsBridge,
    });

    expect(plan.harnessId).toBe("omp");
    expect(plan.targetPath).toBe(configPath);
    expect(plan.preconditionHash).toBe("");

    const hash = computeConfigHash(plan.plannedContent);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    const plannedParsed = JSON.parse(plan.plannedContent) as {
      mcpServers: { "tool-evolver-gateway": { url: string; type: string } };
    };
    expect(plannedParsed.mcpServers["tool-evolver-gateway"]).toEqual({
      url: "http://127.0.0.1:4000/mcp/sse",
      type: "sse",
    });

    const backup = await applyOmpMcpConfig(plan, fsBridge);
    expect(backup.targetPath).toBe(configPath);
    expect(await fsBridge.exists(configPath)).toBe(true);

    const verified = await verifyOmpMcpConfig({
      customConfigPath: configPath,
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      fsBridge,
    });
    expect(verified).toBe(true);
  });

  it("injection into a scratch HOME writes ~/.omp/agent/mcp.json containing the new server under mcpServers, preserves a pre-existing server entry, and creates a backup file", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const ompHome = "/scratch/home/.omp";
    const targetMcpPath = path.resolve(ompHome, "agent", "mcp.json");

    const initialConfig = {
      $schema: "https://json.schemastore.org/mcp-server-config.json",
      theme: "dark",
      mcpServers: {
        "pre-existing-tool": {
          type: "stdio",
          command: "python",
          args: ["-m", "tool"],
          env: { FOO: "bar" },
        },
      },
    };
    const initialContent = `${JSON.stringify(initialConfig, null, 2)}\n`;
    await fsBridge.writeFile(targetMcpPath, initialContent);

    const plan = await planOmpMcpConfig({
      ompHome,
      serverName: "tool-evolver-gateway",
      command: "tool-evolver-gateway",
      args: ["--stdio"],
      env: { PORT: "4000" },
      fsBridge,
    });

    expect(plan.targetPath).toBe(targetMcpPath);

    const backup = await applyOmpMcpConfig(plan, fsBridge);
    expect(backup.targetPath).toBe(targetMcpPath);
    expect(backup.originalContent).toBe(initialContent);
    expect(await fsBridge.exists(backup.backupPath)).toBe(true);
    expect(await fsBridge.readFile(backup.backupPath)).toBe(initialContent);

    const mutatedContent = await fsBridge.readFile(targetMcpPath);
    expect(mutatedContent).not.toBeNull();
    const parsed = JSON.parse(mutatedContent!);
    expect(parsed.$schema).toBe("https://json.schemastore.org/mcp-server-config.json");
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers["pre-existing-tool"]).toEqual({
      type: "stdio",
      command: "python",
      args: ["-m", "tool"],
      env: { FOO: "bar" },
    });
    expect(parsed.mcpServers["tool-evolver-gateway"]).toEqual({
      type: "stdio",
      command: "tool-evolver-gateway",
      args: ["--stdio"],
      env: { PORT: "4000" },
    });

    const verified = await verifyOmpMcpConfig({
      ompHome,
      serverName: "tool-evolver-gateway",
      command: "tool-evolver-gateway",
      fsBridge,
    });
    expect(verified).toBe(true);

    await rollbackOmpMcpConfig(backup, fsBridge);
    const restoredContent = await fsBridge.readFile(targetMcpPath);
    expect(restoredContent).toBe(initialContent);
    expect(await fsBridge.exists(backup.backupPath)).toBe(true);
  });

  it("preserves existing extensions, user preferences, and other MCP servers", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/test/home/.omp/agent/mcp.json";

    const initialConfig = {
      $schema: "https://json.schemastore.org/mcp-server-config.json",
      theme: "monokai",
      model: "gpt-4o",
      extensions: ["omp-plugin-git", "omp-plugin-diff"],
      userSettings: {
        fontSize: 14,
        telemetry: false,
      },
      mcpServers: {
        "existing-db-server": {
          command: "node",
          args: ["db-server.js"],
        },
      },
    };

    await fsBridge.writeFile(configPath, JSON.stringify(initialConfig, null, 2));

    const plan = await planOmpMcpConfig({
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      customConfigPath: configPath,
      fsBridge,
    });

    const plannedParsed = JSON.parse(plan.plannedContent) as typeof initialConfig & {
      mcpServers: {
        "existing-db-server": { command: string; args: string[] };
        "tool-evolver-gateway": { url: string; type: string };
      };
    };

    expect(plannedParsed.$schema).toBe("https://json.schemastore.org/mcp-server-config.json");
    expect(plannedParsed.theme).toBe("monokai");
    expect(plannedParsed.model).toBe("gpt-4o");
    expect(plannedParsed.extensions).toEqual(["omp-plugin-git", "omp-plugin-diff"]);
    expect(plannedParsed.userSettings).toEqual({ fontSize: 14, telemetry: false });
    expect(plannedParsed.mcpServers["existing-db-server"]).toEqual({
      command: "node",
      args: ["db-server.js"],
    });
    expect(plannedParsed.mcpServers["tool-evolver-gateway"]).toEqual({
      url: "http://127.0.0.1:4000/mcp/sse",
      type: "sse",
    });
  });

  it("is idempotent when re-planning against already mutated config", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/test/home/.omp/agent/mcp.json";

    const plan1 = await planOmpMcpConfig({
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      customConfigPath: configPath,
      fsBridge,
    });

    await applyOmpMcpConfig(plan1, fsBridge);

    const plan2 = await planOmpMcpConfig({
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      customConfigPath: configPath,
      fsBridge,
    });

    const parsed1 = JSON.parse(plan1.plannedContent);
    const parsed2 = JSON.parse(plan2.plannedContent);
    expect(parsed1).toEqual(parsed2);
  });

  it("prefers agent/mcp.json and leaves legacy config.json untouched when present", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const ompHome = "/test/legacy-home/.omp";
    const legacyConfigPath = path.resolve(ompHome, "config.json");
    const legacyContent = JSON.stringify({ legacyField: "old_value" }, null, 2);
    await fsBridge.writeFile(legacyConfigPath, legacyContent);

    const plan = await planOmpMcpConfig({
      ompHome,
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      fsBridge,
    });

    expect(plan.targetPath).toBe(path.resolve(ompHome, "agent", "mcp.json"));

    await applyOmpMcpConfig(plan, fsBridge);

    // Verify legacy file is untouched
    const currentLegacyContent = await fsBridge.readFile(legacyConfigPath);
    expect(currentLegacyContent).toBe(legacyContent);

    // Verify new agent/mcp.json was created
    const newContent = await fsBridge.readFile(path.resolve(ompHome, "agent", "mcp.json"));
    expect(newContent).not.toBeNull();
    expect(JSON.parse(newContent!).mcpServers["tool-evolver-gateway"]).toBeDefined();
  });

  it("throws ConfigPreconditionFailedError when current content changes before apply", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/test/home/.omp/agent/mcp.json";

    await fsBridge.writeFile(configPath, JSON.stringify({ version: 1 }));

    const plan = await planOmpMcpConfig({
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      customConfigPath: configPath,
      fsBridge,
    });

    // Concurrently modify file before apply
    await fsBridge.writeFile(configPath, JSON.stringify({ version: 2 }));

    await expect(applyOmpMcpConfig(plan, fsBridge)).rejects.toThrow(ConfigPreconditionFailedError);
  });
});
