#!/usr/bin/env node

import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadDaemonConfig } from "../config.js";
import { IpcClient } from "../ipc/client.js";
import { IpcServer } from "../ipc/server.js";
import { DaemonLock } from "../lock.js";
import { type DaemonPaths, ensureDaemonDirectories, resolvePaths } from "../paths.js";
import { DaemonSupervisor, DefaultLogger } from "../supervisor.js";

function resolveVersion(): string {
  const candidates = [
    new URL("../../../../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fileURLToPath(candidate), "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Continue to the next enclosing package candidate.
    }
  }
  return "0.1.0";
}

const VERSION = process.env.TOOL_EVOLVER_RELEASE_VERSION ?? resolveVersion();

function printHelp(): void {
  console.log(`
Tool Evolver Daemon v${VERSION}

Usage:
  tool-evolver-daemon [options]
  tool-evolver-daemon <command> [options]

Commands:
  --status              Query the status and health of the running daemon
  --stop                Gracefully shut down the running daemon
  --reload              Reload configuration for the running daemon
  --diagnostics         Print full diagnostics report from the running daemon

Options:
  -f, --foreground      Run in foreground development mode (default is background daemon)
  -c, --config <path>   Path to custom configuration file
  --home <path>         Custom TOOL_EVOLVER_HOME directory
  --port <port>         Port override for local services
  --socket <path>       Unix domain socket path override
  -v, --version         Print version and exit
  -h, --help            Print this help message and exit
`);
}

async function handleIpcCommand(
  command: "status" | "stop" | "reload" | "diagnostics",
  paths: DaemonPaths,
): Promise<number> {
  const client = new IpcClient({
    socketPath: paths.socketPath,
    tokenFilePath: paths.tokenFilePath,
    timeoutMs: 5000,
  });

  try {
    await client.connect();

    switch (command) {
      case "status": {
        const health = await client.getHealth();
        console.log(JSON.stringify(health, null, 2));
        break;
      }
      case "stop": {
        const result = await client.gracefulShutdown({ reason: "CLI --stop command" });
        console.log(`Shutdown response: ${result.message}`);
        break;
      }
      case "reload": {
        const result = await client.reloadConfig();
        console.log(`Config reload: ${result.success ? "SUCCESS" : "FAILED"}`);
        if (result.errors.length > 0) {
          console.error("Errors:", result.errors);
        }
        break;
      }
      case "diagnostics": {
        const diag = await client.getDiagnostics();
        console.log(JSON.stringify(diag, null, 2));
        break;
      }
    }

    await client.close();
    return 0;
  } catch (err) {
    console.error(`Failed to connect or execute command on daemon: ${(err as Error).message}`);
    return 1;
  }
}

