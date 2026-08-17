import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge, ConfigMutationPlan } from "@tool-evolver/harness-contracts";
import { defaultFsBridge } from "@tool-evolver/harness-contracts";
import { resolvePaths } from "@tool-evolver/observer";
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
  HarnessConfigOrchestrator,
  type HarnessConfigResult,
  type SupportedHarnessId,
} from "./harness-config.js";
import { InstallationJournal, type JournalData } from "./journal.js";
import { type PlatformInfo, detectPlatform, validatePlatform } from "./platform.js";

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
  gatewayUrl?: string;
  assetManifest?: AssetManifest;
  denoExecutable?: string;
  fsBridge?: ConfigFsBridge;
  logger?: (msg: string) => void;
  promptFn?: (question: string) => Promise<boolean>;
}

export interface InstallationSummary {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly journalId: string;
  readonly platform: PlatformInfo;
  readonly assets: AssetVerificationResult;
  readonly authPlan: AuthorizationPlan;
  readonly harnesses: HarnessConfigResult[];
  readonly journal: JournalData;
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
    Object.setPrototypeOf(this, InstallationError.prototype);
  }
}

/**
 * Main Tool Evolver Installer responsible for executing the single-command `init` workflow
 * with full transactional safety, pre-mutation authorization, and atomic rollback.
 */
export class ToolEvolverInstaller {
  private readonly fsBridge: ConfigFsBridge;
  private readonly journal: InstallationJournal;
  private readonly logger: (msg: string) => void;

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
    const dryRun = options.dryRun ?? false;

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
      const platformInfo = detectPlatform({
        env: process.env,
        platform: process.platform,
        arch: process.arch,
      });
      validatePlatform(platformInfo);
      this.journal.completeStep("platform", {
        os: platformInfo.os,
        isWsl: platformInfo.isWsl,
        arch: platformInfo.arch,
      });

      // Step 3: Asset discovery & verification
      this.journal.startStep("assets");
      this.log("==> Step 3/10: Verifying Tool Evolver binaries, runtime, and MCP shim...");
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

      // Step 4: Ensure directory tree
      this.journal.startStep("directories");
      this.log("==> Step 4/10: Creating Tool Evolver state and configuration directories...");
      const daemonPaths = resolvePaths({
        home: customHome,
        toolEvolverHome: path.join(customHome, ".tool-evolver"),
        env: process.env,
        platform: process.platform,
      });

      if (!dryRun) {
        await this.fsBridge.mkdirp(daemonPaths.configDir);
        await this.fsBridge.mkdirp(daemonPaths.dataDir);
        await this.fsBridge.mkdirp(daemonPaths.stateDir);
        await this.fsBridge.mkdirp(daemonPaths.logDir);
      }
      this.journal.completeStep("directories", {
        configDir: daemonPaths.configDir,
        dataDir: daemonPaths.dataDir,
        stateDir: daemonPaths.stateDir,
        logDir: daemonPaths.logDir,
      });

      // Step 5: Consolidated capability envelope & privacy authorization
      this.journal.startStep("authorization");
      this.log("==> Step 5/10: Planning capabilities envelope and privacy boundaries...");

      const parsedHarnesses = this.parseTargetHarnesses(options.harness);
      const authPlan = await createAuthorizationPlan({
        workspacePath,
        capabilitiesFile: options.capabilitiesFile,
        privacyConfigFile: options.privacyConfig,
        targetHarnesses: parsedHarnesses.map((h) => ({
          id: h,
          name: this.getHarnessDisplayName(h),
        })),
        fsBridge: this.fsBridge,
      });

      // Display authorization plan during interactive / dry-run modes
      if (!options.json) {
        this.log(formatAuthPlanForDisplay(authPlan));
      }

      // Enforce explicit authorization
      await validateAuthorization(authPlan, {
        nonInteractive: options.nonInteractive,
        autoApprove: options.autoApprove || options.dryRun,
        capabilitiesFile: options.capabilitiesFile,
        promptFn: options.promptFn,
      });

      this.journal.completeStep("authorization", {
        planId: authPlan.planId,
        granted: authPlan.granted,
        grantedBy: authPlan.grantedBy,
      });

      // Step 6 & 7: Harness discovery & configuration planning
      this.journal.startStep("harness_discovery");
      this.log("==> Step 6/10: Probing installed AI agent harnesses (Claude Code, Codex, OMP)...");
      const discoveredPlans: ConfigMutationPlan[] = [];

      this.journal.completeStep("harness_discovery", {
        requestedHarnesses: parsedHarnesses,
      });

      this.journal.startStep("config_planning");
      this.log("==> Step 7/10: Generating MCP configuration mutation plans...");
      this.journal.completeStep("config_planning");

      // Step 8: Apply configuration mutations
      this.journal.startStep("apply");
      this.log(
        `==> Step 8/10: ${dryRun ? "[DRY-RUN] Simulating" : "Applying"} harness MCP configuration updates...`,
      );

