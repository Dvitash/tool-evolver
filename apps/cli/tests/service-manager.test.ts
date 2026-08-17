import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LaunchdUserServiceManager,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  SystemdUserServiceManager,
  UserServiceManager,
  WslUserServiceManager,
  createUserServiceManager,
} from "../src/service/manager.js";

// In-memory FsBridge mock for isolated testing
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

function createMockRunner(
  handler: (cmd: string, args: string[]) => ServiceCommandResult = () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }),
): ServiceCommandRunner & { executed: Array<{ cmd: string; args: string[] }> } {
  const executed: Array<{ cmd: string; args: string[] }> = [];
  return {
    executed,
    async run(cmd: string, args: string[]): Promise<ServiceCommandResult> {
      executed.push({ cmd, args });
      return handler(cmd, args);
    },
  };
}

describe("SystemdUserServiceManager", () => {
  const homeDir = "/home/testuser";
  const toolEvolverHome = "/home/testuser/.tool-evolver";

  it("generates correct systemd service definition for native binary", () => {
    const manager = new SystemdUserServiceManager({ homeDir, toolEvolverHome });
    const def = manager.getUnitDefinition({
      daemonPath: "/home/testuser/.tool-evolver/bin/tool-evolver-daemon",
    });

    expect(def).toContain("[Unit]");
    expect(def).toContain("Description=Tool Evolver Daemon");
    expect(def).toContain("ExecStart=/home/testuser/.tool-evolver/bin/tool-evolver-daemon run");
    expect(def).toContain("Environment=TOOL_EVOLVER_HOME=/home/testuser/.tool-evolver");
    expect(def).toContain("Environment=NODE_ENV=production");
    expect(def).toContain("Restart=on-failure");
    expect(def).toContain("WantedBy=default.target");
  });

  it("generates correct systemd service definition for Node.js JS script", () => {
    const manager = new SystemdUserServiceManager({
      homeDir,
      toolEvolverHome,
      nodePath: "/usr/bin/node",
    });
    const def = manager.getUnitDefinition({
      daemonPath: "/home/testuser/.tool-evolver/dist/daemon.js",
    });

    expect(def).toContain(
      "ExecStart=/usr/bin/node /home/testuser/.tool-evolver/dist/daemon.js run",
    );
  });

  it("installs systemd service, reloads daemon, enables and starts service", async () => {
    const fsBridge = createMockFsBridge();
    const runner = createMockRunner((cmd, args) => {
      if (cmd === "systemctl") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new SystemdUserServiceManager({
      homeDir,
      toolEvolverHome,
      fsBridge,
      runner,
    });

    const result = await manager.install({ autoStart: true });
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.started).toBe(true);
    expect(result.unitPath).toBe(
      path.join(homeDir, ".config", "systemd", "user", "tool-evolver.service"),
    );

    // Verify unit file written to fsBridge
    expect(await fsBridge.exists(result.unitPath)).toBe(true);
    const content = await fsBridge.readFile(result.unitPath);
    expect(content).toContain("Description=Tool Evolver Daemon");

    // Verify systemctl commands called
    expect(runner.executed).toEqual([
      { cmd: "systemctl", args: ["--user", "daemon-reload"] },
      { cmd: "systemctl", args: ["--user", "enable", "tool-evolver.service"] },
      { cmd: "systemctl", args: ["--user", "start", "tool-evolver.service"] },
    ]);
  });

  it("uninstalls systemd service cleanly", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "tool-evolver.service");
    const fsBridge = createMockFsBridge({ [unitPath]: "unit content" });
    const runner = createMockRunner();

    const manager = new SystemdUserServiceManager({
      homeDir,
      toolEvolverHome,
      fsBridge,
      runner,
    });

    const result = await manager.uninstall();
    expect(result.success).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.disabled).toBe(true);
    expect(result.removed).toBe(true);
    expect(await fsBridge.exists(unitPath)).toBe(false);

    expect(runner.executed).toEqual([
      { cmd: "systemctl", args: ["--user", "stop", "tool-evolver.service"] },
      { cmd: "systemctl", args: ["--user", "disable", "tool-evolver.service"] },
      { cmd: "systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });

  it("inspects status of systemd service including PID", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "tool-evolver.service");
    const fsBridge = createMockFsBridge({ [unitPath]: "unit content" });
    const runner = createMockRunner((_cmd, args) => {
      if (args[1] === "is-active") return { stdout: "active\n", stderr: "", exitCode: 0 };
      if (args[1] === "is-enabled") return { stdout: "enabled\n", stderr: "", exitCode: 0 };
      if (args[1] === "status") {
        return {
          stdout:
            "● tool-evolver.service - Tool Evolver Daemon\n   Main PID: 12345 (node)\n   Active: active (running)\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new SystemdUserServiceManager({
      homeDir,
      toolEvolverHome,
      fsBridge,
      runner,
    });

    const status = await manager.status();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.pid).toBe(12345);
  });
});

describe("LaunchdUserServiceManager", () => {
  const homeDir = "/Users/testuser";
  const toolEvolverHome = "/Users/testuser/.tool-evolver";

  it("generates correct launchd plist definition with XML escaping", () => {
    const manager = new LaunchdUserServiceManager({ homeDir, toolEvolverHome });
    const def = manager.getUnitDefinition({
      daemonPath: "/Users/testuser/.tool-evolver/bin/tool-evolver-daemon",
      env: { CUSTOM_VAR: "foo & bar <baz>" },
    });

    expect(def).toContain("<key>Label</key>");
    expect(def).toContain("<string>com.tool-evolver.daemon</string>");
    expect(def).toContain("<string>/Users/testuser/.tool-evolver/bin/tool-evolver-daemon</string>");
    expect(def).toContain("<string>run</string>");
    expect(def).toContain("<key>RunAtLoad</key>");
    expect(def).toContain("<true/>");
    expect(def).toContain("<string>foo &amp; bar &lt;baz&gt;</string>");
  });

  it("installs launchd plist and loads agent", async () => {
    const fsBridge = createMockFsBridge();
    const runner = createMockRunner();

    const manager = new LaunchdUserServiceManager({
      homeDir,
      toolEvolverHome,
      fsBridge,
      runner,
    });

    const result = await manager.install({ autoStart: true });
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.started).toBe(true);

    const plistPath = path.join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.tool-evolver.daemon.plist",
    );
    expect(result.unitPath).toBe(plistPath);
    expect(await fsBridge.exists(plistPath)).toBe(true);

    expect(runner.executed).toEqual([
      { cmd: "launchctl", args: ["unload", "-w", plistPath] },
      { cmd: "launchctl", args: ["load", "-w", plistPath] },
    ]);
  });

  it("uninstalls launchd agent cleanly", async () => {
    const plistPath = path.join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.tool-evolver.daemon.plist",
    );
    const fsBridge = createMockFsBridge({ [plistPath]: "<plist></plist>" });
    const runner = createMockRunner();

    const manager = new LaunchdUserServiceManager({
      homeDir,
      toolEvolverHome,
      fsBridge,
      runner,
    });

    const result = await manager.uninstall();
    expect(result.success).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.removed).toBe(true);
    expect(await fsBridge.exists(plistPath)).toBe(false);

    expect(runner.executed).toEqual([{ cmd: "launchctl", args: ["unload", "-w", plistPath] }]);
  });

  it("inspects launchd status and parses PID", async () => {
    const plistPath = path.join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.tool-evolver.daemon.plist",
    );
    const fsBridge = createMockFsBridge({ [plistPath]: "<plist></plist>" });
    const runner = createMockRunner((_cmd, args) => {
      if (args[0] === "list") {
        return {
          stdout:
            '{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "com.tool-evolver.daemon";\n\t"PID" = 54321;\n};\n',
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new LaunchdUserServiceManager({
      homeDir,
      toolEvolverHome,
      fsBridge,
      runner,
    });

    const status = await manager.status();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(true);
    expect(status.pid).toBe(54321);
  });
});

describe("WslUserServiceManager", () => {
  const homeDir = "/home/wsluser";
  const toolEvolverHome = "/home/wsluser/.tool-evolver";

  it("delegates to systemd when systemd is available in WSL", async () => {
    const fsBridge = createMockFsBridge();
    const runner = createMockRunner((_cmd, args) => {
      if (args[1] === "is-system-running") {
        return { stdout: "running\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new WslUserServiceManager({
      homeDir,
      toolEvolverHome,
      fsBridge,
      runner,
    });

    const hasSystemd = await manager.checkSystemdAvailable();
    expect(hasSystemd).toBe(true);

    const installRes = await manager.install();
    expect(installRes.success).toBe(true);
    // Should have written systemd unit file
    const systemdPath = path.join(homeDir, ".config", "systemd", "user", "tool-evolver.service");
    expect(await fsBridge.exists(systemdPath)).toBe(true);
  });

  it("uses script fallback when systemd is unavailable in WSL", async () => {
    const fsBridge = createMockFsBridge();
    const runner = createMockRunner((_cmd, args) => {
      if (args[1] === "is-system-running") {
        return {
          stdout: "",
          stderr: "System has not been booted with systemd as init system",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new WslUserServiceManager({
      homeDir,
      toolEvolverHome,
      fsBridge,
      runner,
    });

    const hasSystemd = await manager.checkSystemdAvailable();
    expect(hasSystemd).toBe(false);

    const installRes = await manager.install({ autoStart: true });
    expect(installRes.success).toBe(true);

    const scriptPath = path.join(toolEvolverHome, "bin", "tool-evolver-service.sh");
    expect(await fsBridge.exists(scriptPath)).toBe(true);
    const content = await fsBridge.readFile(scriptPath);
    expect(content).toContain("TOOL_EVOLVER_HOME");
    expect(content).toContain("daemon.pid");
  });
});

describe("createUserServiceManager factory", () => {
  it("creates systemd manager when platform explicitly specified", () => {
    const mgr = createUserServiceManager({ platform: "systemd" });
    expect(mgr.name).toBe("systemd");
  });

  it("creates launchd manager when platform explicitly specified", () => {
    const mgr = createUserServiceManager({ platform: "launchd" });
    expect(mgr.name).toBe("launchd");
  });

  it("creates wsl manager when platform explicitly specified", () => {
    const mgr = createUserServiceManager({ platform: "wsl" });
    expect(mgr.name).toBe("wsl");
  });
});
