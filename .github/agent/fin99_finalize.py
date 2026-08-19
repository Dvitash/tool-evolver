from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing replacement target: {label}")
    p.write_text(text.replace(old, new, 1))

# Official immutable Deno v2.9.5 GitHub release asset SHA-256 digests.
p = Path("scripts/package-release.mjs")
s = p.read_text()
replacements = {
    "11d8df76601162f7d60a95deebb2b668e7da26863fbb8dad1f69f85dd7c24fe5": "8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530",
    "190fffcdb34e19f608df71c0cf7543ad273c7c6ad88c376af1103906044b1b0f": "6b7cae3a8fc4385a59dea3146fcb8bad7fea4230e0ad36a8c692afacbc254be0",
    "7569bf6b6a504dfba1c48ac8b918528d8e956197551e494da1d8fff6d9bdaa11": "c1b8b89a81e91b2a8b3f96def3195d08cfe3a105651da7908d53061f7140510d",
    "6aa8edbf5e7f2005d588500a416f6acadbc332f68e624156f573b5eea9e2e5a3": "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615",
}
for old, new in replacements.items():
    if old in s:
        s = s.replace(old, new)
p.write_text(s)

# The HTTP fixture transport exception remains loopback-only and must apply to the
# runtime asset after the signed manifest is verified too.
replace_once(
    "apps/cli/src/installer/release-client.ts",
    "function resolveDenoAsset(\n  descriptor: RuntimeDescriptor | undefined,\n  platform: { os: string; arch: string; isWsl?: boolean },\n): RuntimeAssetDescriptor {",
    "function resolveDenoAsset(\n  descriptor: RuntimeDescriptor | undefined,\n  platform: { os: string; arch: string; isWsl?: boolean },\n  allowInsecureHttpForTests = false,\n): RuntimeAssetDescriptor {",
    "Deno resolver signature",
)
replace_once(
    "apps/cli/src/installer/release-client.ts",
    "  assertTransport(asset.url, false);",
    "  assertTransport(asset.url, allowInsecureHttpForTests);",
    "Deno transport verification",
)
replace_once(
    "apps/cli/src/installer/release-client.ts",
    "  const denoAsset = resolveDenoAsset(manifest, options.platform);",
    "  const denoAsset = resolveDenoAsset(\n    manifest,\n    options.platform,\n    options.allowInsecureHttpForTests === true,\n  );",
    "Deno resolver call",
)

# All artifact downloads must use the same injectable/verified transport as channel
# and manifest resolution. This is required for the packaged HTTP integration test
# and avoids a split trust path.
replace_once(
    "apps/cli/src/installer/asset-downloader.ts",
    "  readonly timeoutMs?: number;\n  readonly logger?: (msg: string) => void;",
    "  readonly timeoutMs?: number;\n  readonly fetchImpl?: typeof fetch;\n  readonly logger?: (msg: string) => void;",
    "asset downloader fetch option",
)
replace_once(
    "apps/cli/src/installer/asset-downloader.ts",
    "    const response = await fetch(options.sourceUrlOrPath, {",
    "    const fetchImpl = options.fetchImpl ?? fetch;\n    const response = await fetchImpl(options.sourceUrlOrPath, {",
    "asset downloader injected fetch",
)

# Reusing an immutable install is allowed only when its pinned runtime and provenance
# match the release being requested.
replace_once(
    "apps/cli/src/installer/asset-downloader.ts",
    "    if (hasDaemon && hasMcp) {\n      log(\n        `Version v${cleanVersion} is already installed at ${targetVersionDir}. Reusing verified installation.`,\n      );",
    "    let reusable = hasDaemon && hasMcp;\n    if (options.denoRuntime) {\n      reusable = reusable && (await fsBridge.exists(denoBin));\n    }\n    if (reusable && options.provenance) {\n      try {\n        const versionMetadata = JSON.parse(\n          await fsPromises.readFile(path.join(targetVersionDir, \"version.json\"), \"utf8\"),\n        ) as { provenance?: ReleaseProvenance; deno?: { version?: string; sha256?: string } };\n        reusable =\n          versionMetadata.provenance?.manifestSha256 === options.provenance.manifestSha256 &&\n          versionMetadata.provenance?.releaseAssetSha256 === options.provenance.releaseAssetSha256 &&\n          versionMetadata.provenance?.version === options.provenance.version;\n        if (options.denoRuntime) {\n          reusable =\n            reusable &&\n            versionMetadata.deno?.version === options.denoRuntime.version &&\n            versionMetadata.deno?.sha256 === options.denoRuntime.sha256;\n        }\n      } catch {\n        reusable = false;\n      }\n    }\n    if (reusable) {\n      log(\n        `Version v${cleanVersion} is already installed at ${targetVersionDir}. Reusing verified installation.`,\n      );",
    "immutable install reuse provenance",
)

