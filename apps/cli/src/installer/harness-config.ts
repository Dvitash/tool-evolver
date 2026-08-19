import os from "node:os";
import path from "node:path";
import {
  planClaudeMcpConfig,
  probeClaudeInstallation,
  verifyClaudeMcpConfig,
} from "@tool-evolver/adapter-claude-code";
import {
  planCodexMcpConfig,
  probeCodexInstallation,
  verifyCodexMcpConfig,
} from "@tool-evolver/adapter-codex";
import {
  planOmpMcpConfig,
  probeOmpInstallation,
  verifyOmpMcpConfig,
} from "@tool-evolver/adapter-omp";
import {
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  type HarnessInstallation,
  type HarnessWorkspace,
  applyConfigMutation,
  defaultFsBridge,
  rollbackConfigMutation,
} from "@tool-evolver/harness-contracts";

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:9400/mcp/sse";

export type SupportedHarnessId = "claude-code" | "codex-cli" | "omp";

export interface HarnessConfigResult {
  readonly harnessId: SupportedHarnessId;
  readonly displayName: string;
  readonly installed: boolean;
  readonly configured: boolean;
  readonly wasAlreadyConfigured: boolean;
  readonly targetPath?: string;
  readonly plan?: ConfigMutationPlan;
  readonly backup?: ConfigBackup;
  readonly error?: string;
}

export interface MultiHarnessConfigOptions {
  harnesses?: SupportedHarnessId[];
  workspacePath?: string;
  gatewayUrl?: string;
  customHome?: string;
  fsBridge?: ConfigFsBridge;
  dryRun?: boolean;
  onHarnessDiscovered?: (harness: HarnessInstallation) => void;
  onPlanCreated?: (plan: ConfigMutationPlan) => void;
}

export interface OrchestrationResult {
  readonly success: boolean;
  readonly results: HarnessConfigResult[];
  readonly backups: ConfigBackup[];
  readonly error?: string;
  rollback: () => Promise<void>;
}

/**
 * Orchestrates multi-harness discovery, configuration planning, atomic application,
 * and rollback across Claude Code, Codex CLI, and Oh My Pi.
 */
export class HarnessConfigOrchestrator {
  private readonly appliedBackups: ConfigBackup[] = [];

