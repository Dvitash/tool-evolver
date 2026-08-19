import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@tool-evolver/harness-contracts";
import { IpcClient } from "@tool-evolver/observer";
import {
  downloadAndVerifyAsset,
  getActiveVersion,
  installReleaseVersion,
  switchActiveVersion,
} from "../installer/asset-downloader.js";
import { resolveProductionRelease } from "../installer/release-client.js";
import { type PlatformInfo, resolvePlatformPaths } from "../platform/index.js";
import { detectPlatform, validatePlatform } from "../platform/platform.js";
import { createUserServiceManager } from "../service/manager.js";
import { type VerificationReport, runVerificationSuite } from "../service/verification.js";

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
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--no-rollback") flags.noRollback = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--target-version" && i + 1 < args.length) flags.targetVersion = args[++i];
    else if (arg.startsWith("--target-version=")) flags.targetVersion = arg.slice(17);
    else if (arg === "--home" && i + 1 < args.length) flags.home = args[++i];
    else if (arg.startsWith("--home=")) flags.home = arg.slice(7);
  }
  return flags;
}

export function printUpgradeHelp(): void {
  process.stdout.write(
    `Usage:\n  tool-evolver upgrade [options]\n\nUpgrades only to a release authenticated by the signed production channel.\n\nOptions:\n  --target-version <v>  Require the signed channel to resolve to this exact version.\n  --dry-run             Simulate without network or filesystem mutation.\n  --force               Reinstall even if the exact signed version is active.\n  --no-rollback         Disable automatic rollback if the health gate fails.\n  --json                Output structured JSON.\n  --home <path>         Custom Tool Evolver home.\n  -h, --help            Show help.\n`,
  );
}

export class UpgradeOrchestrator {
  private readonly homeDir: string;
  private readonly toolEvolverHome: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly customFetch?: typeof fetch;
  private readonly platformInfo?: PlatformInfo;
  private readonly releaseMode: "production" | "test-simulated";

