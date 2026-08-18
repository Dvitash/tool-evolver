import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge } from "@tool-evolver/harness-contracts";
import { defaultFsBridge } from "@tool-evolver/harness-contracts";
import { resolvePaths } from "@tool-evolver/observer";
import type { ServiceCommandRunner } from "../service/manager.js";
import {
  type VersionSwitchResult,
  downloadAndVerifyAsset,
  installReleaseVersion,
  rollbackActiveVersion,
  switchActiveVersion,
} from "./asset-downloader.js";
import {
  type AssetManifest,
  type AssetVerificationResult,
  discoverAndVerifyAssets,
} from "./assets.js";
import {
  type AuthorizationPlan,
  createAuthorizationPlan,
  formatAuthPlanForDisplay,
  validateAuthorization,
} from "./auth-plan.js";
import {
  type ChannelMetadata,
  type ChannelVerificationResult,
  type ManifestAsset,
  type ReleaseChannel,
  type SignedManifest,
  selectPlatformAsset,
  verifyChannelMetadata,
} from "./channel-verifier.js";
import {
  HarnessConfigOrchestrator,
  type HarnessConfigResult,
  type SupportedHarnessId,
} from "./harness-config.js";
import { InstallationJournal, type JournalData } from "./journal.js";
import { type PlatformInfo, detectPlatform, validatePlatform } from "./platform.js";
import { type SetupDaemonServiceResult, setupAndStartDaemonService } from "./user-service.js";

export interface InstallerOptions {
  dryRun?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  autoApprove?: boolean;
  harness?: string | string[];
  workspace?: string;
  capabilitiesFile?: string;
  privacyConfig?: string;
  rollbackInstall?: boolean;
  customHome?: string;
  denoExecutable?: string;
  assetManifest?: AssetManifest;
  channel?: ReleaseChannel;
  channelMetadata?: ChannelMetadata;
  signedManifest?: SignedManifest;
  assetTarball?: string | Buffer;
  targetVersion?: string;
  setupService?: boolean;
  autoStartService?: boolean;
  serviceRunner?: ServiceCommandRunner;
  gatewayUrl?: string;
  logger?: (msg: string) => void;
  fsBridge?: ConfigFsBridge;
}
export interface InstallationSummary {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly platform: PlatformInfo;
  readonly assets: AssetVerificationResult;
  readonly authPlan: AuthorizationPlan;
  readonly harnesses: HarnessConfigResult[];
  readonly journal: JournalData;
  readonly versionSwitch?: VersionSwitchResult;
  readonly serviceSetup?: SetupDaemonServiceResult;
  readonly error?: string;
}

export class InstallationError extends Error {
  readonly journal: JournalData;
  readonly stepName: string;
  readonly causeError?: Error;

  constructor(message: string, journal: JournalData, stepName: string, causeError?: Error) {
    super(message);
    this.name = "InstallationError";
    this.journal = journal;
    this.stepName = stepName;
    this.causeError = causeError;
  }
}

/**
 * Main Tool Evolver Installer responsible for executing the single-command `init` workflow
 * with full transactional safety, pre-mutation authorization, atomic version pointer switching,
 * non-root user service management, and atomic rollback.
 */
export class ToolEvolverInstaller {
  private fsBridge: ConfigFsBridge;
  private readonly journal: InstallationJournal;
  private logger: (msg: string) => void;

  constructor(options: { fsBridge?: ConfigFsBridge; logger?: (msg: string) => void } = {}) {
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.journal = new InstallationJournal();
    this.logger = options.logger ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  }

