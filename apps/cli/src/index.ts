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

// Platform detection & validation
export * from "./installer/platform.js";

// Transaction Journal & Atomic Rollback
export * from "./installer/journal.js";

// Asset Acquisition & Verification
export * from "./installer/assets.js";

// Capabilities & Privacy Authorization Plan
export * from "./installer/auth-plan.js";

// Multi-Harness Configuration Orchestration
export * from "./installer/harness-config.js";

// End-to-end Installer Engine
export * from "./installer/installer.js";

// Service Manager (systemd, launchd, WSL)
export * from "./service/manager.js";

// Cloud Device Authentication Bootstrap
export * from "./service/auth-bootstrap.js";

// End-to-end Post-Install Verification Suite
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
