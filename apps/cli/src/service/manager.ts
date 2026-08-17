import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { ConfigFsBridge } from "@tool-evolver/harness-contracts";
import { defaultFsBridge } from "@tool-evolver/harness-contracts";
import { detectPlatform } from "../installer/platform.js";

const execFileAsync = promisify(execFile);

export interface ServiceCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ServiceCommandRunner {
  run(cmd: string, args: string[]): Promise<ServiceCommandResult>;
}

export const defaultServiceCommandRunner: ServiceCommandRunner = {
  async run(cmd: string, args: string[]): Promise<ServiceCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        encoding: "utf8",
        timeout: 10000,
      });
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: (error.stdout ?? "").trim(),
        stderr: (error.stderr ?? error.message ?? String(err)).trim(),
        exitCode: typeof error.code === "number" ? error.code : 1,
      };
    }
  },
};

export interface ServiceInstallOptions {
  daemonPath?: string;
  homeDir?: string;
  toolEvolverHome?: string;
  nodePath?: string;
  env?: Record<string, string>;
  autoStart?: boolean;
  force?: boolean;
}

export interface ServiceInstallResult {
  success: boolean;
  unitPath: string;
  unitContent: string;
  serviceName: string;
  enabled: boolean;
  started: boolean;
  error?: string;
}

export interface ServiceUninstallResult {
  success: boolean;
  unitPath: string;
  stopped: boolean;
  disabled: boolean;
  removed: boolean;
  error?: string;
}

export interface ServiceStatusInfo {
  installed: boolean;
  active: boolean;
  enabled: boolean;
  serviceName: string;
  unitPath: string;
  pid?: number;
  state?: string;
  rawStatus?: string;
}

export interface UserServiceManagerOptions {
  platform?: "linux" | "darwin" | "wsl" | "systemd" | "launchd";
  homeDir?: string;
  toolEvolverHome?: string;
  daemonPath?: string;
  nodePath?: string;
  fsBridge?: ConfigFsBridge;
  runner?: ServiceCommandRunner;
  env?: Record<string, string>;
}

export interface UserServiceManager {
  readonly name: string;
  readonly platform: "systemd" | "launchd" | "wsl";
  install(options?: ServiceInstallOptions): Promise<ServiceInstallResult>;
  uninstall(): Promise<ServiceUninstallResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatusInfo>;
  isInstalled(): Promise<boolean>;
  getUnitDefinition(options?: ServiceInstallOptions): string;
  getUnitPath(): string;
}

// -----------------------------------------------------------------------------
// Systemd User Service Manager (Linux & WSL with Systemd)
// -----------------------------------------------------------------------------

export class SystemdUserServiceManager implements UserServiceManager {
  readonly name = "systemd";
  readonly platform = "systemd" as const;
  readonly serviceName = "tool-evolver.service";

  protected readonly homeDir: string;
  protected readonly toolEvolverHome: string;
  protected readonly defaultDaemonPath: string;
  protected readonly nodePath: string;
  protected readonly fsBridge: ConfigFsBridge;
  protected readonly runner: ServiceCommandRunner;
  protected readonly defaultEnv: Record<string, string>;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.toolEvolverHome = options.toolEvolverHome ?? path.join(this.homeDir, ".tool-evolver");
    this.defaultDaemonPath =
      options.daemonPath ??
      path.join(this.toolEvolverHome, "bin", "tool-evolver-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};
  }