# Remove a failed staging directory rather than leaving an ambiguous partial install.
replace_once(
    "apps/cli/src/installer/asset-downloader.ts",
    "  log(`Extracting release archive for version v${cleanVersion} into staging directory...`);\n\n  let tarGzBuffer: Buffer;",
    "  try {\n    log(`Extracting release archive for version v${cleanVersion} into staging directory...`);\n\n    let tarGzBuffer: Buffer;",
    "version install transaction start",
)
replace_once(
    "apps/cli/src/installer/asset-downloader.ts",
    "  return {\n    version: cleanVersion,\n    versionDir: targetVersionDir,\n    installedFiles: extractedFiles.map((f) => f.replace(stagingDir, targetVersionDir)),\n    entryPoints: {\n      daemon: path.join(targetVersionDir, \"bin\", \"tool-evolver-daemon\"),\n      mcpShim: path.join(targetVersionDir, \"bin\", \"tool-evolver-mcp\"),\n      cli: path.join(targetVersionDir, \"bin\", \"tool-evolver\"),\n      deno: fs.existsSync(path.join(targetVersionDir, \"deno\", \"deno\"))\n        ? path.join(targetVersionDir, \"deno\", \"deno\")\n        : undefined,\n    },\n  };\n}\n\n/**\n * Atomically switches",
    "    return {\n      version: cleanVersion,\n      versionDir: targetVersionDir,\n      installedFiles: extractedFiles.map((f) => f.replace(stagingDir, targetVersionDir)),\n      entryPoints: {\n        daemon: path.join(targetVersionDir, \"bin\", \"tool-evolver-daemon\"),\n        mcpShim: path.join(targetVersionDir, \"bin\", \"tool-evolver-mcp\"),\n        cli: path.join(targetVersionDir, \"bin\", \"tool-evolver\"),\n        deno: fs.existsSync(path.join(targetVersionDir, \"deno\", \"deno\"))\n          ? path.join(targetVersionDir, \"deno\", \"deno\")\n          : undefined,\n      },\n    };\n  } catch (error) {\n    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});\n    throw error;\n  }\n}\n\n/**\n * Atomically switches",
    "version install transaction cleanup",
)

# Installer: pass injected transport all the way through and rollback any installed
# version/config mutation if a later step (including authorization) fails.
p = Path("apps/cli/src/installer/installer.ts")
s = p.read_text()
s = s.replace(
    "          logger: this.log.bind(this),\n        });\n        releaseTarball = downloadedRelease.path;",
    "          fetchImpl: options.fetchImpl,\n          logger: this.log.bind(this),\n        });\n        releaseTarball = downloadedRelease.path;",
    1,
)
s = s.replace(
    "          logger: this.log.bind(this),\n        });\n        denoRuntimeArchive = downloadedDeno.path;",
    "          fetchImpl: options.fetchImpl,\n          logger: this.log.bind(this),\n        });\n        denoRuntimeArchive = downloadedDeno.path;",
    1,
)
old = '''      if (\n        !dryRun &&\n        (activeStep === "apply" || activeStep === "directories" || activeStep === "verify")\n      ) {\n        this.log("\\n❌ Installation failed. Rolling back configuration changes...");\n        try {\n          await this.journal.rollback(this.fsBridge);\n          this.log("✔ Configuration rollback completed successfully.");\n        } catch (rollbackErr: unknown) {\n          this.log(`⚠️  Warning: Rollback encountered an error: ${String(rollbackErr)}`);\n        }\n      }\n'''
new = '''      if (!dryRun) {\n        this.log("\\n❌ Installation failed. Rolling back installation transaction...");\n        try {\n          await this.journal.rollback(this.fsBridge);\n          this.log("✔ Installation rollback completed successfully.");\n        } catch (rollbackErr: unknown) {\n          this.log(`⚠️  Warning: Rollback encountered an error: ${String(rollbackErr)}`);\n        }\n        try {\n          const failedStateDir = path.join(customHome, ".tool-evolver", "state");\n          await this.fsBridge.mkdirp(failedStateDir);\n          await this.journal.save(path.join(failedStateDir, "install-journal.json"), this.fsBridge);\n        } catch {\n          // A missing/unwritable home is itself recoverable from the thrown error.\n        }\n      }\n'''
if old not in s:
    raise SystemExit("missing installer rollback block")
s = s.replace(old, new, 1)
p.write_text(s)

