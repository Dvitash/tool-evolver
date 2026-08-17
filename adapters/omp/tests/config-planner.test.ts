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

    const wsConfig = resolveOmpConfigPath({
      workspaceId: "ws-1",
      rootPath: "/repo/app",
      name: "app",
      harnessId: "omp",
      configPath: "/repo/app/.omp/config.json",
      metadata: {},
    });
    expect(wsConfig).toContain(".omp");
    expect(wsConfig).toContain("config.json");
  });

  it("plans MCP config mutation on an empty config file", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/test/home/.omp/config.json";

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
  });

  it("preserves existing extensions, user preferences, and other MCP servers", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/test/home/.omp/config.json";

    const initialConfig = {
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

    expect(plan.preconditionHash).not.toBe("");

    const plannedParsed = JSON.parse(plan.plannedContent) as typeof initialConfig & {
      mcpServers: {
        "existing-db-server": unknown;
        "tool-evolver-gateway": { url: string; type: string };
      };
    };

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
    const configPath = "/test/home/.omp/config.json";

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

  it("applies mutation, creates backup, verifies config, and rolls back cleanly", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/test/home/.omp/config.json";

    const initialContent = `${JSON.stringify({ custom: "value" }, null, 2)}\n`;
    await fsBridge.writeFile(configPath, initialContent);

    const plan = await planOmpMcpConfig({
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      customConfigPath: configPath,
      fsBridge,
    });

    const backup = await applyOmpMcpConfig(plan, fsBridge);
    expect(backup.targetPath).toBe(configPath);
    expect(backup.originalContent).toBe(initialContent);

    // Verify
    const isVerified = await verifyOmpMcpConfig({
      customConfigPath: configPath,
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      fsBridge,
    });
    expect(isVerified).toBe(true);

    // Rollback
    await rollbackOmpMcpConfig(backup, fsBridge);
    const restoredContent = await fsBridge.readFile(configPath);
    expect(restoredContent).toBe(initialContent);

    const isVerifiedAfterRollback = await verifyOmpMcpConfig({
      customConfigPath: configPath,
      gatewayUrl: "http://127.0.0.1:4000/mcp/sse",
      fsBridge,
    });
    expect(isVerifiedAfterRollback).toBe(false);
  });

  it("throws ConfigPreconditionFailedError when current content changes before apply", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/test/home/.omp/config.json";

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
