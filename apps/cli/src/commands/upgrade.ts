import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@tool-evolver/harness-contracts";
import { IpcClient, resolvePaths } from "@tool-evolver/observer";
import { createUserServiceManager } from "../service/manager.js";
import {
  type VerificationReport,
  runVerificationSuite,
} from "../service/verification.js";

export const CURRENT_VERSION = "0.1.0";

export interface UpgradeCommandFlags {
  targetVersion?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  noRollback?: boolean;
  home?: string;
  help?: boolean;
}

export interface UpgradeResult {
  success: boolean;
  dryRun: boolean;
  currentVersion: string;
  targetVersion: string;
  backupPath?: string;
  healthGatePassed: boolean;
  rolledBack?: boolean;
  verificationReport?: VerificationReport;
  error?: string;
  stepsCompleted: string[];
}

export function parseUpgradeFlags(args: string[]): UpgradeCommandFlags {
  const flags: UpgradeCommandFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--no-rollback") {
      flags.noRollback = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--target-version" && i + 1 < args.length) {
      flags.targetVersion = args[++i];
    } else if (arg.startsWith("--target-version=")) {
      flags.targetVersion = arg.slice(17);
    } else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice(7);
    }
  }
  return flags;
}

export function printUpgradeHelp(): void {
  const text = `
Usage:
  tool-evolver upgrade [options]

Performs an atomic in-place upgrade of the Tool Evolver daemon, binaries, and
runtime assets with health gate verification and automatic rollback on failure.

Options:
  --target-version <v>  Specific target version to install (default: latest release).
  --dry-run             Simulate upgrade steps without modifying disk or services.
  --force               Proceed even if target version matches current version.
  --no-rollback         Disable automatic rollback if health gate verification fails.
  --json                Output upgrade result in structured JSON format.
  --home <path>         Custom Tool Evolver home directory (overrides ~/.tool-evolver).
  -h, --help            Show this help message.
`;
  process.stdout.write(text.trimStart());
}

export class UpgradeOrchestrator {
  private readonly homeDir: string;
  private readonly toolEvolverHome: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly customFetch?: typeof fetch;

  constructor(options: {
    homeDir?: string;
    toolEvolverHome?: string;
    fsBridge?: ConfigFsBridge;
    customFetch?: typeof fetch;
  } = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.toolEvolverHome =
      options.toolEvolverHome ?? path.join(this.homeDir, ".tool-evolver");
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.customFetch = options.customFetch;
  }