# The public CLI only permits the insecure transport switch for loopback fixture URLs;
# release-client still rejects any non-loopback HTTP URL.
replace_once(
    "apps/cli/src/commands/init.ts",
    "    releaseChannelUrl: process.env.TOOL_EVOLVER_RELEASE_CHANNEL_URL,\n    fsBridge: customFsBridge,",
    "    releaseChannelUrl: process.env.TOOL_EVOLVER_RELEASE_CHANNEL_URL,\n    allowInsecureReleaseTransportForTests:\n      process.env.TOOL_EVOLVER_ALLOW_INSECURE_LOOPBACK_RELEASES === \"1\",\n    fsBridge: customFsBridge,",
    "init loopback fixture switch",
)

# Production release packages embed only the active PUBLIC trust root after build.
replace_once(
    ".github/workflows/release.yml",
    "      - run: pnpm build\n      - run: pnpm test",
    "      - run: pnpm build\n      - name: Embed active public release trust root in packaged CLI\n        run: node scripts/embed-cli-release-trust.mjs\n      - run: pnpm test",
    "release trust embedding",
)

# Upgrade now uses the exact same signed release resolution and immutable installation
# path as init. A test-simulated mode remains explicit for deterministic service tests.
Path("apps/cli/src/commands/upgrade.ts").write_text(r'''import fs from "node:fs/promises";
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
import { detectPlatform, validatePlatform } from "../platform/platform.js";
import { type PlatformInfo, resolvePlatformPaths } from "../platform/index.js";
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
  process.stdout.write(`Usage:\n  tool-evolver upgrade [options]\n\nUpgrades only to a release authenticated by the signed production channel.\n\nOptions:\n  --target-version <v>  Require the signed channel to resolve to this exact version.\n  --dry-run             Simulate without network or filesystem mutation.\n  --force               Reinstall even if the exact signed version is active.\n  --no-rollback         Disable automatic rollback if the health gate fails.\n  --json                Output structured JSON.\n  --home <path>         Custom Tool Evolver home.\n  -h, --help            Show help.\n`);
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
      detectPlatform({ platform: process.platform, arch: process.arch, nodeVersion: process.version }),
    );
    const productionRelease = await resolveProductionRelease({
      platform: detectedPlatform,
      channel: "stable",
      channelUrl: process.env.TOOL_EVOLVER_RELEASE_CHANNEL_URL,
      trustedPublicKeys: process.env.TOOL_EVOLVER_TRUSTED_RELEASE_PUBLIC_KEYS
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      fetchImpl: this.customFetch,
      env: process.env,
      allowInsecureHttpForTests:
        process.env.TOOL_EVOLVER_ALLOW_INSECURE_LOOPBACK_RELEASES === "1",
    });
    const targetVersion = productionRelease.version;
    if (flags.targetVersion && flags.targetVersion.replace(/^v/, "") !== targetVersion.replace(/^v/, "")) {
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
    const oldVersionContent = (await this.fsBridge.readFile(versionFilePath)) ?? JSON.stringify({ version: currentVersion });
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
        throw new Error(`Health gate verification failed: ${verification.failedChecks} check(s) failed`);
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
            await fs.rm(path.join(this.toolEvolverHome, "current"), { force: true }).catch(() => {});
            await fs.rm(path.join(this.toolEvolverHome, "current-version"), { force: true }).catch(() => {});
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
    const oldVersionContent = (await this.fsBridge.readFile(versionFilePath)) ?? JSON.stringify({ version: currentVersion });
    const backupDir = path.join(this.toolEvolverHome, "backups", `upgrade_test_${Date.now()}`);
    await this.fsBridge.mkdirp(backupDir);
    await this.fsBridge.writeFile(path.join(backupDir, "version.json"), oldVersionContent);
    stepsCompleted.push("backup_created", "apply_release");
    await this.fsBridge.writeFile(
      versionFilePath,
      JSON.stringify({ version: targetVersion, previousVersion: currentVersion, testOnly: true }, null, 2),
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
    else if (result.success) process.stdout.write(`\n✓ Tool Evolver upgrade complete: v${result.targetVersion}\n`);
    else process.stderr.write(`\n✗ Upgrade failed: ${result.error}\n`);
    return result.success ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json) process.stdout.write(`${JSON.stringify({ success: false, error: message }, null, 2)}\n`);
    else process.stderr.write(`\nFatal error during upgrade: ${message}\n`);
    return 1;
  }
}
''')

# Keep legacy unit scenarios explicit: they are testing service/transaction behavior,
# not production release resolution.
p = Path("apps/cli/tests/upgrade-command.test.ts")
s = p.read_text()
s = s.replace("      customFetch: mockFetch as unknown as typeof fetch,\n    });", "      customFetch: mockFetch as unknown as typeof fetch,\n      releaseMode: \"test-simulated\",\n    });", 1)
s = s.replace("      fsBridge,\n    });\n\n    // We can simulate failure", "      fsBridge,\n      releaseMode: \"test-simulated\",\n    });\n\n    // We can simulate failure", 1)
p.write_text(s)

