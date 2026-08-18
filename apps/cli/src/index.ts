/**
 * @tool-evolver/cli
 *
 * Command-line interface and single-command installer for Tool Evolver.
 */

// Legacy helper compatibility
export interface CliArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command = "help", ...rest] = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (const arg of rest) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags[k] = v ?? true;
    }
  }
  return { command, flags };
}

export async function runCli(args: CliArgs): Promise<number> {
  switch (args.command) {
    case "help":
      return 0;
    case "version":
      return 0;
    default:
      return 1;
  }
}

// Installer Engine
export * from "./installer/installer.js";
export * from "./installer/platform.js";
export * from "./installer/assets.js";
export * from "./installer/auth-plan.js";
export * from "./installer/harness-config.js";
export * from "./installer/journal.js";
export * from "./installer/channel-verifier.js";
export * from "./installer/asset-downloader.js";
export * from "./installer/user-service.js";

// Service & Auth
export * from "./service/manager.js";
export * from "./service/auth-bootstrap.js";
export * from "./service/verification.js";

// CLI Commands
export * from "./commands/init.js";
export * from "./commands/status.js";
export * from "./commands/doctor.js";
export * from "./commands/upgrade.js";
export * from "./commands/logout.js";
export * from "./commands/uninstall.js";

// CLI Main
export { main } from "./bin/cli.js";