  getUnitPath(): string {
    return path.join(this.homeDir, ".config", "systemd", "user", this.serviceName);
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const toolEvolverHome = options.toolEvolverHome ?? this.toolEvolverHome;
    const envVars = { ...this.defaultEnv, ...(options.env ?? {}) };

    let execStart: string;
    if (daemonPath.endsWith(".js")) {
      const nodePath = options.nodePath ?? this.nodePath;
      execStart = `${nodePath} ${daemonPath} run`;
    } else {
      execStart = `${daemonPath} run`;
    }

    const envLines = [
      `Environment=TOOL_EVOLVER_HOME=${toolEvolverHome}`,
      "Environment=NODE_ENV=production",
      ...Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`),
    ];

    return `[Unit]
Description=Tool Evolver Daemon
Documentation=https://github.com/tool-evolver/tool-evolver
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5s
${envLines.join("\n")}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
  }

  async isInstalled(): Promise<boolean> {
    return this.fsBridge.exists(this.getUnitPath());
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
    const unitPath = this.getUnitPath();
    const unitContent = this.getUnitDefinition(options);
    const autoStart = options.autoStart ?? true;

    try {
      await this.fsBridge.mkdirp(path.dirname(unitPath));
      await this.fsBridge.writeFile(unitPath, unitContent);

      // Reload systemd daemon
      await this.runner.run("systemctl", ["--user", "daemon-reload"]);

      // Enable service
      const enableResult = await this.runner.run("systemctl", [
        "--user",
        "enable",
        this.serviceName,
      ]);
      const enabled = enableResult.exitCode === 0;

      let started = false;
      if (autoStart) {
        const startResult = await this.runner.run("systemctl", [
          "--user",
          "start",
          this.serviceName,
        ]);
        started = startResult.exitCode === 0;
      }

      return {
        success: true,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled,
        started,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled: false,
        started: false,
        error: msg,
      };
    }
  }

  async uninstall(): Promise<ServiceUninstallResult> {
    const unitPath = this.getUnitPath();
    let stopped = false;
    let disabled = false;
    let removed = false;

    try {
      // Stop service
      const stopResult = await this.runner.run("systemctl", ["--user", "stop", this.serviceName]);
      stopped = stopResult.exitCode === 0;

      // Disable service
      const disableResult = await this.runner.run("systemctl", [
        "--user",
        "disable",
        this.serviceName,
      ]);
      disabled = disableResult.exitCode === 0;

      // Remove unit file
      if (await this.fsBridge.exists(unitPath)) {
        await this.fsBridge.unlink(unitPath);
        removed = true;
      }

      // Reload daemon
      await this.runner.run("systemctl", ["--user", "daemon-reload"]);

      return {
        success: true,
        unitPath,
        stopped,
        disabled,
        removed,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath,
        stopped,
        disabled,
        removed,
        error: msg,
      };
    }
  }

  async start(): Promise<void> {
    const res = await this.runner.run("systemctl", ["--user", "start", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to start systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const res = await this.runner.run("systemctl", ["--user", "stop", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to stop systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async restart(): Promise<void> {
    const res = await this.runner.run("systemctl", ["--user", "restart", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to restart systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async status(): Promise<ServiceStatusInfo> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        active: false,
        enabled: false,
        serviceName: this.serviceName,
        unitPath: this.getUnitPath(),
        state: "not_installed",
      };
    }

    const [activeRes, enabledRes, statusRes] = await Promise.all([
      this.runner.run("systemctl", ["--user", "is-active", this.serviceName]),
      this.runner.run("systemctl", ["--user", "is-enabled", this.serviceName]),
      this.runner.run("systemctl", ["--user", "status", this.serviceName]),
    ]);

    const active = activeRes.exitCode === 0 && activeRes.stdout.trim() === "active";
    const enabled = enabledRes.exitCode === 0 && enabledRes.stdout.trim() === "enabled";

    let pid: number | undefined;
    const pidMatch = statusRes.stdout.match(/Main PID:\s*(\d+)/i);
    if (pidMatch && pidMatch[1]) {
      pid = Number.parseInt(pidMatch[1], 10);
    }

    return {
      installed: true,
      active,
      enabled,
      serviceName: this.serviceName,
      unitPath: this.getUnitPath(),
      pid,
      state: active ? "active" : "inactive",
      rawStatus: statusRes.stdout || statusRes.stderr,
    };
  }
}

// -----------------------------------------------------------------------------
// Launchd User Service Manager (macOS LaunchAgents)
// -----------------------------------------------------------------------------

export class LaunchdUserServiceManager implements UserServiceManager {
  readonly name = "launchd";
  readonly platform = "launchd" as const;
  readonly serviceName = "com.tool-evolver.daemon";

  protected readonly homeDir: string;
  protected readonly toolEvolverHome: string;
  protected readonly defaultDaemonPath: string;
  protected readonly nodePath: string;
  protected readonly fsBridge: ConfigFsBridge;
  protected readonly runner: ServiceCommandRunner;
  protected readonly defaultEnv: Record<string, string>;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.toolEvolverHome = options.toolEvolverHome ?? path.join(this.homeDir, ".tool-evolver");
    this.defaultDaemonPath =
      options.daemonPath ??
      path.join(this.toolEvolverHome, "bin", "tool-evolver-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};
  }

  getUnitPath(): string {
    return path.join(
      this.homeDir,
      "Library",
      "LaunchAgents",
      `${this.serviceName}.plist`,
    );
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const toolEvolverHome = options.toolEvolverHome ?? this.toolEvolverHome;
    const logDir = path.join(toolEvolverHome, "logs");
    const envVars = { ...this.defaultEnv, ...(options.env ?? {}) };

    let programArgs: string[];
    if (daemonPath.endsWith(".js")) {
      const nodePath = options.nodePath ?? this.nodePath;
      programArgs = [nodePath, daemonPath, "run"];
    } else {
      programArgs = [daemonPath, "run"];
    }

    const argsXml = programArgs
      .map((arg) => `        <string>${this.escapeXml(arg)}</string>`)
      .join("\n");

    const envXml = [
      `        <key>TOOL_EVOLVER_HOME</key>\n        <string>${this.escapeXml(toolEvolverHome)}</string>`,
      `        <key>NODE_ENV</key>\n        <string>production</string>`,
      ...Object.entries(envVars).map(
        ([k, v]) =>
          `        <key>${this.escapeXml(k)}</key>\n        <string>${this.escapeXml(v)}</string>`,
      ),
    ].join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${this.serviceName}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${this.escapeXml(path.join(logDir, "daemon.stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${this.escapeXml(path.join(logDir, "daemon.stderr.log"))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
</dict>
</plist>
`;
  }

  private escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  async isInstalled(): Promise<boolean> {
    return this.fsBridge.exists(this.getUnitPath());
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
    const unitPath = this.getUnitPath();
    const unitContent = this.getUnitDefinition(options);
    const autoStart = options.autoStart ?? true;

    try {
      await this.fsBridge.mkdirp(path.dirname(unitPath));
      await this.fsBridge.writeFile(unitPath, unitContent);

      let started = false;
      if (autoStart) {
        // Unload first in case it's currently loaded
        await this.runner.run("launchctl", ["unload", "-w", unitPath]);
        const loadResult = await this.runner.run("launchctl", ["load", "-w", unitPath]);
        started = loadResult.exitCode === 0;
      }

      return {
        success: true,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled: true,
        started,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled: false,
        started: false,
        error: msg,
      };
    }
  }

  async uninstall(): Promise<ServiceUninstallResult> {
    const unitPath = this.getUnitPath();
    let stopped = false;
    let removed = false;

    try {
      const unloadRes = await this.runner.run("launchctl", ["unload", "-w", unitPath]);
      stopped = unloadRes.exitCode === 0;

      if (await this.fsBridge.exists(unitPath)) {
        await this.fsBridge.unlink(unitPath);
        removed = true;
      }

      return {
        success: true,
        unitPath,
        stopped,
        disabled: true,
        removed,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath,
        stopped,
        disabled: false,
        removed,
        error: msg,
      };
    }
  }

  async start(): Promise<void> {
    const unitPath = this.getUnitPath();
    const res = await this.runner.run("launchctl", ["load", "-w", unitPath]);
    if (res.exitCode !== 0) {
      // Try launchctl start if already loaded
      const startRes = await this.runner.run("launchctl", ["start", this.serviceName]);
      if (startRes.exitCode !== 0) {
        throw new Error(`Failed to start launchd service ${this.serviceName}: ${res.stderr}`);
      }
    }
  }

  async stop(): Promise<void> {
    const unitPath = this.getUnitPath();
    const res = await this.runner.run("launchctl", ["unload", "-w", unitPath]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to stop launchd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async restart(): Promise<void> {
    await this.stop().catch(() => {});
    await this.start();
  }

  async status(): Promise<ServiceStatusInfo> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        active: false,
        enabled: false,
        serviceName: this.serviceName,
        unitPath: this.getUnitPath(),
        state: "not_installed",
      };
    }

    const listRes = await this.runner.run("launchctl", ["list", this.serviceName]);
    const active = listRes.exitCode === 0;

    let pid: number | undefined;
    if (active) {
      const pidMatch = listRes.stdout.match(/"PID"\s*=\s*(\d+)/i) ?? listRes.stdout.match(/^(\d+)\s+/m);
      if (pidMatch && pidMatch[1]) {
        pid = Number.parseInt(pidMatch[1], 10);
      }
    }

    return {
      installed: true,
      active,
      enabled: true,
      serviceName: this.serviceName,
      unitPath: this.getUnitPath(),
      pid,
      state: active ? "active" : "inactive",
      rawStatus: listRes.stdout || listRes.stderr,
    };
  }
}

// -----------------------------------------------------------------------------
// WSL User Service Manager (systemd when available, script fallback otherwise)
// -----------------------------------------------------------------------------

export class WslUserServiceManager implements UserServiceManager {
  readonly name = "wsl";
  readonly platform = "wsl" as const;
  readonly serviceName = "tool-evolver";

  private readonly systemdDelegate: SystemdUserServiceManager;
  private readonly homeDir: string;
  private readonly toolEvolverHome: string;
  private readonly defaultDaemonPath: string;
  private readonly nodePath: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly runner: ServiceCommandRunner;
  private readonly defaultEnv: Record<string, string>;
  private systemdAvailableCache?: boolean;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.toolEvolverHome = options.toolEvolverHome ?? path.join(this.homeDir, ".tool-evolver");
    this.defaultDaemonPath =
      options.daemonPath ??
      path.join(this.toolEvolverHome, "bin", "tool-evolver-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};

    this.systemdDelegate = new SystemdUserServiceManager(options);
  }

  async checkSystemdAvailable(): Promise<boolean> {
    if (this.systemdAvailableCache !== undefined) {
      return this.systemdAvailableCache;
    }

    try {
      const res = await this.runner.run("systemctl", ["--user", "is-system-running"]);
      // Return true if systemctl is usable (returns running, degraded, initializing, etc. with exit code 0 or 1 without command not found)
      this.systemdAvailableCache = res.exitCode === 0 || res.stdout.length > 0;
      return this.systemdAvailableCache;
    } catch {
      this.systemdAvailableCache = false;
      return false;
    }
  }

  getUnitPath(): string {
    return path.join(this.toolEvolverHome, "services", "wsl-service.json");
  }

  getFallbackScriptPath(): string {
    return path.join(this.toolEvolverHome, "bin", "tool-evolver-service.sh");
  }

  getPidPath(): string {
    return path.join(this.toolEvolverHome, "run", "daemon.pid");
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const toolEvolverHome = options.toolEvolverHome ?? this.toolEvolverHome;
    const nodePath = options.nodePath ?? this.nodePath;

    let execCmd: string;
    if (daemonPath.endsWith(".js")) {
      execCmd = `"${nodePath}" "${daemonPath}" run`;
    } else {
      execCmd = `"${daemonPath}" run`;
    }

    return `#!/bin/sh
# Tool Evolver Daemon WSL Service Fallback
export TOOL_EVOLVER_HOME="${toolEvolverHome}"
export NODE_ENV="production"
mkdir -p "${toolEvolverHome}/logs" "${toolEvolverHome}/run"
nohup ${execCmd} >> "${toolEvolverHome}/logs/daemon.stdout.log" 2>> "${toolEvolverHome}/logs/daemon.stderr.log" &
echo $! > "${toolEvolverHome}/run/daemon.pid"
`;
  }

  async isInstalled(): Promise<boolean> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.isInstalled();
    }
    return (
      (await this.fsBridge.exists(this.getFallbackScriptPath())) ||
      (await this.fsBridge.exists(this.getUnitPath()))
    );
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.install(options);
    }

    const scriptPath = this.getFallbackScriptPath();
    const scriptContent = this.getUnitDefinition(options);
    const unitPath = this.getUnitPath();

    try {
      await this.fsBridge.mkdirp(path.dirname(scriptPath));
      await this.fsBridge.mkdirp(path.dirname(unitPath));

      await this.fsBridge.writeFile(scriptPath, scriptContent);
      await this.fsBridge.writeFile(
        unitPath,
        JSON.stringify(
          {
            type: "wsl_fallback",
            installedAt: new Date().toISOString(),
            scriptPath,
            toolEvolverHome: this.toolEvolverHome,
          },
          null,
          2,
        ),
      );

      let started = false;
      if (options.autoStart ?? true) {
        await this.start();
        started = true;
      }

      return {
        success: true,
        unitPath: scriptPath,
        unitContent: scriptContent,
        serviceName: this.serviceName,
        enabled: true,
        started,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath: scriptPath,
        unitContent: scriptContent,
        serviceName: this.serviceName,
        enabled: false,
        started: false,
        error: msg,
      };
    }
  }

  async uninstall(): Promise<ServiceUninstallResult> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.uninstall();
    }

    let stopped = false;
    let removed = false;

    try {
      await this.stop().catch(() => {});
      stopped = true;

      const scriptPath = this.getFallbackScriptPath();
      const unitPath = this.getUnitPath();

      if (await this.fsBridge.exists(scriptPath)) {
        await this.fsBridge.unlink(scriptPath);
        removed = true;
      }
      if (await this.fsBridge.exists(unitPath)) {
        await this.fsBridge.unlink(unitPath);
      }

      return {
        success: true,
        unitPath: scriptPath,
        stopped,
        disabled: true,
        removed,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath: this.getFallbackScriptPath(),
        stopped,
        disabled: false,
        removed,
        error: msg,
      };
    }
  }

  async start(): Promise<void> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.start();
    }

    const scriptPath = this.getFallbackScriptPath();
    const res = await this.runner.run("sh", [scriptPath]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to start WSL fallback daemon service: ${res.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.stop();
    }

    const pidPath = this.getPidPath();
    const content = await this.fsBridge.readFile(pidPath);
    if (!content) {
      return;
    }

    const pid = Number.parseInt(content.trim(), 10);
    if (!Number.isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process might already be dead
      }
    }
    await this.fsBridge.unlink(pidPath).catch(() => {});
  }

  async restart(): Promise<void> {
    await this.stop().catch(() => {});
    await this.start();
  }

  async status(): Promise<ServiceStatusInfo> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.status();
    }

    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        active: false,
        enabled: false,
        serviceName: this.serviceName,
        unitPath: this.getFallbackScriptPath(),
        state: "not_installed",
      };
    }

    const pidPath = this.getPidPath();
    const content = await this.fsBridge.readFile(pidPath);
    let active = false;
    let pid: number | undefined;

    if (content) {
      pid = Number.parseInt(content.trim(), 10);
      if (!Number.isNaN(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          active = true;
        } catch {
          active = false;
        }
      }
    }

    return {
      installed: true,
      active,
      enabled: true,
      serviceName: this.serviceName,
      unitPath: this.getFallbackScriptPath(),
      pid,
      state: active ? "active" : "inactive",
      rawStatus: active ? `Process running with PID ${pid}` : "Process not running",
    };
  }
}

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

export function createUserServiceManager(
  options: UserServiceManagerOptions = {},
): UserServiceManager {
  if (options.platform) {
    if (options.platform === "wsl") {
      return new WslUserServiceManager(options);
    }
    if (options.platform === "darwin" || options.platform === "launchd") {
      return new LaunchdUserServiceManager(options);
    }
    return new SystemdUserServiceManager(options);
  }

  const detected = detectPlatform({
    platform: process.platform,
    env: process.env,
  });

  if (detected.isWsl) {
    return new WslUserServiceManager(options);
  }
  if (detected.os === "darwin") {
    return new LaunchdUserServiceManager(options);
  }
  return new SystemdUserServiceManager(options);
}
