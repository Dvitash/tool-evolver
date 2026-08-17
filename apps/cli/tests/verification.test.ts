import path from "node:path";
import type { IpcClient } from "@tool-evolver/observer";
import { describe, expect, it, vi } from "vitest";
import { createUserServiceManager } from "../src/service/manager.js";
import { VerificationSuite, runVerificationSuite } from "../src/service/verification.js";

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

describe("VerificationSuite", () => {
  const homeDir = "/home/testuser";
  const toolEvolverHome = path.join(homeDir, ".tool-evolver");
  const stateDbPath = path.join(toolEvolverHome, "data", "state.db");
  const socketPath = path.join(toolEvolverHome, "run", "daemon.sock");
  const unitPath = path.join(homeDir, ".config", "systemd", "user", "tool-evolver.service");

  it("passes all checks when all local and cloud components are valid", async () => {
    const fsBridge = createMockFsBridge({
      [toolEvolverHome]: "dir",
      [path.join(toolEvolverHome, "config")]: "dir",
      [stateDbPath]: "sqlite header",
      [socketPath]: "socket",
      [unitPath]: "unit content",
    });

    const mockIpcClient = {
      ping: vi.fn().mockResolvedValue({ pong: true, timestamp: Date.now() }),
      getHealth: vi.fn().mockResolvedValue({
        status: "fully-ready",
        uptimeSeconds: 120,
        startedAt: Date.now() - 120000,
        version: "0.1.0",
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
    } as Response);

    const suite = new VerificationSuite({
      homeDir,
      toolEvolverHome,
      socketPath,
      fsBridge,
      ipcClient: mockIpcClient as unknown as IpcClient,
      customFetch: mockFetch as unknown as typeof fetch,
      allowOffline: true,
    });
    const report = await suite.runAll();
    expect(report.passed).toBe(true);
    expect(report.failedChecks).toBe(0);
    expect(report.checks.length).toBe(9);

    const checkNames = report.checks.map((c) => c.name);
    expect(checkNames).toContain("release_integrity");
    expect(checkNames).toContain("service_state");
    expect(checkNames).toContain("ipc_ping");
    expect(checkNames).toContain("database");
    expect(checkNames).toContain("gateway");
    expect(checkNames).toContain("meta_tools");
    expect(checkNames).toContain("worker_isolation");
    expect(checkNames).toContain("adapter_discovery");
    expect(checkNames).toContain("cloud_auth");
  });

  it("reports warning/failure when daemon socket is offline", async () => {
    const fsBridge = createMockFsBridge({
      [toolEvolverHome]: "dir",
    });

    const suite = new VerificationSuite({
      homeDir,
      toolEvolverHome,
      fsBridge,
      allowOffline: true,
      onlyChecks: ["ipc_ping", "release_integrity"],
    });

    const report = await suite.runAll();
    expect(report.totalChecks).toBe(2);

    const pingCheck = report.checks.find((c) => c.name === "ipc_ping");
    expect(pingCheck).toBeDefined();
    expect(pingCheck?.status).toBe("warn");
    expect(pingCheck?.message).toContain("IPC socket does not exist");
  });

  it("supports selective check execution via onlyChecks and skipChecks", async () => {
    const fsBridge = createMockFsBridge({
      [toolEvolverHome]: "dir",
    });

    const report = await runVerificationSuite({
      homeDir,
      toolEvolverHome,
      fsBridge,
      allowOffline: true,
      skipChecks: ["cloud_auth", "adapter_discovery"],
    });

    const checkNames = report.checks.map((c) => c.name);
    expect(checkNames).not.toContain("cloud_auth");
    expect(checkNames).not.toContain("adapter_discovery");
    expect(checkNames).toContain("meta_tools");
  });
});