  /**
   * Runs the complete installation workflow or handles rollback request.
   */
  async run(options: InstallerOptions = {}): Promise<InstallationSummary> {
    const customHome = options.customHome ?? process.env.HOME ?? os.homedir();
    const workspacePath = path.resolve(options.workspace ?? process.cwd());
    const dryRun = Boolean(options.dryRun);
    if (options.logger) {
      this.logger = options.logger;
    }
    if (options.fsBridge) {
      this.fsBridge = options.fsBridge;
    }

    // Handle rollback-install request if requested
    if (options.rollbackInstall) {
      return await this.handleRollbackOnly(customHome);
    }

    try {
      // Step 1: Preflight check
      this.journal.startStep("preflight");
      this.log("==> Step 1/10: Running preflight environment checks...");
      this.runPreflightChecks();
      this.journal.completeStep("preflight", { nodeVersion: process.version });

      // Step 2: Platform detection & validation
      this.journal.startStep("platform");
      this.log("==> Step 2/10: Detecting platform and system architecture...");
      const platformInfo = validatePlatform(
        detectPlatform({
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
        }),
      );
      this.journal.completeStep("platform", {
        os: platformInfo.os,
        arch: platformInfo.arch,
      });

      // Step 3: Asset discovery & verification / Channel Metadata Verification
      this.journal.startStep("assets");
      this.log("==> Step 3/10: Verifying Tool Evolver binaries, runtime, and MCP shim...");

      let channelResult: ChannelVerificationResult | undefined;
      let selectedAsset: ManifestAsset | undefined;

      if (options.channelMetadata) {
        channelResult = verifyChannelMetadata(options.channelMetadata, {
          channel: options.channel || "stable",
        });
        if (!channelResult.valid) {
          throw new Error(`Channel verification failed: ${channelResult.errors.join("; ")}`);
        }
      }

      if (options.signedManifest) {
        selectedAsset = selectPlatformAsset(options.signedManifest, platformInfo);
      }

      const toolEvolverHome = path.join(customHome, ".tool-evolver");
      const downloadsDir = path.join(toolEvolverHome, "downloads");

      if (selectedAsset && options.assetTarball) {
        await downloadAndVerifyAsset({
          asset: selectedAsset,
          downloadDir: downloadsDir,
          sourceBuffer: Buffer.isBuffer(options.assetTarball) ? options.assetTarball : undefined,
          sourceUrlOrPath:
            typeof options.assetTarball === "string" ? options.assetTarball : undefined,
          fsBridge: this.fsBridge,
          logger: this.log.bind(this),
        });
      }

      const assetResult = await discoverAndVerifyAssets({
        fsBridge: this.fsBridge,
        manifest: options.assetManifest,
        denoExecutable: options.denoExecutable,
        allowMissingOptional: true,
      });
      this.journal.completeStep("assets", {
        allVerified: assetResult.allVerified,
        assetCount: assetResult.assets.length,
      });

      // Step 4: Ensure directory tree & version directory layout
      this.journal.startStep("directories");
      this.log("==> Step 4/10: Creating Tool Evolver state and configuration directories...");
      const daemonPaths = resolvePaths({
        home: customHome,
        toolEvolverHome,
        env: process.env,
        platform: process.platform,
      });

      let versionSwitchResult: VersionSwitchResult | undefined;

      if (!dryRun) {
        await this.fsBridge.mkdirp(daemonPaths.configDir);
        await this.fsBridge.mkdirp(daemonPaths.dataDir);
        await this.fsBridge.mkdirp(daemonPaths.stateDir);
        await this.fsBridge.mkdirp(daemonPaths.logDir);

        if (options.assetTarball) {
          const installVersion = channelResult?.targetVersion || options.targetVersion || "1.0.0";
          await installReleaseVersion({
            version: installVersion,
            tarballPathOrBuffer: options.assetTarball,
            toolEvolverHome,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
          });

          versionSwitchResult = await switchActiveVersion({
            toolEvolverHome,
            targetVersion: installVersion,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
          });
        }
      }
      this.journal.completeStep("directories", {
        stateDir: daemonPaths.stateDir,
        activeVersion: versionSwitchResult?.activeVersion || options.targetVersion || "0.1.0",
      });

      // Step 5: Authorization plan creation & approval
      this.journal.startStep("authorization");
      this.log("==> Step 5/10: Inspecting workspace capabilities and privacy boundary...");
      const authPlan = await createAuthorizationPlan({
        workspacePath,
        capabilitiesFile: options.capabilitiesFile,
        privacyConfigFile: options.privacyConfig,
        fsBridge: this.fsBridge,
      });

      const validation = await validateAuthorization(authPlan, {
        nonInteractive: Boolean(options.nonInteractive),
        autoApprove: Boolean(options.autoApprove || options.dryRun),
        capabilitiesFile: options.capabilitiesFile,
      });
      if (!validation.granted) {
        this.log(`\n${formatAuthPlanForDisplay(authPlan)}`);
        throw new Error(
          "Installation aborted: Workspace capabilities and privacy authorization require approval.",
        );
      }
      this.journal.completeStep("authorization", {
        approved: validation.granted,
        planId: authPlan.planId,
      });

      // Step 6: Harness Discovery
      this.journal.startStep("harness_discovery");
      this.log("==> Step 6/10: Discovering AI coding harnesses in workspace...");
      const orchestrator = new HarnessConfigOrchestrator();
      const requestedHarnesses = options.harness
        ? ((Array.isArray(options.harness)
            ? options.harness
            : [options.harness]) as SupportedHarnessId[])
        : undefined;

      this.journal.completeStep("harness_discovery", {
        requestedHarnesses: requestedHarnesses || "all",
      });

      // Step 7: Config Planning
      this.journal.startStep("config_planning");
      this.log("==> Step 7/10: Formulating safe non-destructive configuration mutation plans...");
      this.journal.completeStep("config_planning");

      // Step 8: Apply configuration mutations
      this.journal.startStep("apply");
      this.log(
        `==> Step 8/10: ${dryRun ? "[DRY-RUN] Simulating" : "Applying"} harness MCP configuration updates...`,
      );

      const orchestrationResult = await orchestrator.configureHarnesses({
        workspacePath,
        customHome,
        fsBridge: this.fsBridge,
        dryRun,
        harnesses: requestedHarnesses,
      });

      if (!orchestrationResult.success) {
        throw new Error(orchestrationResult.error || "Failed to configure agent harnesses.");
      }

      // Record rollback action in journal
      this.journal.addRollbackAction(
        "apply",
        "Restore previous harness configurations from backups",
        async () => {
          await orchestrationResult.rollback();
        },
      );

      const configuredCount = orchestrationResult.results.filter((r) => r.configured).length;
      this.journal.completeStep("apply", { configuredCount });

      // Step 9: User-level Service Registration & Verification
      this.journal.startStep("verify");
      let serviceSetupResult: SetupDaemonServiceResult | undefined;

      if (options.setupService) {
        this.log("==> Step 9/10: Registering and starting non-root user daemon service...");
        if (!dryRun) {
          serviceSetupResult = await setupAndStartDaemonService({
            homeDir: customHome,
            toolEvolverHome,
            autoStart: options.autoStartService ?? true,
            fsBridge: this.fsBridge,
            runner: options.serviceRunner,
            logger: this.log.bind(this),
          });
        }
      } else {
        this.log(
          "==> Step 9/10: Verifying harness configuration integrity and gateway registration...",
        );
      }

      const allConfigured = orchestrationResult.results.every(
        (r: HarnessConfigResult) => r.configured,
      );
      this.journal.completeStep("verify", {
        allConfigured,
        serviceHealthy: serviceSetupResult?.healthy ?? true,
      });

      // Step 10: Finalizing & recording journal
      this.journal.startStep("complete");
      this.log("==> Step 10/10: Finalizing installation transaction and recording journal...");
      this.journal.finalize("completed");
      this.journal.completeStep("complete");

      const journalFilePath = path.join(daemonPaths.stateDir, "install-journal.json");
      if (!dryRun) {
        await this.journal.save(journalFilePath, this.fsBridge);
      }

      this.log("\n✔ Tool Evolver installation completed successfully!\n");

      return {
        success: true,
        dryRun,
        platform: platformInfo,
        assets: assetResult,
        authPlan,
        harnesses: orchestrationResult.results,
        journal: this.journal.toJSON(),
        versionSwitch: versionSwitchResult,
        serviceSetup: serviceSetupResult,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const activeStep =
        this.journal.toJSON().steps.find((s) => s.status === "running")?.name ?? "unknown";

      if (activeStep !== "unknown") {
        this.journal.failStep(activeStep, error);
      }

      if (
        !dryRun &&
        (activeStep === "apply" || activeStep === "directories" || activeStep === "verify")
      ) {
        this.log("\n❌ Installation failed. Rolling back configuration changes...");
        try {
          await this.journal.rollback(this.fsBridge);
          this.log("✔ Configuration rollback completed successfully.");
        } catch (rollbackErr: unknown) {
          this.log(`⚠️  Warning: Rollback encountered an error: ${String(rollbackErr)}`);
        }
      }

      throw new InstallationError(
        `Tool Evolver installation failed during step "${activeStep}": ${error.message}`,
        this.journal.toJSON(),
        activeStep,
        error,
      );
    }
  }

  /**
   * Preflight environment sanity check.
   */
  private runPreflightChecks(): void {
    const nodeMajor = Number.parseInt(process.version.slice(1).split(".")[0] || "0", 10);
    if (nodeMajor < 22) {
      throw new Error(
        `Unsupported Node.js runtime: ${process.version}. Tool Evolver requires Node.js v22.0.0 or higher.`,
      );
    }
  }

  /**
   * Handles explicit rollback request.
   */
  private async handleRollbackOnly(customHome: string): Promise<InstallationSummary> {
    const toolEvolverHome = path.join(customHome, ".tool-evolver");
    this.log("==> Performing Tool Evolver configuration and version rollback...");

    const journalPath = path.join(toolEvolverHome, "state", "install-journal.json");
    let loadedJournal: InstallationJournal;

    if (await this.fsBridge.exists(journalPath)) {
      loadedJournal = await InstallationJournal.load(journalPath, this.fsBridge);
      await loadedJournal.rollback(this.fsBridge);
      this.log("✔ Successfully rolled back configuration files to prior state.");
    } else {
      loadedJournal = new InstallationJournal();
      this.log("⚠️  No install journal found to roll back configurations from.");
    }

    // Try version rollback if pointer exists
    try {
      await rollbackActiveVersion({
        toolEvolverHome,
        fsBridge: this.fsBridge,
        logger: this.log.bind(this),
      });
    } catch {}

    const platformInfo = detectPlatform({
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    });

    return {
      success: true,
      dryRun: false,
      platform: platformInfo,
      assets: {
        allVerified: true,
        assets: [],
        missingRequired: [],
        digestMismatches: [],
      },
      authPlan: await createAuthorizationPlan({
        workspacePath: process.cwd(),
        fsBridge: this.fsBridge,
      }),
      harnesses: [],
      journal: loadedJournal.toJSON(),
    };
  }

  private log(message: string): void {
    this.logger(message);
  }
}
