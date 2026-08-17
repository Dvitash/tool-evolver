#!/usr/bin/env node

import process from "node:process";
import { initCommand } from "../commands/init.js";

const VERSION = "0.1.0";

function printGlobalHelp(): void {
  const text = `
Tool Evolver CLI (v${VERSION})

Usage:
  tool-evolver <command> [options]

Commands:
  init       Install, authorize, and configure AI agent harnesses for Tool Evolver.
  version    Display Tool Evolver CLI version.
  help       Show command line help.

Run "tool-evolver <command> --help" for detailed information on a specific command.
`;
  process.stdout.write(text);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command = "help", ...args] = argv;

  switch (command) {
    case "init":
      return await initCommand(args);

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
