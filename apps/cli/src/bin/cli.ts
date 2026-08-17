#!/usr/bin/env node

import process from "node:process";
import { doctorCommand, repairCommand } from "../commands/doctor.js";
import { initCommand } from "../commands/init.js";
import { logoutCommand } from "../commands/logout.js";
import { statusCommand } from "../commands/status.js";
import { uninstallCommand } from "../commands/uninstall.js";
import { upgradeCommand } from "../commands/upgrade.js";

const VERSION = "0.1.0";

function printGlobalHelp(): void {
  const text = `
Tool Evolver CLI (v${VERSION})

Usage:
  tool-evolver <command> [options]

Commands:
  init         Install, authorize, and configure AI agent harnesses for Tool Evolver.
  status       Display live status and health of the daemon, tools, and harnesses.
  doctor       Diagnose platform, filesystem, service, IPC, database, and harness state.
  repair       Automatically remediate detected issues and restore healthy service state.
  upgrade      Atomic in-place release upgrade with health gate and auto-rollback.
  logout       Revoke and purge local device credentials from secure vault.
  uninstall    Stop and remove service, clean harness configs, and optionally purge data.
  version      Display Tool Evolver CLI version.
  help         Show command line help.

Run "tool-evolver <command> --help" for detailed information on a specific command.
`;
  process.stdout.write(text.trimStart());
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command = "help", ...args] = argv;

  switch (command) {
    case "init":
      return await initCommand(args);

    case "status":
      return await statusCommand(args);

    case "doctor":
      return await doctorCommand(args);

    case "repair":
      return await repairCommand(args);

    case "upgrade":
      return await upgradeCommand(args);

    case "logout":
      return await logoutCommand(args);

    case "uninstall":
      return await uninstallCommand(args);

    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`tool-evolver v${VERSION}\n`);
      return 0;

    case "help":
    case "--help":
    case "-h":
      printGlobalHelp();
      return 0;

    default:
      process.stderr.write(
        `Unknown command "${command}". Run "tool-evolver help" for available commands.\n`,
      );
      return 1;
  }
}

if (process.env.NODE_ENV !== "test") {
  main()
    .then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((err) => {
      process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