  /**
   * Discovers and configures all requested or detected AI agent harnesses.
   */
  async configureHarnesses(options: MultiHarnessConfigOptions = {}): Promise<OrchestrationResult> {
    const fsBridge = options.fsBridge ?? defaultFsBridge;
    const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    const customHome = options.customHome ?? process.env.HOME ?? os.homedir();
    const workspacePath = options.workspacePath ?? process.cwd();
    const targetHarnesses = options.harnesses ?? ["claude-code", "codex-cli", "omp"];

    const results: HarnessConfigResult[] = [];
    this.appliedBackups.length = 0;

    try {
      // 1. Claude Code CLI
      if (targetHarnesses.includes("claude-code")) {
        const claudeResult = await this.configureClaudeCode({
          customHome,
          workspacePath,
          gatewayUrl,
          fsBridge,
          dryRun: options.dryRun,
          onHarnessDiscovered: options.onHarnessDiscovered,
          onPlanCreated: options.onPlanCreated,
        });
        results.push(claudeResult);
      }

      // 2. Codex CLI
      if (targetHarnesses.includes("codex-cli")) {
        const codexResult = await this.configureCodex({
          customHome,
          workspacePath,
          gatewayUrl,
          fsBridge,
          dryRun: options.dryRun,
          onHarnessDiscovered: options.onHarnessDiscovered,
          onPlanCreated: options.onPlanCreated,
        });
        results.push(codexResult);
      }

      // 3. Oh My Pi (OMP)
      if (targetHarnesses.includes("omp")) {
        const ompResult = await this.configureOmp({
          customHome,
          workspacePath,
          gatewayUrl,
          fsBridge,
          dryRun: options.dryRun,
          onHarnessDiscovered: options.onHarnessDiscovered,
          onPlanCreated: options.onPlanCreated,
        });
        results.push(ompResult);
      }

      return {
        success: true,
        results,
        backups: [...this.appliedBackups],
        rollback: async () => {
          await this.rollbackAll(fsBridge);
        },
      };
    } catch (err: unknown) {
      // Automatic atomic rollback of everything applied so far
      await this.rollbackAll(fsBridge);
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        results,
        backups: [...this.appliedBackups],
        error: errorMsg,
        rollback: async () => {
          await this.rollbackAll(fsBridge);
        },
      };
    }
  }

  /**
   * Configures Claude Code harness MCP settings.
   */
  private async configureClaudeCode(options: {
    customHome: string;
    workspacePath: string;
    gatewayUrl: string;
    fsBridge: ConfigFsBridge;
    dryRun?: boolean;
    onHarnessDiscovered?: (h: HarnessInstallation) => void;
    onPlanCreated?: (p: ConfigMutationPlan) => void;
  }): Promise<HarnessConfigResult> {
    const { customHome, workspacePath, gatewayUrl, fsBridge, dryRun } = options;

    const fallbackConfigPath = path.join(customHome, ".claude", "claude.json");
    const fallbackInstallation: HarnessInstallation = {
      harnessId: "claude-code",
      displayName: "Claude Code CLI",
      version: "0.1.0",
      isInstalled: false,
      status: "unknown",
      configPath: fallbackConfigPath,
      homePath: path.join(customHome, ".claude"),
      detectedAt: new Date().toISOString(),
      metadata: {},
    };
    let installation: HarnessInstallation;
    try {
      const probed = await probeClaudeInstallation(
        { customConfigPath: fallbackConfigPath },
        fsBridge,
      );
      installation = probed ?? fallbackInstallation;
    } catch {
      installation = fallbackInstallation;
    }

    options.onHarnessDiscovered?.(installation);

    const targetConfigPath = installation.configPath ?? fallbackConfigPath;

    const workspace: HarnessWorkspace = {
      workspaceId: `claude_${path.basename(workspacePath)}`,
      rootPath: workspacePath,
      name: path.basename(workspacePath),
      harnessId: "claude-code",
      configPath: targetConfigPath,
      mcpConfigPath: targetConfigPath,
      metadata: {},
    };

    // Check if already configured
    const alreadyConfigured = await verifyClaudeMcpConfig(workspace, gatewayUrl, fsBridge);
    if (alreadyConfigured) {
      return {
        harnessId: "claude-code",
        displayName: "Claude Code CLI",
        installed: installation.status === "ready" || installation.status === "unknown",
        configured: true,
        wasAlreadyConfigured: true,
        targetPath: targetConfigPath,
      };
    }

    // Plan mutation
    const plan = await planClaudeMcpConfig(workspace, gatewayUrl, fsBridge);
    options.onPlanCreated?.(plan);

    if (dryRun) {
      return {
        harnessId: "claude-code",
        displayName: "Claude Code CLI",
        installed: true,
        configured: true,
        wasAlreadyConfigured: false,
        targetPath: targetConfigPath,
        plan,
      };
    }

    // Apply mutation
    const backup = await applyConfigMutation(plan, fsBridge);
    this.appliedBackups.push(backup);

    return {
      harnessId: "claude-code",
      displayName: "Claude Code CLI",
      installed: true,
      configured: true,
      wasAlreadyConfigured: false,
      targetPath: targetConfigPath,
      plan,
      backup,
    };
  }

  /**
   * Configures Codex CLI harness MCP settings.
   */
  private async configureCodex(options: {
    customHome: string;
    workspacePath: string;
    gatewayUrl: string;
    fsBridge: ConfigFsBridge;
    dryRun?: boolean;
    onHarnessDiscovered?: (h: HarnessInstallation) => void;
    onPlanCreated?: (p: ConfigMutationPlan) => void;
  }): Promise<HarnessConfigResult> {
    const { customHome, gatewayUrl, fsBridge, dryRun } = options;

    const fallbackConfigPath = path.join(customHome, ".codex", "config.toml");
    const fallbackInstallation: HarnessInstallation = {
      harnessId: "codex-cli",
      displayName: "Codex CLI",
      version: "0.1.0",
      isInstalled: false,
      status: "unknown",
      configPath: fallbackConfigPath,
      homePath: path.join(customHome, ".codex"),
      detectedAt: new Date().toISOString(),
      metadata: {},
    };
    let installation: HarnessInstallation;
    try {
      const probed = await probeCodexInstallation({ customConfigPath: fallbackConfigPath });
      installation = probed ?? fallbackInstallation;
    } catch {
      installation = fallbackInstallation;
    }

    options.onHarnessDiscovered?.(installation);

    const targetConfigPath = installation.configPath ?? fallbackConfigPath;

    const alreadyConfigured = await verifyCodexMcpConfig(
      targetConfigPath,
      gatewayUrl,
      undefined,
      fsBridge,
    );
    if (alreadyConfigured) {
      return {
        harnessId: "codex-cli",
        displayName: "Codex CLI",
        installed: installation.status === "ready" || installation.status === "unknown",
        configured: true,
        wasAlreadyConfigured: true,
        targetPath: targetConfigPath,
      };
    }

    const plan = await planCodexMcpConfig({
      targetPath: targetConfigPath,
      gatewayUrl,
      fsBridge,
    });
    options.onPlanCreated?.(plan);

    if (dryRun) {
      return {
        harnessId: "codex-cli",
        displayName: "Codex CLI",
        installed: true,
        configured: true,
        wasAlreadyConfigured: false,
        targetPath: targetConfigPath,
        plan,
      };
    }

    const backup = await applyConfigMutation(plan, fsBridge);
    this.appliedBackups.push(backup);

    return {
      harnessId: "codex-cli",
      displayName: "Codex CLI",
      installed: true,
      configured: true,
      wasAlreadyConfigured: false,
      targetPath: targetConfigPath,
      plan,
      backup,
    };
  }

  /**
   * Configures Oh My Pi (OMP) harness MCP settings.
   */
  private async configureOmp(options: {
    customHome: string;
    workspacePath: string;
    gatewayUrl: string;
    fsBridge: ConfigFsBridge;
    dryRun?: boolean;
    onHarnessDiscovered?: (h: HarnessInstallation) => void;
    onPlanCreated?: (p: ConfigMutationPlan) => void;
  }): Promise<HarnessConfigResult> {
    const { customHome, gatewayUrl, fsBridge, dryRun } = options;

    const fallbackConfigPath = path.join(customHome, ".omp", "agent", "mcp.json");
    const fallbackInstallation: HarnessInstallation = {
      harnessId: "omp",
      displayName: "Oh My Pi (OMP)",
      version: "0.1.0",
      isInstalled: false,
      status: "unknown",
      configPath: fallbackConfigPath,
      homePath: path.join(customHome, ".omp"),
      detectedAt: new Date().toISOString(),
      metadata: {},
    };
    let installation: HarnessInstallation;
    try {
      const probed = await probeOmpInstallation({ homeDir: customHome });
      installation = probed ?? fallbackInstallation;
    } catch {
      installation = fallbackInstallation;
    }

    options.onHarnessDiscovered?.(installation);

    const targetConfigPath = installation.configPath ?? fallbackConfigPath;

    const alreadyConfigured = await verifyOmpMcpConfig({
      customConfigPath: targetConfigPath,
      gatewayUrl,
      fsBridge,
    });

    if (alreadyConfigured) {
      return {
        harnessId: "omp",
        displayName: "Oh My Pi (OMP)",
        installed: installation.status === "ready" || installation.status === "unknown",
        configured: true,
        wasAlreadyConfigured: true,
        targetPath: targetConfigPath,
      };
    }

    const plan = await planOmpMcpConfig({
      customConfigPath: targetConfigPath,
      gatewayUrl,
      fsBridge,
    });
    options.onPlanCreated?.(plan);

    if (dryRun) {
      return {
        harnessId: "omp",
        displayName: "Oh My Pi (OMP)",
        installed: true,
        configured: true,
        wasAlreadyConfigured: false,
        targetPath: targetConfigPath,
        plan,
      };
    }

    const backup = await applyConfigMutation(plan, fsBridge);
    this.appliedBackups.push(backup);

    return {
      harnessId: "omp",
      displayName: "Oh My Pi (OMP)",
      installed: true,
      configured: true,
      wasAlreadyConfigured: false,
      targetPath: targetConfigPath,
      plan,
      backup,
    };
  }

  /**
   * Rolls back all applied harness configuration mutations in reverse order.
   */
  async rollbackAll(fsBridge: ConfigFsBridge = defaultFsBridge): Promise<void> {
    while (this.appliedBackups.length > 0) {
      const backup = this.appliedBackups.pop();
      if (!backup) continue;
      try {
        await rollbackConfigMutation(backup, fsBridge);
      } catch (err) {
        // Log or accumulate rollback errors
      }
    }
  }
}