async function runForeground(options: {
  configPath?: string;
  home?: string;
  port?: number;
  socketPath?: string;
}): Promise<void> {
  const paths = resolvePaths({
    home: options.home,
    socketPath: options.socketPath,
    configFile: options.configPath,
  });

  await ensureDaemonDirectories(paths);

  const config = loadDaemonConfig({
    configPath: paths.configFile,
    overrides: {
      port: options.port,
      socketPath: paths.socketPath,
    },
  });

  const logger = new DefaultLogger(config.logLevel);
  const lock = new DaemonLock({
    lockPath: paths.lockFilePath,
    socketPath: paths.socketPath,
    version: config.version,
    staleThresholdMs: config.lockStaleThresholdMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });

  const lockResult = await lock.acquire();
  if (lockResult.status === "already_running") {
    console.error(`Error: Tool Evolver daemon is already running (PID: ${lockResult.pid})`);
    process.exit(1);
  }

  if (lockResult.status === "stale_recovered") {
    logger.warn(
      `Recovered stale lock from inactive daemon (previous PID: ${lockResult.previousLockData?.pid})`,
    );
  }

  try {
    await fs.promises.writeFile(paths.pidFilePath, String(process.pid), { mode: 0o644 });
  } catch {
    // Ignore error writing PID file.
  }

  const supervisor = new DaemonSupervisor({
    config,
    paths,
    logger,
    enableSignalHandlers: false,
  });

  const ipcServer = new IpcServer({
    supervisor,
    socketPath: paths.socketPath,
    tokenFilePath: paths.tokenFilePath,
    authToken: config.authToken,
    logger,
  });

  logger.info(`Starting Tool Evolver daemon in foreground (PID: ${process.pid})`);

  await supervisor.start();
  await ipcServer.start();

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (reason: string): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      logger.info("Cleaning up daemon resources...");
      try {
        await supervisor.stop({ reason });
      } catch {
        // Ignore shutdown errors while releasing process resources.
      }
      try {
        await ipcServer.stop();
      } catch {
        // Ignore.
      }
      try {
        await lock.release();
      } catch {
        // Ignore.
      }
      try {
        if (fs.existsSync(paths.pidFilePath)) {
          await fs.promises.unlink(paths.pidFilePath);
        }
      } catch {
        // Ignore.
      }
    })();
    return cleanupPromise;
  };

  let exitRequested = false;
  const exitAfterCleanup = (reason: string) => {
    if (exitRequested) return;
    exitRequested = true;
    void cleanup(reason).finally(() => process.exit(0));
  };

  process.once("SIGINT", () => exitAfterCleanup("SIGINT"));
  process.once("SIGTERM", () => exitAfterCleanup("SIGTERM"));

  const shutdownWatcher = setInterval(() => {
    if (supervisor.currentState === "stopped") {
      clearInterval(shutdownWatcher);
      exitAfterCleanup("authenticated IPC graceful shutdown");
    }
  }, 100);
  shutdownWatcher.unref();
}

async function runBackground(
  argv: string[],
  options: {
    configPath?: string;
    home?: string;
    port?: number;
    socketPath?: string;
  },
): Promise<void> {
  const paths = resolvePaths({
    home: options.home,
    socketPath: options.socketPath,
    configFile: options.configPath,
  });

  const lock = new DaemonLock({
    lockPath: paths.lockFilePath,
  });

  const inspect = await lock.inspect();
  if (inspect.exists && !inspect.isStale && inspect.isProcessAlive) {
    console.error(`Error: Tool Evolver daemon is already running (PID: ${inspect.pid})`);
    process.exit(1);
  }

  const currentFile = fileURLToPath(import.meta.url);
  const childArgs = [
    currentFile,
    "--foreground",
    ...argv.filter((a) => a !== "--daemon" && a !== "-d"),
  ];

  const child = child_process.spawn(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  child.unref();
  console.log(`Tool Evolver daemon started in background (PID: ${child.pid})`);
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let foreground = false;
  let configPath: string | undefined;
  let home: string | undefined;
  let port: number | undefined;
  let socketPath: string | undefined;
  let command: "status" | "stop" | "reload" | "diagnostics" | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "-v" || arg === "--version") {
      console.log(`tool-evolver-daemon v${VERSION}`);
      process.exit(0);
    } else if (arg === "-f" || arg === "--foreground") {
      foreground = true;
    } else if (arg === "--status") {
      command = "status";
    } else if (arg === "--stop") {
      command = "stop";
    } else if (arg === "--reload") {
      command = "reload";
    } else if (arg === "--diagnostics") {
      command = "diagnostics";
    } else if (arg === "-c" || arg === "--config") {
      configPath = argv[++i];
    } else if (arg === "--home") {
      home = argv[++i];
    } else if (arg === "--port") {
      port = Number.parseInt(argv[++i], 10);
    } else if (arg === "--socket") {
      socketPath = argv[++i];
    }
  }

  const paths = resolvePaths({ home, socketPath, configFile: configPath });

  if (command) {
    const exitCode = await handleIpcCommand(command, paths);
    process.exit(exitCode);
  }

  if (foreground) {
    await runForeground({ configPath, home, port, socketPath });
  } else {
    await runBackground(argv, { configPath, home, port, socketPath });
  }
}

main().catch((err) => {
  console.error("Fatal error in daemon CLI:", err);
  process.exit(1);
});
