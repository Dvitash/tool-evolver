import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureDaemonDirectories,
  ensureDaemonDirectoriesSync,
  getDaemonPaths,
  isWsl,
  resolvePaths,
} from "../src/paths.js";

describe("paths", () => {
  describe("resolvePaths", () => {
    it("resolves paths for Linux with default XDG paths", () => {
      const mockEnv: Record<string, string> = {
        HOME: "/home/testuser",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "linux",
        home: "/home/testuser",
      });

      expect(paths.configDir).toBe("/home/testuser/.config/tool-evolver");
      expect(paths.dataDir).toBe("/home/testuser/.local/share/tool-evolver");
      expect(paths.stateDir).toBe("/home/testuser/.local/state/tool-evolver");
      expect(paths.logDir).toBe("/home/testuser/.local/state/tool-evolver/logs");
      expect(paths.socketPath).toBe("/home/testuser/.local/state/tool-evolver/daemon.sock");
      expect(paths.lockFilePath).toBe("/home/testuser/.local/state/tool-evolver/daemon.lock");
      expect(paths.tokenFilePath).toBe("/home/testuser/.local/state/tool-evolver/auth.token");
    });

    it("respects explicit XDG environment variables on Linux", () => {
      const mockEnv: Record<string, string> = {
        HOME: "/home/testuser",
        XDG_CONFIG_HOME: "/custom/config",
        XDG_DATA_HOME: "/custom/data",
        XDG_STATE_HOME: "/custom/state",
        XDG_RUNTIME_DIR: "/run/user/1000",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "linux",
      });

      expect(paths.configDir).toBe("/custom/config/tool-evolver");
      expect(paths.dataDir).toBe("/custom/data/tool-evolver");
      expect(paths.stateDir).toBe("/custom/state/tool-evolver");
      expect(paths.socketPath).toBe("/run/user/1000/tool-evolver.sock");
    });

    it("resolves paths for macOS (darwin)", () => {
      const mockEnv: Record<string, string> = {
        HOME: "/Users/testuser",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "darwin",
        home: "/Users/testuser",
      });

      expect(paths.configDir).toBe("/Users/testuser/Library/Application Support/tool-evolver");
      expect(paths.dataDir).toBe("/Users/testuser/Library/Application Support/tool-evolver");
      expect(paths.stateDir).toBe("/Users/testuser/Library/Caches/tool-evolver");
      expect(paths.logDir).toBe("/Users/testuser/Library/Logs/tool-evolver");
      expect(paths.socketPath).toBe("/Users/testuser/Library/Caches/tool-evolver/daemon.sock");
    });

    it("resolves paths for Windows (win32)", () => {
      const mockEnv: Record<string, string> = {
        USERPROFILE: "C:\\Users\\testuser",
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "win32",
        home: "C:\\Users\\testuser",
      });

      expect(paths.configDir).toContain("AppData");
      expect(paths.configDir).toContain("tool-evolver");
      expect(paths.socketPath).toBe("\\\\.\\pipe\\tool-evolver-daemon");
    });

    it("uses TOOL_EVOLVER_HOME as the root base when provided", () => {
      const customHome = "/tmp/test-tool-evolver-root";
      const paths = resolvePaths({
        toolEvolverHome: customHome,
      });

      expect(paths.homeDir).toBe(customHome);
      expect(paths.configDir).toBe(path.join(customHome, "config"));
      expect(paths.dataDir).toBe(path.join(customHome, "data"));
      expect(paths.stateDir).toBe(path.join(customHome, "state"));
      expect(paths.logDir).toBe(path.join(customHome, "logs"));
      expect(paths.socketPath).toBe(path.join(customHome, "state", "daemon.sock"));
      expect(paths.lockFilePath).toBe(path.join(customHome, "state", "daemon.lock"));
    });

    it("allows granular environment variable overrides", () => {
      const mockEnv: Record<string, string> = {
        TOOL_EVOLVER_CONFIG_DIR: "/override/config",
        TOOL_EVOLVER_DATA_DIR: "/override/data",
        TOOL_EVOLVER_STATE_DIR: "/override/state",
        TOOL_EVOLVER_LOG_DIR: "/override/logs",
        TOOL_EVOLVER_SOCKET_PATH: "/override/socket.sock",
        TOOL_EVOLVER_LOCK_FILE: "/override/my.lock",
        TOOL_EVOLVER_TOKEN_FILE: "/override/my.token",
      };

      const paths = resolvePaths({ env: mockEnv });

      expect(paths.configDir).toBe(path.resolve("/override/config"));
      expect(paths.dataDir).toBe(path.resolve("/override/data"));
      expect(paths.stateDir).toBe(path.resolve("/override/state"));
      expect(paths.logDir).toBe(path.resolve("/override/logs"));
      expect(paths.socketPath).toBe(path.resolve("/override/socket.sock"));
      expect(paths.lockFilePath).toBe(path.resolve("/override/my.lock"));
      expect(paths.tokenFilePath).toBe(path.resolve("/override/my.token"));
    });

    it("getDaemonPaths aliases resolvePaths", () => {
      const paths = getDaemonPaths({ toolEvolverHome: "/tmp/te-test" });
      expect(paths.homeDir).toBe(path.resolve("/tmp/te-test"));
    });
  });

  describe("WSL detection", () => {
    it("detects WSL from environment variable", () => {
      expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
      expect(isWsl({ IS_WSL: "1" })).toBe(true);
      expect(isWsl({})).toBe(false);
    });
  });

  describe("ensureDaemonDirectories", () => {
    it("creates all required directories", async () => {
      const testDir = path.join(
        os.tmpdir(),
        `te-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const paths = resolvePaths({ home: testDir });

      await ensureDaemonDirectories(paths);

      expect(fs.existsSync(paths.homeDir)).toBe(true);
      expect(fs.existsSync(paths.configDir)).toBe(true);
      expect(fs.existsSync(paths.dataDir)).toBe(true);
      expect(fs.existsSync(paths.stateDir)).toBe(true);
      expect(fs.existsSync(paths.logDir)).toBe(true);

      // Cleanup
      await fs.promises.rm(testDir, { recursive: true, force: true });
    });

    it("synchronously creates all required directories", () => {
      const testDir = path.join(
        os.tmpdir(),
        `te-paths-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const paths = resolvePaths({ home: testDir });

      ensureDaemonDirectoriesSync(paths);

      expect(fs.existsSync(paths.homeDir)).toBe(true);
      expect(fs.existsSync(paths.configDir)).toBe(true);
      expect(fs.existsSync(paths.dataDir)).toBe(true);
      expect(fs.existsSync(paths.stateDir)).toBe(true);
      expect(fs.existsSync(paths.logDir)).toBe(true);

      fs.rmSync(testDir, { recursive: true, force: true });
    });
  });
});