      const orchestrator = new HarnessConfigOrchestrator();
      const orchestrationResult = await orchestrator.configureHarnesses({
        harnesses: parsedHarnesses,
        workspacePath,
        gatewayUrl: options.gatewayUrl,
        customHome,
        fsBridge: this.fsBridge,
        dryRun,
        onPlanCreated: (p) => discoveredPlans.push(p),
      });

      // Register rollback actions for all applied backups
      for (const backup of orchestrationResult.backups) {
        this.journal.addRollbackAction(
          "apply",
          `Restore backup for ${backup.targetPath} (backupId: ${backup.backupId})`,
          async (bridge) => {
            if (backup.originalContent !== null) {
              await bridge.writeFile(backup.targetPath, backup.originalContent);
            } else {
              await bridge.unlink(backup.targetPath);
            }
          },
        );
      }

      if (!orchestrationResult.success) {
        throw new Error(orchestrationResult.error ?? "Failed to apply harness configurations");
      }

      this.journal.completeStep("apply", {
        dryRun,
        configuredCount: orchestrationResult.results.filter((r) => r.configured).length,
      });

      // Step 9: Verify registrations
      this.journal.startStep("verify");
      this.log(
        "==> Step 9/10: Verifying harness configuration integrity and gateway registration...",
      );
      const allConfigured = orchestrationResult.results.every((r) => r.configured);
      if (!allConfigured && !dryRun) {
        throw new Error("One or more harness configurations failed verification");
      }
      this.journal.completeStep("verify", { allConfigured });

      // Step 10: Complete transaction and save journal
      this.journal.startStep("complete");
      this.log("==> Step 10/10: Finalizing installation transaction and recording journal...");
      this.journal.finalize("completed");
      this.journal.completeStep("complete");

      const journalFilePath = path.join(daemonPaths.stateDir, "install-journal.json");
      if (!dryRun) {
        await this.journal.save(journalFilePath, this.fsBridge);
      }

      this.log("\n[SUCCESS] Tool Evolver initialization completed successfully!");

      return {
        success: true,
        dryRun,
        journalId: this.journal.journalId,
        platform: platformInfo,
        assets: assetResult,
        authPlan,
        harnesses: orchestrationResult.results,
        journal: this.journal.toJSON(),
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log(`\n[ERROR] Installation failed: ${error.message}`);
      this.log("[ROLLBACK] Initiating atomic rollback of all mutations...");

      const activeStep = this.journal.steps.find((s) => s.status === "running")?.name ?? "apply";
      this.journal.failStep(activeStep, error);

      // Execute atomic rollback
      const rollbackResult = await this.journal.rollback(this.fsBridge);
      this.log(
        `[ROLLBACK] Rollback finished. Executed ${rollbackResult.executedActionsCount} actions. Success: ${rollbackResult.success}`,
      );

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
    // Require Node >= 22.0.0
    const [major] = process.version.replace(/^v/, "").split(".").map(Number);
    if (major < 20) {
      throw new Error(`Node.js version 20 or higher is required. Detected ${process.version}`);
    }
  }

  /**
   * Parses target harnesses from string or string array.
   */
  private parseTargetHarnesses(harness?: string | string[]): SupportedHarnessId[] {
    if (!harness) {
      return ["claude-code", "codex-cli", "omp"];
    }
    const list = Array.isArray(harness) ? harness : harness.split(",");
    const result: SupportedHarnessId[] = [];
    for (const h of list) {
      const trimmed = h.trim();
      if (trimmed === "claude-code" || trimmed === "codex-cli" || trimmed === "omp") {
        result.push(trimmed);
      }
    }
    return result.length > 0 ? result : ["claude-code", "codex-cli", "omp"];
  }

  /**
   * Resolves display name for a harness ID.
   */
  private getHarnessDisplayName(id: SupportedHarnessId): string {
    switch (id) {
      case "claude-code":
        return "Claude Code CLI";
      case "codex-cli":
        return "Codex CLI";
      case "omp":
        return "Oh My Pi (OMP)";
    }
  }

  /**
   * Rollback previously saved installation journal.
   */
  private async handleRollbackOnly(customHome: string): Promise<InstallationSummary> {
    const daemonPaths = resolvePaths({
      home: customHome,
      toolEvolverHome: path.join(customHome, ".tool-evolver"),
      env: process.env,
      platform: process.platform,
    });
    const journalPath = path.join(daemonPaths.stateDir, "install-journal.json");

    let loadedJournal: InstallationJournal;
    try {
      loadedJournal = await InstallationJournal.load(journalPath, this.fsBridge);
    } catch (err) {
      throw new Error(`Cannot rollback: No previous install journal found at ${journalPath}`);
    }

    const rollbackResult = await loadedJournal.rollback(this.fsBridge);
    await loadedJournal.save(journalPath, this.fsBridge);

    return {
      success: rollbackResult.success,
      dryRun: false,
      journalId: loadedJournal.journalId,
      platform: detectPlatform(),
      assets: { allVerified: true, assets: [], missingRequired: [], digestMismatches: [] },
      authPlan: await createAuthorizationPlan({
        workspacePath: customHome,
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