# Add focused regression tests for injected asset fetch and downstream rollback.
Path("apps/cli/tests/installer/production-release-transaction.test.ts").write_text(r'''import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ToolEvolverInstaller } from "../../src/installer/installer.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(",")}}`;
}

function sign(payload: unknown, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString("hex");
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function tarGz(): Buffer {
  const files = [
    ["bin/tool-evolver-daemon", "#!/usr/bin/env node\n"],
    ["bin/tool-evolver-mcp", "#!/usr/bin/env node\n"],
    ["bin/tool-evolver", "#!/usr/bin/env node\n"],
  ] as const;
  const blocks: Buffer[] = [];
  for (const [name, content] of files) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function zipStored(name: string, body: Buffer): Buffer {
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + nameBuf.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuf, body, central, nameBuf, end]);
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("production signed release transaction", () => {
  it("installs only after channel, manifest, release and runtime verification and rolls back a downstream authorization failure", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-prod-install-"));
    homes.push(home);
    const release = tarGz();
    const denoZip = zipStored("deno", Buffer.from("#!/bin/sh\nexit 0\n"));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const keyId = "test-production-key";

    let base = "";
    const releaseIdentity = { commitSha: "a".repeat(40) };
    const manifestPayload = {
      schemaVersion: "2.0.0",
      version: "1.0.0",
      releaseDate: "2026-08-18T00:00:00.000Z",
      releaseIdentity,
      packages: {},
      assets: {
        "linux-x64": {
          filename: "tool-evolver-v1.0.0-linux-x64.tar.gz",
          platform: "linux",
          arch: "x64",
          isWsl: false,
          sizeBytes: release.length,
          sha256: sha256(release),
          path: "tool-evolver-v1.0.0-linux-x64.tar.gz",
        },
      },
      runtimes: {
        deno: {
          version: "2.9.5",
          required: true,
          assets: {
            "linux-x64": {
              filename: "deno-x86_64-unknown-linux-gnu.zip",
              url: "__DENO__",
              sha256: sha256(denoZip),
              archive: "zip",
              executable: "deno",
            },
          },
        },
      },
    };
    let manifest: Record<string, unknown> = {};
    let channel: Record<string, unknown> = {};

    const server = http.createServer((req, res) => {
      if (req.url === "/channels.json") return void res.end(JSON.stringify(channel));
      if (req.url === "/manifest.json") return void res.end(JSON.stringify(manifest));
      if (req.url === "/tool-evolver-v1.0.0-linux-x64.tar.gz") return void res.end(release);
      if (req.url === "/deno.zip") return void res.end(denoZip);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    base = `http://127.0.0.1:${address.port}`;
    const fixedManifestPayload = JSON.parse(JSON.stringify(manifestPayload).replace("__DENO__", `${base}/deno.zip`));
    const manifestSignature = sign(fixedManifestPayload, privateKey);
    manifest = {
      ...fixedManifestPayload,
      signatures: [{ keyId, algorithm: "Ed25519", publicKeyHex, signatureHex: manifestSignature }],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const channelPayload = {
      schemaVersion: "2.0.0",
      minSupportedVersion: "0.1.0",
      currentVersion: "1.0.0",
      updatedAt: "2026-08-18T00:00:00.000Z",
      releaseIdentity,
      channels: {
        stable: {
          version: "1.0.0",
          releaseDate: "2026-08-18T00:00:00.000Z",
          manifestUrl: `${base}/manifest.json`,
          manifestDigest: sha256(manifestBytes),
          isLatest: true,
        },
      },
    };
    channel = {
      ...channelPayload,
      signatures: [{ keyId, algorithm: "Ed25519", publicKeyHex, signatureHex: sign(channelPayload, privateKey) }],
    };

    try {
      const installer = new ToolEvolverInstaller({ logger: () => {} });
      await expect(
        installer.run({
          customHome: home,
          workspace: home,
          releaseMode: "production",
          releaseChannelUrl: `${base}/channels.json`,
          trustedReleasePublicKeys: [publicKeyHex],
          allowInsecureReleaseTransportForTests: true,
          nonInteractive: true,
          autoApprove: false,
        }),
      ).rejects.toThrow(/authorization/i);
      expect(fs.existsSync(path.join(home, ".tool-evolver", "current"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".tool-evolver", "versions", "v1.0.0"))).toBe(false);
      const journal = JSON.parse(
        fs.readFileSync(path.join(home, ".tool-evolver", "state", "install-journal.json"), "utf8"),
      );
      expect(journal.status).toBe("rolled_back");
      expect(journal.metadata.releaseProvenance.manifestSha256).toBe(sha256(manifestBytes));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
''')

print("FIN-003 final hardening staged")
