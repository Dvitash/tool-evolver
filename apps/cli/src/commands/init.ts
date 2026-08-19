import process from "node:process";
import type { ConfigFsBridge } from "@tool-evolver/harness-contracts";
import {
  InstallationError,
  type InstallationSummary,
  type InstallerOptions,
  ToolEvolverInstaller,
} from "../installer/installer.js";

export interface InitCommandFlags {
  dryRun?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  autoApprove?: boolean;
  harness?: string;
  workspace?: string;
  capabilitiesFile?: string;
  privacyConfig?: string;
  rollbackInstall?: boolean;
  gatewayUrl?: string;
  home?: string;
  help?: boolean;
}

/**
 * Parses CLI flags specific to the `init` command.
 */
export function parseInitFlags(args: string[]): InitCommandFlags {
  const flags: InitCommandFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--non-interactive") {
      flags.nonInteractive = true;
    } else if (arg === "--auto-approve" || arg === "-y" || arg === "--yes") {
      flags.autoApprove = true;
    } else if (arg === "--rollback-install") {
      flags.rollbackInstall = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("--harness=")) {
      flags.harness = arg.slice(10);
    } else if (arg === "--harness" && i + 1 < args.length) {
      flags.harness = args[++i];
    } else if (arg.startsWith("--workspace=")) {
      flags.workspace = arg.slice(12);
    } else if (arg === "--workspace" && i + 1 < args.length) {
      flags.workspace = args[++i];
    } else if (arg.startsWith("--capabilities-file=")) {
      flags.capabilitiesFile = arg.slice(20);
    } else if (arg === "--capabilities-file" && i + 1 < args.length) {
      flags.capabilitiesFile = args[++i];
    } else if (arg.startsWith("--privacy-config=")) {
      flags.privacyConfig = arg.slice(17);
    } else if (arg === "--privacy-config" && i + 1 < args.length) {
      flags.privacyConfig = args[++i];
    } else if (arg.startsWith("--gateway-url=")) {
      flags.gatewayUrl = arg.slice(14);
    } else if (arg === "--gateway-url" && i + 1 < args.length) {
      flags.gatewayUrl = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice(7);
    } else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    }
  }

  return flags;
}

export function printInitHelp(): void {
  const text = `
Tool Evolver - Single-Command Installer & Harness Configuration

USAGE:
  tool-evolver init [options]

OPTIONS:
  --dry-run                  Preview all configuration changes and authorization plan without writing.
  --json                     Output result summary in JSON format.
  --non-interactive          Run without terminal prompts (requires explicit authorization flag/file).
  -y, --yes, --auto-approve  Automatically approve authorization plan in non-interactive mode.
  --harness <name>           Target specific harness(es): claude-code, codex-cli, omp (comma-separated).
  --workspace <path>         Target workspace directory (defaults to current directory).
  --capabilities-file <path> Custom JSON file defining capability envelope.
  --privacy-config <path>    Custom JSON file defining privacy and redaction rules.
  --gateway-url <url>        Local MCP Gateway endpoint URL (default: http://127.0.0.1:9400/mcp/sse).
  --home <path>              Custom Tool Evolver home directory (overrides ~/.tool-evolver).
  --rollback-install         Rollback previous installation changes using saved state journal.
  -h, --help                 Show this help message.
`;
  process.stdout.write(text);
}

/**
 * Executes the `init` command with the provided options.
 */
export async function runInit(
  options: InstallerOptions,
  customFsBridge?: ConfigFsBridge,
): Promise<InstallationSummary> {
  const installer = new ToolEvolverInstaller({
    fsBridge: customFsBridge,
    logger: options.json ? () => {} : options.logger,
  });

  return await installer.run(options);
}

/**
 * Command entry point for `tool-evolver init`.
 */
export async function initCommand(
  argv: string[],
  customFsBridge?: ConfigFsBridge,
): Promise<number> {
  const flags = parseInitFlags(argv);

  if (flags.help) {
    printInitHelp();
    return 0;
  }

  const installerOptions: InstallerOptions = {
    dryRun: flags.dryRun,
    json: flags.json,
    nonInteractive: flags.nonInteractive,
    autoApprove: flags.autoApprove,
    harness: flags.harness,
    workspace: flags.workspace,
    capabilitiesFile: flags.capabilitiesFile,
    privacyConfig: flags.privacyConfig,
    rollbackInstall: flags.rollbackInstall,
    gatewayUrl: flags.gatewayUrl,
    customHome: flags.home,
    releaseMode: flags.dryRun ? "local-test" : "production",
    releaseChannelUrl: process.env.TOOL_EVOLVER_RELEASE_CHANNEL_URL,
    allowInsecureReleaseTransportForTests:
      process.env.TOOL_EVOLVER_ALLOW_INSECURE_LOOPBACK_RELEASES === "1",
    fsBridge: customFsBridge,
  };

  try {
    const result = await runInit(installerOptions, customFsBridge);

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }

    return 0;
  } catch (err: unknown) {
    if (flags.json) {
      const errorJson = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        journal: err instanceof InstallationError ? err.journal : undefined,
      };
      process.stdout.write(`${JSON.stringify(errorJson, null, 2)}\n`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\nError: ${msg}\n`);
    }
    return 1;
  }
}
