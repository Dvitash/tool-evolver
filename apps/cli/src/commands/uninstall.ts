import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@tool-evolver/harness-contracts";
import { resolvePaths } from "@tool-evolver/observer";
import { HarnessConfigOrchestrator } from "../installer/harness-config.js";
import { createUserServiceManager } from "../service/manager.js";

export interface UninstallCommandFlags {
  purgeData?: boolean;
  purgeSecrets?: boolean;
  purgeAll?: boolean;
  dryRun?: boolean;
  nonInteractive?: boolean;
  json?: boolean;
  home?: string;
  help?: boolean;
}

export interface UninstallResult {
  success: boolean;
  dryRun: boolean;
  serviceUninstalled: boolean;
  harnessesCleaned: string[];
  purgedData: boolean;
  purgedSecrets: boolean;
  purgedAll: boolean;
  removedPaths: string[];
  error?: string;
}

export function parseUninstallFlags(args: string[]): UninstallCommandFlags {
  const flags: UninstallCommandFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--non-interactive" || arg === "-y" || arg === "--yes") {
      flags.nonInteractive = true;
    } else if (arg === "--purge-data") {
      flags.purgeData = true;
    } else if (arg === "--purge-secrets") {
      flags.purgeSecrets = true;
    } else if (arg === "--purge-all" || arg === "--all") {
      flags.purgeAll = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice(7);
    }
  }
  return flags;
}

export function printUninstallHelp(): void {
  const text = `
Usage:
  tool-evolver uninstall [options]

Stops and removes the Tool Evolver background daemon service and removes Tool
Evolver MCP gateway registrations from all installed AI agent harnesses.

Options:
  --purge-data        Delete state databases, telemetry, and log files.
  --purge-secrets     Delete secure secret vault and cached cloud credentials.
  --purge-all, --all  Purge all Tool Evolver state, secrets, and directories completely.
  --dry-run           Simulate uninstallation without modifying files or services.
  -y, --yes           Skip confirmation prompts.
  --json              Output result in structured JSON format.
  --home <path>       Custom Tool Evolver home directory (overrides ~/.tool-evolver).
  -h, --help          Show this help message.
`;
  process.stdout.write(text.trimStart());
}

/**
 * Removes Tool Evolver MCP configuration from known harness config files.
 */
export async function removeHarnessMcpConfigurations(options: {
  customHome?: string;
  fsBridge?: ConfigFsBridge;
}): Promise<string[]> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const home = options.customHome ?? os.homedir();
  const cleaned: string[] = [];

  // 1. Claude Code (~/.claude.json)
  const claudePaths = [path.join(home, ".claude.json"), path.join(home, ".claude", "config.json")];
  for (const cPath of claudePaths) {
    const content = await fsBridge.readFile(cPath);
    if (content) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const mcp = parsed.mcpServers as Record<string, unknown> | undefined;
        if (mcp && ("tool-evolver" in mcp || "toolevolver" in mcp)) {
          delete mcp["tool-evolver"];
          delete mcp.toolevolver;
          await fsBridge.writeFile(cPath, JSON.stringify(parsed, null, 2));
          cleaned.push("Claude Code");
          break;
        }
      } catch {
        // Continue
      }
    }
  }

  // 2. Codex CLI (~/.codex/config.toml)
  const codexPath = path.join(home, ".codex", "config.toml");
  const codexContent = await fsBridge.readFile(codexPath);
  if (codexContent?.includes("tool-evolver")) {
    const lines = codexContent.split("\n");
    const filtered: string[] = [];
    let inSection = false;
    for (const line of lines) {
      if (
        line.includes("[mcp_servers.tool-evolver]") ||
        line.includes("[mcp_servers.toolevolver]")
      ) {
        inSection = true;
        continue;
      }
      if (inSection && line.startsWith("[")) {
        inSection = false;
      }
      if (!inSection) {
        filtered.push(line);
      }
    }
    await fsBridge.writeFile(codexPath, filtered.join("\n"));
    cleaned.push("Codex CLI");
  }

  // 3. OMP (~/.omp/config.json)
  const ompPath = path.join(home, ".omp", "config.json");
  const ompContent = await fsBridge.readFile(ompPath);
  if (ompContent) {
    try {
      const parsed = JSON.parse(ompContent) as Record<string, unknown>;
      const mcp = parsed.mcpServers as Record<string, unknown> | undefined;
      if (mcp && ("tool-evolver" in mcp || "toolevolver" in mcp)) {
        delete mcp["tool-evolver"];
        delete mcp.toolevolver;
        await fsBridge.writeFile(ompPath, JSON.stringify(parsed, null, 2));
        cleaned.push("Oh My Pi (OMP)");
      }
    } catch {
      // Continue
    }
  }

  return cleaned;
}