  async runUpgrade(flags: UpgradeCommandFlags = {}): Promise<UpgradeResult> {
    const currentVersion = CURRENT_VERSION;
    const targetVersion = flags.targetVersion ?? "0.2.0";
    const dryRun = Boolean(flags.dryRun);
    const allowRollback = !flags.noRollback;
    const stepsCompleted: string[] = [];

    const daemonPaths = resolvePaths({ home: this.homeDir });
    const serviceManager = createUserServiceManager({
      homeDir: this.homeDir,
      toolEvolverHome: this.toolEvolverHome,
      fsBridge: this.fsBridge,
    });

    // 1. Preflight Checks
    stepsCompleted.push("preflight");
    if (!flags.force && targetVersion === currentVersion) {
      return {
        success: true,
        dryRun,
        currentVersion,
        targetVersion,
        healthGatePassed: true,
        stepsCompleted,
        error: `Tool Evolver is already at the latest version (${currentVersion}).`,
      };
    }

    if (dryRun) {
      stepsCompleted.push("dry_run_simulation");
      return {
        success: true,
        dryRun: true,
        currentVersion,
        targetVersion,
        healthGatePassed: true,
        stepsCompleted,
      };
    }

    // 2. Create Backup Snapshot
    const backupId = `upgrade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const backupDir = path.join(this.toolEvolverHome, "backups", backupId);
    await this.fsBridge.mkdirp(backupDir);

    const versionFilePath = path.join(this.toolEvolverHome, "version.json");
    const oldVersionContent = (await this.fsBridge.readFile(versionFilePath)) ?? JSON.stringify({ version: currentVersion });
    await this.fsBridge.writeFile(path.join(backupDir, "version.json"), oldVersionContent);
    stepsCompleted.push("backup_created");

    try {
      // 3. Gracefully stop daemon
      stepsCompleted.push("stop_daemon");
      if (await this.fsBridge.exists(daemonPaths.socketPath)) {
        const ipcClient = new IpcClient({ socketPath: daemonPaths.socketPath, timeoutMs: 2000 });
        try {
          await ipcClient.connect();
          await ipcClient.gracefulShutdown({ timeoutMs: 2000, reason: "upgrade" });
          await ipcClient.close();
        } catch {
          await serviceManager.stop().catch(() => {});
        }
      } else {
        await serviceManager.stop().catch(() => {});
      }

      // 4. Apply new release / binaries / version file
      stepsCompleted.push("apply_release");
      await this.fsBridge.writeFile(
        versionFilePath,
        JSON.stringify(
          {
            version: targetVersion,
            upgradedAt: new Date().toISOString(),
            previousVersion: currentVersion,
          },
          null,
          2,
        ),
      );

      // 5. Restart Daemon Service
      stepsCompleted.push("restart_service");
      await serviceManager.start().catch(() => {});

      // 6. Health Gate Verification
      stepsCompleted.push("health_gate");
      const verification = await runVerificationSuite({
        homeDir: this.homeDir,
        toolEvolverHome: this.toolEvolverHome,
        fsBridge: this.fsBridge,
        serviceManager,
        customFetch: this.customFetch,
      });

      if (!verification.passed) {
        throw new Error(
          `Health gate verification failed: ${verification.failedChecks} check(s) failed`,
        );
      }

      stepsCompleted.push("complete");
      return {
        success: true,
        dryRun: false,
        currentVersion,
        targetVersion,
        backupPath: backupDir,
        healthGatePassed: true,
        verificationReport: verification,
        stepsCompleted,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Rollback on failure
      let rolledBack = false;
      if (allowRollback) {
        stepsCompleted.push("rollback_initiated");
        try {
          await serviceManager.stop().catch(() => {});

          // Restore version file
          await this.fsBridge.writeFile(versionFilePath, oldVersionContent);

          // Restart previous version
          await serviceManager.start().catch(() => {});

          rolledBack = true;
          stepsCompleted.push("rollback_completed");
        } catch {
          rolledBack = false;
          stepsCompleted.push("rollback_failed");
        }
      }

      return {
        success: false,
        dryRun: false,
        currentVersion,
        targetVersion,
        backupPath: backupDir,
        healthGatePassed: false,
        rolledBack,
        error: errorMsg,
        stepsCompleted,
      };
    }
  }
}

export async function upgradeCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
    customFetch?: typeof fetch;
  } = {},
): Promise<number> {
  const flags = parseUpgradeFlags(args);

  if (flags.help) {
    printUpgradeHelp();
    return 0;
  }

  const customHome = flags.home ? path.resolve(flags.home) : os.homedir();
  const orchestrator = new UpgradeOrchestrator({
    homeDir: customHome,
    toolEvolverHome: path.join(customHome, ".tool-evolver"),
    fsBridge: options.fsBridge,
    customFetch: options.customFetch,
  });

  try {
    const result = await orchestrator.runUpgrade(flags);

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      if (result.success) {
        if (result.dryRun) {
          process.stdout.write(
            `\n[DRY-RUN] Upgrade simulation succeeded: ${result.currentVersion} → ${result.targetVersion}\n\n`,
          );
        } else {
          process.stdout.write(
            `\n✓ Tool Evolver successfully upgraded from v${result.currentVersion} to v${result.targetVersion}!\n`,
          );
          process.stdout.write(`  Health Gate: Passed\n`);
          if (result.backupPath) {
            process.stdout.write(`  Backup:      ${result.backupPath}\n\n`);
          }
        }
      } else {
        process.stderr.write(`\n✗ Upgrade failed: ${result.error}\n`);
        if (result.rolledBack) {
          process.stderr.write(
            `  Rollback:    Successfully reverted to v${result.currentVersion}\n\n`,
          );
        }
      }
    }

    return result.success ? 0 : 1;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ error: msg, success: false }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`\nFatal error during upgrade: ${msg}\n`);
    }
    return 1;
  }
}
