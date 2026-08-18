import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ServiceCommandResult,
  type ServiceCommandRunner,
  createUserServiceManager,
  healthCheckDaemonService,
  restartDaemonService,
  setupAndStartDaemonService,
  stopDaemonService,
  uninstallDaemonService,
} from "../../src/installer/user-service.js";
import {
  LaunchdUserServiceManager,
  SystemdUserServiceManager,
  WslUserServiceManager,
} from "../../src/service/manager.js";

/**
 * Mock Service Command Runner that records executed commands and returns configured responses.
 */
class MockServiceCommandRunner implements ServiceCommandRunner {
  readonly commands: Array<{ cmd: string; args: string[] }> = [];
  statusOutput = "active (running)";
  statusExitCode = 0;
  statusPid = 4242;

  async run(cmd: string, args: string[]): Promise<ServiceCommandResult> {
    this.commands.push({ cmd, args });

    const cmdStr = `${cmd} ${args.join(" ")}`;

    // Systemctl is-active
    if (args.includes("is-active")) {
      return {
        stdout: this.statusExitCode === 0 ? "active\n" : "inactive\n",
        stderr: "",
        exitCode: this.statusExitCode,
      };
    }

    // Systemctl is-enabled
    if (args.includes("is-enabled")) {
      return {
        stdout: "enabled\n",
        stderr: "",
        exitCode: 0,
      };
    }

    // Systemctl status
    if (args.includes("status")) {
      return {
        stdout: `● tool-evolver.service - Tool Evolver Background Daemon\n   Loaded: loaded\n   Active: ${this.statusOutput}\n   Main PID: ${this.statusPid}\n`,
        stderr: "",
        exitCode: this.statusExitCode,
      };
    }

    // Systemctl show PID
    if (cmdStr.includes("show") && cmdStr.includes("MainPID")) {
      return {
        stdout: `MainPID=${this.statusPid}\nActiveState=active\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    // Launchctl print mock
    if (cmdStr.includes("launchctl print")) {
      return {
        stdout: `state = running\npid = ${this.statusPid}\n`,
        stderr: "",
        exitCode: this.statusExitCode,
      };
    }

    // Default success for start, stop, daemon-reload, bootstrap, bootout
    return {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    };
  }
}

describe("user-service-manager: Non-root user-level service supervisors", () => {
  let tempDir: string;
  let fakeHome: string;
  let toolEvolverHome: string;
  let mockRunner: MockServiceCommandRunner;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-service-test-"));
    fakeHome = path.join(tempDir, "home");
    toolEvolverHome = path.join(fakeHome, ".tool-evolver");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(toolEvolverHome, { recursive: true });
    mockRunner = new MockServiceCommandRunner();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("SystemdUserServiceManager", () => {
    it("generates user-level systemd unit file in ~/.config/systemd/user/ without root", async () => {
      const manager = new SystemdUserServiceManager({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      expect(manager.name).toBe("systemd");
      const unitPath = manager.getUnitPath();
      expect(unitPath).toBe(
        path.join(fakeHome, ".config", "systemd", "user", "tool-evolver.service"),
      );

      const unitDef = manager.getUnitDefinition();
      expect(unitDef).toContain("[Unit]");
      expect(unitDef).toContain("Description=Tool Evolver Daemon");
      expect(unitDef).toContain("[Service]");
      expect(unitDef).toContain("ExecStart=");
      expect(unitDef).toContain(`Environment=TOOL_EVOLVER_HOME=${toolEvolverHome}`);
      expect(unitDef).toContain("Restart=on-failure");
      expect(unitDef).toContain("[Install]");
      expect(unitDef).toContain("WantedBy=default.target");
    });

    it("installs, starts, and queries status through systemctl --user", async () => {
      const manager = new SystemdUserServiceManager({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      // Install
      const installResult = await manager.install({
        daemonPath: path.join(toolEvolverHome, "bin", "tool-evolver-daemon"),
      });

      expect(installResult.success).toBe(true);
      expect(fs.existsSync(installResult.unitPath)).toBe(true);

      // Verify systemctl --user commands were executed
      const daemonReloadCmd = mockRunner.commands.find(
        (c) => c.cmd === "systemctl" && c.args.includes("daemon-reload"),
      );
      expect(daemonReloadCmd).toBeDefined();

      // Start
      await manager.start();
      const startCmd = mockRunner.commands.find(
        (c) => c.cmd === "systemctl" && c.args.includes("start"),
      );
      expect(startCmd).toBeDefined();

      // Status
      const status = await manager.status();
      expect(status.installed).toBe(true);
      expect(status.active).toBe(true);

      // Stop
      await manager.stop();
      const stopCmd = mockRunner.commands.find(
        (c) => c.cmd === "systemctl" && c.args.includes("stop"),
      );
      expect(stopCmd).toBeDefined();

      // Uninstall
      const uninstallResult = await manager.uninstall();
      expect(uninstallResult.success).toBe(true);
      expect(fs.existsSync(installResult.unitPath)).toBe(false);
    });
  });

  describe("LaunchdUserServiceManager", () => {
    it("generates user-level launchd plist in ~/Library/LaunchAgents/ without root", async () => {
      const manager = new LaunchdUserServiceManager({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      expect(manager.name).toBe("launchd");
      const plistPath = manager.getUnitPath();
      expect(plistPath).toBe(
        path.join(fakeHome, "Library", "LaunchAgents", "com.tool-evolver.daemon.plist"),
      );

      const plistContent = manager.getUnitDefinition();
      expect(plistContent).toContain("<key>Label</key>");
      expect(plistContent).toContain("<string>com.tool-evolver.daemon</string>");
      expect(plistContent).toContain("<key>ProgramArguments</key>");
      expect(plistContent).toContain("<key>KeepAlive</key>");
      expect(plistContent).toContain("<key>StandardOutPath</key>");
      expect(plistContent).toContain("<key>StandardErrorPath</key>");
    });

    it("installs, starts, and manages launchd service", async () => {
      const manager = new LaunchdUserServiceManager({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      const installResult = await manager.install({
        daemonPath: path.join(toolEvolverHome, "bin", "tool-evolver-daemon"),
      });

      expect(installResult.success).toBe(true);
      expect(fs.existsSync(installResult.unitPath)).toBe(true);

      // Start
      await manager.start();

      // Status
      const status = await manager.status();
      expect(status.installed).toBe(true);
      expect(status.active).toBe(true);

      // Uninstall
      const uninstallResult = await manager.uninstall();
      expect(uninstallResult.success).toBe(true);
      expect(fs.existsSync(installResult.unitPath)).toBe(false);
    });
  });

  describe("WslUserServiceManager", () => {
    it("configures WSL supervisor service correctly", async () => {
      const manager = new WslUserServiceManager({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      expect(manager.name).toBe("wsl");
      const unitPath = manager.getUnitPath();
      expect(unitPath).toBeDefined();

      const unitDef = manager.getUnitDefinition();
      expect(unitDef).toBeDefined();
    });
  });

  describe("setupAndStartDaemonService & healthCheckDaemonService orchestration", () => {
    it("orchestrates user service installation and health verification end-to-end", async () => {
      const setupResult = await setupAndStartDaemonService({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
        autoStart: true,
      });

      expect(setupResult.success).toBe(true);
      expect(setupResult.installed).toBe(true);
      expect(setupResult.started).toBe(true);
      expect(setupResult.healthy).toBe(true);
      expect(setupResult.serviceType).toBeDefined();

      // Perform separate health check
      const health = await healthCheckDaemonService({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      expect(health.healthy).toBe(true);
      expect(health.running).toBe(true);

      // Stop service
      await stopDaemonService({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      // Restart service
      await restartDaemonService({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      // Uninstall service
      const uninstalled = await uninstallDaemonService({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      expect(uninstalled.success).toBe(true);
    });

    it("ensures zero root execution: all file paths remain strictly within user home directory", async () => {
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        toolEvolverHome,
        runner: mockRunner,
      });

      const unitPath = manager.getUnitPath();
      expect(unitPath.startsWith(fakeHome)).toBe(true);
      expect(unitPath.startsWith("/etc")).toBe(false);
      expect(unitPath.startsWith("/Library")).toBe(false);

      for (const cmd of mockRunner.commands) {
        expect(cmd.cmd).not.toBe("sudo");
      }
    });
  });
});