export async function uninstallCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
  } = {},
): Promise<number> {
  const flags = parseUninstallFlags(args);

  if (flags.help) {
    printUninstallHelp();
    return 0;
  }

  const customHome = flags.home ? path.resolve(flags.home) : os.homedir();
  const toolEvolverHome = path.join(customHome, ".tool-evolver");
  const daemonPaths = resolvePaths({ home: customHome });
  const fsBridge = options.fsBridge ?? defaultFsBridge;

  const removedPaths: string[] = [];

  if (flags.dryRun) {
    const dryRunResult: UninstallResult = {
      success: true,
      dryRun: true,
      serviceUninstalled: true,
      harnessesCleaned: ["Claude Code", "Codex CLI", "Oh My Pi (OMP)"],
      purgedData: Boolean(flags.purgeData || flags.purgeAll),
      purgedSecrets: Boolean(flags.purgeSecrets || flags.purgeAll),
      purgedAll: Boolean(flags.purgeAll),
      removedPaths: flags.purgeAll ? [toolEvolverHome] : [],
    };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(dryRunResult, null, 2)}\n`);
    } else {
      process.stdout.write("\n[DRY-RUN] Simulated uninstallation:\n");
      process.stdout.write("  • User background service would be stopped and removed.\n");
      process.stdout.write("  • Harness MCP entries would be cleaned up.\n");
      if (flags.purgeAll) {
        process.stdout.write(`  • Entire ${toolEvolverHome} directory would be purged.\n`);
      }
      process.stdout.write("\n");
    }
    return 0;
  }

  try {
    // 1. Stop and uninstall user background service
    const serviceManager = createUserServiceManager({
      homeDir: customHome,
      toolEvolverHome,
      fsBridge,
    });
    const svcUninstallResult = await serviceManager.uninstall();

    // 2. Remove Tool Evolver MCP configuration from all agent harnesses
    const cleanedHarnesses = await removeHarnessMcpConfigurations({
      customHome,
      fsBridge,
    });

    // 3. Purge data / secrets / all if requested
    const purgeAll = Boolean(flags.purgeAll);
    const purgeData = Boolean(flags.purgeData || purgeAll);
    const purgeSecrets = Boolean(flags.purgeSecrets || purgeAll);

    if (purgeAll) {
      if (await fsBridge.exists(toolEvolverHome)) {
        await fs.rm(toolEvolverHome, { recursive: true, force: true }).catch(() => {});
        removedPaths.push(toolEvolverHome);
      }
    } else {
      if (purgeData) {
        const dataDirs = [
          daemonPaths.dataDir,
          daemonPaths.logDir,
          path.join(toolEvolverHome, "artifacts"),
        ];
        for (const dir of dataDirs) {
          if (await fsBridge.exists(dir)) {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
            removedPaths.push(dir);
          }
        }
      }
      if (purgeSecrets) {
        const secretDirs = [
          path.join(toolEvolverHome, "vault"),
          daemonPaths.tokenFilePath,
          path.join(toolEvolverHome, "state", "device-token.json"),
        ];
        for (const target of secretDirs) {
          if (await fsBridge.exists(target)) {
            await fs.rm(target, { recursive: true, force: true }).catch(() => {});
            removedPaths.push(target);
          }
        }
      }
    }

    const result: UninstallResult = {
      success: true,
      dryRun: false,
      serviceUninstalled: svcUninstallResult.success,
      harnessesCleaned: cleanedHarnesses,
      purgedData: purgeData,
      purgedSecrets: purgeSecrets,
      purgedAll: purgeAll,
      removedPaths,
    };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write("\n✓ Tool Evolver uninstalled successfully.\n");
      process.stdout.write("  • Service stopped and unit removed.\n");
      if (cleanedHarnesses.length > 0) {
        process.stdout.write(
          `  • Removed MCP configurations for: ${cleanedHarnesses.join(", ")}\n`,
        );
      }
      if (purgeAll) {
        process.stdout.write(`  • Purged directory: ${toolEvolverHome}\n`);
      } else {
        if (purgeData) process.stdout.write("  • Data and log files purged.\n");
        if (purgeSecrets) process.stdout.write("  • Secrets and credentials purged.\n");
        if (!purgeData && !purgeSecrets) {
          process.stdout.write("  • Data and credentials preserved in ~/.tool-evolver\n");
        }
      }
      process.stdout.write("\n");
    }

    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ error: msg, success: false }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nUninstall failed: ${msg}\n`);
    }
    return 1;
  }
}
