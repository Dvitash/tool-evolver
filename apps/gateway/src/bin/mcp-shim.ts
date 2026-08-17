#!/usr/bin/env node

import process from "node:process";
import { McpStdioShim } from "../shim/stdio-bridge.js";

const VERSION = "0.1.0";

function printHelp(): void {
  const text = `
Tool Evolver MCP Shim (v${VERSION})

Usage:
  tool-evolver-mcp [options]

Options:
  -s, --standalone       Enable standalone fallback (default)
  --no-standalone        Disable standalone fallback
  -S, --socket <path>    Daemon socket path
  -C, --cwd <path>       Working directory
  -H, --harness <id>     Harness identifier
  -h, --help             Show command line help
`;
  process.stdout.write(text.trimStart());
}

function parseArgs(args: string[]) {
  let standaloneFallback = true;
  let socketPath: string | undefined;
  let cwd: string | undefined;
  let harnessId: string | undefined;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--standalone" || arg === "-s") {
      standaloneFallback = true;
    } else if (arg === "--no-standalone") {
      standaloneFallback = false;
    } else if ((arg === "--socket" || arg === "-S") && i + 1 < args.length) {
      socketPath = args[++i];
    } else if ((arg === "--cwd" || arg === "-C") && i + 1 < args.length) {
      cwd = args[++i];
    } else if ((arg === "--harness" || arg === "-H") && i + 1 < args.length) {
      harnessId = args[++i];
    }
  }

  return { standaloneFallback, socketPath, cwd, harnessId, showHelp };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.showHelp) {
    printHelp();
    return;
  }

  const shim = new McpStdioShim({
    standaloneFallback: args.standaloneFallback,
    socketPath: args.socketPath,
    cwd: args.cwd,
    harnessId: args.harnessId,
  });

  const shutdown = async () => {
    await shim.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const status = await shim.start();
    if (status.mode === "failed") {
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Fatal MCP Shim error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    process.stderr.write(`Unhandled error: ${err}\n`);
    process.exit(1);
  });
}

export { main, parseArgs };
