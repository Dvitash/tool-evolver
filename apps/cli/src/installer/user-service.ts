import type { ConfigFsBridge } from "@tool-evolver/harness-contracts";
import {
  type LaunchdUserServiceManager,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  type ServiceInstallOptions,
  type ServiceInstallResult,
  type ServiceStatusInfo,
  type ServiceUninstallResult,
  type SystemdUserServiceManager,
  type UserServiceManager,
  type UserServiceManagerOptions,
  type WslUserServiceManager,
  createUserServiceManager,
  defaultServiceCommandRunner,
} from "../service/manager.js";

export { createUserServiceManager, defaultServiceCommandRunner };
export type {
  UserServiceManager,
  UserServiceManagerOptions,
  SystemdUserServiceManager,
  LaunchdUserServiceManager,
  WslUserServiceManager,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceInstallOptions,
  ServiceInstallResult,
  ServiceStatusInfo,
  ServiceUninstallResult,
};

export type ServiceType = "systemd" | "launchd" | "wsl" | string;

export interface SetupDaemonServiceOptions {
  readonly homeDir?: string;
  readonly toolEvolverHome?: string;
  readonly daemonPath?: string;
  readonly nodePath?: string;
  readonly env?: Record<string, string>;
  readonly fsBridge?: ConfigFsBridge;
  readonly runner?: ServiceCommandRunner;
  readonly autoStart?: boolean;
  readonly maxHealthRetries?: number;
  readonly healthRetryIntervalMs?: number;
  readonly logger?: (msg: string) => void;
}

export interface SetupDaemonServiceResult {
  readonly success: boolean;
  readonly serviceType: string;
  readonly installed: boolean;
  readonly started: boolean;
  readonly healthy: boolean;
  readonly pid?: number;
  readonly details?: string;
  readonly error?: string;
}

export interface HealthCheckDaemonOptions {
  readonly homeDir?: string;
  readonly toolEvolverHome?: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly runner?: ServiceCommandRunner;
  readonly maxRetries?: number;
  readonly retryIntervalMs?: number;
}

export interface HealthCheckDaemonResult {
  readonly healthy: boolean;
  readonly running: boolean;
  readonly serviceType: string;
  readonly pid?: number;
  readonly details: string;
}

/**
 * Sets up and starts the Tool Evolver daemon as a user-level service without root.
 */
export async function setupAndStartDaemonService(
  options: SetupDaemonServiceOptions = {},
): Promise<SetupDaemonServiceResult> {
  const log = options.logger ?? (() => {});
  const manager = createUserServiceManager({
    homeDir: options.homeDir,
    toolEvolverHome: options.toolEvolverHome,
    daemonPath: options.daemonPath,
    nodePath: options.nodePath,
    env: options.env,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });

  const serviceType = manager.name;
  log(`Setting up user-level daemon service using '${serviceType}' supervisor (non-root)...`);

  try {
    // 1. Install user service definition
    const installResult = await manager.install({
      daemonPath: options.daemonPath,
      nodePath: options.nodePath,
      env: options.env,
    });

    if (!installResult.success) {
      return {
        success: false,
        serviceType,
        installed: false,
        started: false,
        healthy: false,
        error: installResult.error || "Failed to install daemon service definition.",
      };
    }

    log(`Service definition installed successfully (${installResult.unitPath || "supervisor"}).`);

    // 2. Start daemon if requested
    let started = installResult.started;

    if (!started && (options.autoStart ?? true)) {
      log("Starting daemon service...");
      await manager.start();
      started = true;
    }

    // 3. Health check verification with retries
    const maxRetries = options.maxHealthRetries ?? 5;
    const retryInterval = options.healthRetryIntervalMs ?? 100;
    let healthy = false;
    let pid: number | undefined;
    let healthDetails = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const status = await manager.status();
      if (status.active) {
        healthy = true;
        pid = status.pid;
        healthDetails = `Daemon active and running (PID: ${pid || "unknown"}, state: ${status.state || "active"})`;
        break;
      }
      if (attempt < maxRetries) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, retryInterval);
        });
      }
    }

    if (!healthy) {
      log("Warning: Daemon started but health check pending or daemon running in degraded state.");
    } else {
      log(`Daemon health check passed: ${healthDetails}`);
    }

    return {
      success: true,
      serviceType,
      installed: true,
      started,
      healthy,
      pid,
      details: healthDetails,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      serviceType,
      installed: false,
      started: false,
      healthy: false,
      error: errorMsg,
    };
  }
}

/**
 * Health checks the running daemon service.
 */
export async function healthCheckDaemonService(
  options: HealthCheckDaemonOptions = {},
): Promise<HealthCheckDaemonResult> {
  const manager = createUserServiceManager({
    homeDir: options.homeDir,
    toolEvolverHome: options.toolEvolverHome,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });

  const status = await manager.status();

  return {
    healthy: status.active,
    running: status.active,
    serviceType: manager.name,
    pid: status.pid,
    details: status.active
      ? `Daemon running (PID: ${status.pid || "unknown"}, state: ${status.state || "active"})`
      : `Daemon inactive (state: ${status.state || "inactive"})`,
  };
}

/**
 * Stops the daemon service.
 */
export async function stopDaemonService(options: SetupDaemonServiceOptions = {}): Promise<void> {
  const manager = createUserServiceManager({
    homeDir: options.homeDir,
    toolEvolverHome: options.toolEvolverHome,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });
  await manager.stop();
}

/**
 * Restarts the daemon service.
 */
export async function restartDaemonService(options: SetupDaemonServiceOptions = {}): Promise<void> {
  const manager = createUserServiceManager({
    homeDir: options.homeDir,
    toolEvolverHome: options.toolEvolverHome,
    daemonPath: options.daemonPath,
    nodePath: options.nodePath,
    env: options.env,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });
  await manager.restart();
}

/**
 * Uninstalls the daemon service.
 */
export async function uninstallDaemonService(
  options: SetupDaemonServiceOptions = {},
): Promise<ServiceUninstallResult> {
  const manager = createUserServiceManager({
    homeDir: options.homeDir,
    toolEvolverHome: options.toolEvolverHome,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });
  return await manager.uninstall();
}