  constructor(
    options: {
      homeDir?: string;
      toolEvolverHome?: string;
      fsBridge?: ConfigFsBridge;
      customFetch?: typeof fetch;
      platformInfo?: PlatformInfo;
      releaseMode?: "production" | "test-simulated";
    } = {},
  ) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.toolEvolverHome = options.toolEvolverHome ?? path.join(this.homeDir, ".tool-evolver");
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.customFetch = options.customFetch;
    this.platformInfo = options.platformInfo;
    this.releaseMode = options.releaseMode ?? "production";
  }

  async runUpgrade(flags: UpgradeCommandFlags = {}): Promise<UpgradeResult> {
    const stepsCompleted: string[] = ["preflight"];
    const dryRun = Boolean(flags.dryRun);
    const currentVersion = getActiveVersion(this.toolEvolverHome) ?? CURRENT_VERSION;
    const requestedVersion = flags.targetVersion ?? (dryRun ? currentVersion : undefined);

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        currentVersion,
        targetVersion: requestedVersion ?? currentVersion,
        healthGatePassed: true,
        stepsCompleted: [...stepsCompleted, "dry_run_simulation"],
      };
    }

    if (this.releaseMode === "test-simulated") {
      return this.runSimulatedUpgrade(flags, currentVersion, stepsCompleted);
    }

    const detectedPlatform = validatePlatform(
      detectPlatform({
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      }),
    );
    const productionRelease = await resolveProductionRelease({
      platform: detectedPlatform,
      channel: "stable",
      channelUrl: process.env.TOOL_EVOLVER_RELEASE_CHANNEL_URL,
      trustedPublicKeys: process.env.TOOL_EVOLVER_TRUSTED_RELEASE_PUBLIC_KEYS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      fetchImpl: this.customFetch,
      env: process.env,
      allowInsecureHttpForTests: process.env.TOOL_EVOLVER_ALLOW_INSECURE_LOOPBACK_RELEASES === "1",
    });
    const targetVersion = productionRelease.version;
    if (
      flags.targetVersion &&
      flags.targetVersion.replace(/^v/, "") !== targetVersion.replace(/^v/, "")
    ) {
      throw new Error(
        `Requested version '${flags.targetVersion}' is not the version authenticated by the signed stable channel ('${targetVersion}').`,
      );
    }
    if (!flags.force && targetVersion === currentVersion) {
      return {
        success: true,
        dryRun: false,
        currentVersion,
        targetVersion,
        healthGatePassed: true,
        stepsCompleted,
        error: `Tool Evolver is already at the signed stable version (${currentVersion}).`,
      };
    }

    const daemonPaths = this.platformInfo
      ? resolvePlatformPaths({ home: this.homeDir, platformInfo: this.platformInfo })
      : resolvePlatformPaths({ home: this.homeDir });
    const serviceManager = createUserServiceManager({
      homeDir: this.homeDir,
      toolEvolverHome: this.toolEvolverHome,
      fsBridge: this.fsBridge,
      platform: this.platformInfo?.os,
    });
    const backupDir = path.join(this.toolEvolverHome, "backups", `upgrade_${Date.now()}`);
    await this.fsBridge.mkdirp(backupDir);
    const versionFilePath = path.join(this.toolEvolverHome, "version.json");
    const oldVersionContent =
      (await this.fsBridge.readFile(versionFilePath)) ??
      JSON.stringify({ version: currentVersion });
    await this.fsBridge.writeFile(path.join(backupDir, "version.json"), oldVersionContent);
    stepsCompleted.push("backup_created");

    const downloadsDir = path.join(this.toolEvolverHome, "downloads");
    let installedVersionDir: string | undefined;
    const previousActiveVersion = getActiveVersion(this.toolEvolverHome);
    try {
      const releaseDownload = await downloadAndVerifyAsset({
        asset: productionRelease.releaseAsset,
        downloadDir: downloadsDir,
        sourceUrlOrPath: productionRelease.releaseAssetUrl,
        fsBridge: this.fsBridge,
        fetchImpl: this.customFetch,
      });
      const denoDownload = await downloadAndVerifyAsset({
        asset: {
          filename: productionRelease.denoAsset.filename,
          platform: detectedPlatform.os,
          arch: detectedPlatform.arch,
          isWsl: detectedPlatform.isWsl,
          sizeBytes: 0,
          sha256: productionRelease.denoAsset.sha256,
          path: productionRelease.denoAsset.filename,
        },
        downloadDir: downloadsDir,
        sourceUrlOrPath: productionRelease.denoAsset.url,
        fsBridge: this.fsBridge,
        fetchImpl: this.customFetch,
      });
      stepsCompleted.push("artifacts_verified");

      await serviceManager.stop().catch(() => {});
      stepsCompleted.push("stop_daemon");
      const installed = await installReleaseVersion({
        version: targetVersion,
        tarballPathOrBuffer: releaseDownload.path,
        toolEvolverHome: this.toolEvolverHome,
        fsBridge: this.fsBridge,
        provenance: productionRelease.provenance,
        denoRuntime: {
          archivePathOrBuffer: denoDownload.path,
          version: productionRelease.provenance.deno.version,
          sha256: productionRelease.provenance.deno.sha256,
          executable: productionRelease.denoAsset.executable,
        },
        force: flags.force,
      });
      installedVersionDir = installed.versionDir;
      await switchActiveVersion({
        toolEvolverHome: this.toolEvolverHome,
        targetVersion,
        fsBridge: this.fsBridge,
      });
      await this.fsBridge.writeFile(
        versionFilePath,
        JSON.stringify(
          {
            version: targetVersion,
            previousVersion: currentVersion,
            upgradedAt: new Date().toISOString(),
            provenance: productionRelease.provenance,
          },
          null,
          2,
        ),
      );
      stepsCompleted.push("apply_release");
      await serviceManager.start().catch(() => {});
      stepsCompleted.push("restart_service");
      const verification = await runVerificationSuite({
        homeDir: this.homeDir,
        toolEvolverHome: this.toolEvolverHome,
        fsBridge: this.fsBridge,
        serviceManager,
        customFetch: this.customFetch,
      });
      stepsCompleted.push("health_gate");
      if (!verification.passed) {
        throw new Error(
          `Health gate verification failed: ${verification.failedChecks} check(s) failed`,
        );
      }
      return {
        success: true,
        dryRun: false,
        currentVersion,
        targetVersion,
        backupPath: backupDir,
        healthGatePassed: true,
        verificationReport: verification,
        stepsCompleted: [...stepsCompleted, "complete"],
      };
    } catch (error) {
      let rolledBack = false;
      if (!flags.noRollback) {
        stepsCompleted.push("rollback_initiated");
        try {
          await serviceManager.stop().catch(() => {});
          if (previousActiveVersion) {
            await switchActiveVersion({
              toolEvolverHome: this.toolEvolverHome,
              targetVersion: previousActiveVersion,
              fsBridge: this.fsBridge,
            });
          } else {
            await fs
              .rm(path.join(this.toolEvolverHome, "current"), { force: true })
              .catch(() => {});
            await fs
              .rm(path.join(this.toolEvolverHome, "current-version"), { force: true })
              .catch(() => {});
          }
          if (installedVersionDir && targetVersion !== previousActiveVersion) {
            await fs.rm(installedVersionDir, { recursive: true, force: true }).catch(() => {});
          }
          await this.fsBridge.writeFile(versionFilePath, oldVersionContent);
          await serviceManager.start().catch(() => {});
          rolledBack = true;
          stepsCompleted.push("rollback_completed");
        } catch {
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
        error: error instanceof Error ? error.message : String(error),
        stepsCompleted,
      };
    }
  }

  private async runSimulatedUpgrade(
    flags: UpgradeCommandFlags,
    currentVersion: string,
    stepsCompleted: string[],
  ): Promise<UpgradeResult> {
    const targetVersion = flags.targetVersion ?? "0.2.0";
    const versionFilePath = path.join(this.toolEvolverHome, "version.json");
    const oldVersionContent =
      (await this.fsBridge.readFile(versionFilePath)) ??
      JSON.stringify({ version: currentVersion });
    const backupDir = path.join(this.toolEvolverHome, "backups", `upgrade_test_${Date.now()}`);
    await this.fsBridge.mkdirp(backupDir);
    await this.fsBridge.writeFile(path.join(backupDir, "version.json"), oldVersionContent);
    stepsCompleted.push("backup_created", "apply_release");
    await this.fsBridge.writeFile(
      versionFilePath,
      JSON.stringify(
        { version: targetVersion, previousVersion: currentVersion, testOnly: true },
        null,
        2,
      ),
    );
    const hasHome = await this.fsBridge.exists(this.toolEvolverHome);
    if (!hasHome) {
      await this.fsBridge.writeFile(versionFilePath, oldVersionContent);
      return {
        success: false,
        dryRun: false,
        currentVersion,
        targetVersion,
        backupPath: backupDir,
        healthGatePassed: false,
        rolledBack: true,
        error: "Simulated health gate verification failed.",
        stepsCompleted: [...stepsCompleted, "rollback_completed"],
      };
    }
    return {
      success: true,
      dryRun: false,
      currentVersion,
      targetVersion,
      backupPath: backupDir,
      healthGatePassed: true,
      stepsCompleted: [...stepsCompleted, "complete"],
    };
  }
}

export async function upgradeCommand(
  args: string[],
  options: { fsBridge?: ConfigFsBridge; customFetch?: typeof fetch } = {},
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
    if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.success)
      process.stdout.write(`\n✓ Tool Evolver upgrade complete: v${result.targetVersion}\n`);
    else process.stderr.write(`\n✗ Upgrade failed: ${result.error}\n`);
    return result.success ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json)
      process.stdout.write(`${JSON.stringify({ success: false, error: message }, null, 2)}\n`);
    else process.stderr.write(`\nFatal error during upgrade: ${message}\n`);
    return 1;
  }
}
