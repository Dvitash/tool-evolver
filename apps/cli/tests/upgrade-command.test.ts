import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_VERSION,
  UpgradeOrchestrator,
  parseUpgradeFlags,
  upgradeCommand,
} from "../src/commands/upgrade.js";

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
    async mkdirp(dirPath: string): Promise<void> {
      files.set(dirPath, "dir");
    },
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

describe("upgrade command & orchestrator", () => {
  const homeDir = "/home/testuser";
  const toolEvolverHome = path.join(homeDir, ".tool-evolver");
  const versionFilePath = path.join(toolEvolverHome, "version.json");

  it("parses upgrade command flags", () => {
    const flags1 = parseUpgradeFlags([
      "--target-version",
      "0.3.0",
      "--force",
      "--dry-run",
      "--no-rollback",
      "--json",
    ]);
    expect(flags1.targetVersion).toBe("0.3.0");
    expect(flags1.force).toBe(true);
    expect(flags1.dryRun).toBe(true);
    expect(flags1.noRollback).toBe(true);
    expect(flags1.json).toBe(true);
  });

  it("simulates upgrade in dry-run mode without modifying filesystem", async () => {
    const fsBridge = createMockFsBridge({
      [versionFilePath]: JSON.stringify({ version: "0.1.0" }),
    });

    const orchestrator = new UpgradeOrchestrator({
      homeDir,
      toolEvolverHome,
      fsBridge,
    });

    const result = await orchestrator.runUpgrade({
      targetVersion: "0.2.0",
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.currentVersion).toBe(CURRENT_VERSION);
    expect(result.targetVersion).toBe("0.2.0");

    // Verify version file was not modified
    const currentFile = await fsBridge.readFile(versionFilePath);
    expect(currentFile).toBeDefined();
    expect(JSON.parse(currentFile!).version).toBe("0.1.0");
  });

  it("executes atomic upgrade with backup and health gate pass", async () => {
    const fsBridge = createMockFsBridge({
      [toolEvolverHome]: "dir",
      [versionFilePath]: JSON.stringify({ version: "0.1.0" }),
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
    } as Response);

    const orchestrator = new UpgradeOrchestrator({
      homeDir,
      toolEvolverHome,
      fsBridge,
      customFetch: mockFetch as unknown as typeof fetch,
      releaseMode: "test-simulated",
    });

    const result = await orchestrator.runUpgrade({
      targetVersion: "0.2.0",
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.healthGatePassed).toBe(true);
    expect(result.backupPath).toBeDefined();

    // Verify version file was updated to 0.2.0
    const newVersionContent = await fsBridge.readFile(versionFilePath);
    expect(newVersionContent).toBeDefined();
    const parsed = JSON.parse(newVersionContent!);
    expect(parsed.version).toBe("0.2.0");
    expect(parsed.previousVersion).toBe("0.1.0");
  });

  it("triggers automatic rollback on health gate verification failure", async () => {
    const fsBridge = createMockFsBridge({
      [versionFilePath]: JSON.stringify({ version: "0.1.0" }),
    });

    // Simulate verification failure by missing home directory after upgrade
    const orchestrator = new UpgradeOrchestrator({
      homeDir,
      toolEvolverHome,
      fsBridge,
      releaseMode: "test-simulated",
    });

    // We can simulate failure by deleting toolEvolverHome or using a mock that fails
    const result = await orchestrator.runUpgrade({
      targetVersion: "0.2.0",
      force: true,
    });

    // Since toolEvolverHome does not exist initially in fsBridge, release_integrity will fail health gate
    expect(result.success).toBe(false);
    expect(result.healthGatePassed).toBe(false);
    expect(result.rolledBack).toBe(true);

    // Verify version file was rolled back to original content
    const restored = await fsBridge.readFile(versionFilePath);
    expect(restored).toBeDefined();
    expect(JSON.parse(restored!).version).toBe("0.1.0");
  });

  it("executes upgradeCommand with JSON output", async () => {
    const fsBridge = createMockFsBridge({
      [toolEvolverHome]: "dir",
      [versionFilePath]: JSON.stringify({ version: "0.1.0" }),
    });

    const stdoutChunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    try {
      const exitCode = await upgradeCommand(
        ["--target-version", "0.2.0", "--dry-run", "--json", "--home", homeDir],
        { fsBridge },
      );

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdoutChunks.join(""));
      expect(output.success).toBe(true);
      expect(output.dryRun).toBe(true);
    } finally {
      process.stdout.write = originalStdout;
    }
  });
});
