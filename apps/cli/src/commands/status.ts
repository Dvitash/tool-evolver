import os from "node:os";
import path from "node:path";
import process from "node:process";
import { probeClaudeInstallation, verifyClaudeMcpConfig } from "@tool-evolver/adapter-claude-code";
import { probeCodexInstallation, verifyCodexMcpConfig } from "@tool-evolver/adapter-codex";
import { probeOmpInstallation, verifyOmpMcpConfig } from "@tool-evolver/adapter-omp";
const SYSTEM_META_TOOL_NAMES = [
  "search_tools",
  "get_tool_schema",
  "invoke_tool",
  "manage_tools",
] as const;
import { type ConfigFsBridge, defaultFsBridge } from "@tool-evolver/harness-contracts";
import { IpcClient, resolvePaths } from "@tool-evolver/observer";
import { areClaimsExpired } from "@tool-evolver/protocol";
import { DeviceAuthClient } from "../service/auth-bootstrap.js";
import { createUserServiceManager } from "../service/manager.js";

export interface StatusCommandFlags {
  json?: boolean;
  home?: string;
  socket?: string;
  help?: boolean;
}

export interface DaemonStatusSummary {
  service: {
    installed: boolean;
    active: boolean;
    enabled: boolean;
    platform: string;
    serviceName: string;
    pid?: number;
  };
  ipc: {
    connected: boolean;
    pingLatencyMs?: number;
    daemonVersion?: string;
    uptimeSeconds?: number;
    error?: string;
  };
  cloud: {
    authenticated: boolean;
    workspaceId?: string;
    deviceId?: string;
    expiresAt?: string;
    expired?: boolean;
    scopes?: string[];
  };
  tools: {
    metaToolsCount: number;
    metaTools: string[];
    activeCustomToolsCount: number;
  };
  harnesses: Array<{
    id: string;
    name: string;
    installed: boolean;
    configured: boolean;
    configPath?: string;
  }>;
}

export function parseStatusFlags(args: string[]): StatusCommandFlags {
  const flags: StatusCommandFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice(7);
    } else if (arg === "--socket" && i + 1 < args.length) {
      flags.socket = args[++i];
    } else if (arg.startsWith("--socket=")) {
      flags.socket = arg.slice(9);
    }
  }
  return flags;
}

export function printStatusHelp(): void {
  const text = `
Usage:
  tool-evolver status [options]

Displays live status and health of the Tool Evolver daemon, connected agent
harnesses, MCP gateway, registered tools, and Cloud authentication.

Options:
  --json           Output status in structured JSON format.
  --home <path>    Custom Tool Evolver home directory (overrides ~/.tool-evolver).
  --socket <path>  Custom Unix socket path for daemon IPC communication.
  -h, --help       Show this help message.
`;
  process.stdout.write(text.trimStart());
}

export async function collectStatus(options: {
  home?: string;
  socket?: string;
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
}): Promise<DaemonStatusSummary> {
  const customHome = options.home ? path.resolve(options.home) : os.homedir();
  const daemonPaths = resolvePaths({ home: customHome });
  const fsBridge = options.fsBridge ?? defaultFsBridge;

  // 1. Service Manager Status
  const serviceManager = createUserServiceManager({
    homeDir: customHome,
    toolEvolverHome: path.join(customHome, ".tool-evolver"),
    fsBridge,
  });
  const svcStatus = await serviceManager.status();

  // 2. IPC Status
  const socketPath = options.socket ?? daemonPaths.socketPath;
  let ipcConnected = false;
  let pingLatencyMs: number | undefined;
  let daemonVersion: string | undefined;
  let uptimeSeconds: number | undefined;
  let ipcError: string | undefined;

  const socketExists = await fsBridge.exists(socketPath);
  if (socketExists) {
    const ipcClient = new IpcClient({ socketPath, timeoutMs: 2000 });
    const pingStart = performance.now();
    try {
      await ipcClient.connect();
      const pingRes = await ipcClient.ping();
      pingLatencyMs = Math.round(performance.now() - pingStart);
      ipcConnected = Boolean(pingRes.pong);
      const health = await ipcClient.getHealth().catch(() => null);
      if (health) {
        uptimeSeconds = health.uptimeSeconds;
      }
      await ipcClient.close();
    } catch (err: unknown) {
      ipcError = err instanceof Error ? err.message : String(err);
    }
  } else {
    ipcError = "Socket file not found";
  }

  // 3. Cloud Auth Status
  const authClient = new DeviceAuthClient({
    tokenFilePath: path.join(customHome, ".tool-evolver", "state", "device-token.json"),
    customFetch: options.customFetch,
  });
  const creds = await authClient.loadCredentials();
  const cloudStatus = {
    authenticated: Boolean(creds?.accessToken),
    workspaceId: creds?.workspaceId,
    deviceId: creds?.deviceId,
    expiresAt: creds?.claims.expiresAt,
    expired: creds ? areClaimsExpired(creds.claims) : undefined,
    scopes: creds?.claims.scopes,
  };

  // 4. Invariant & Custom Tools

  // 5. Harness Configurations
  const [claudeProbe, codexProbe, ompProbe] = await Promise.all([
    probeClaudeInstallation(),
    probeCodexInstallation(),
    probeOmpInstallation(),
  ]);
  const claudePath = path.join(customHome, ".claude.json");
  const codexPath = path.join(customHome, ".codex", "config.toml");
  const ompPath = path.join(customHome, ".omp", "config.json");

  const [claudeContent, codexContent, ompContent] = await Promise.all([
    fsBridge.readFile(claudePath),
    fsBridge.readFile(codexPath),
    fsBridge.readFile(ompPath),
  ]);

  const claudeConfigured = Boolean(claudeContent && (claudeContent.includes("tool-evolver") || claudeContent.includes("toolevolver")));
  const codexConfigured = Boolean(codexContent && (codexContent.includes("tool-evolver") || codexContent.includes("toolevolver")));
  const ompConfigured = Boolean(ompContent && (ompContent.includes("tool-evolver") || ompContent.includes("toolevolver")));

  const harnesses = [
    {
      id: "claude-code",
      name: "Claude Code",
      installed: claudeProbe.status === "ready" || claudeProbe.status === "unknown",
      configured: claudeConfigured,
      configPath: claudePath,
    },
    {
      id: "codex-cli",
      name: "Codex CLI",
      installed: codexProbe.status === "ready" || codexProbe.status === "unknown",
      configured: codexConfigured,
      configPath: codexPath,
    },
    {
      id: "omp",
      name: "Oh My Pi (OMP)",
      installed: Boolean(ompProbe && (ompProbe.status === "ready" || ompProbe.status === "unknown")),
      configured: ompConfigured,
      configPath: ompPath,
    },
  ];

  const metaToolNames = [...SYSTEM_META_TOOL_NAMES];

  return {
    service: {
      installed: svcStatus.installed,
      active: svcStatus.active,
      enabled: svcStatus.enabled,
      platform: serviceManager.platform,
      serviceName: svcStatus.serviceName,
      pid: svcStatus.pid,
    },
    ipc: {
      connected: ipcConnected,
      pingLatencyMs,
      daemonVersion,
      uptimeSeconds,
      error: ipcConnected ? undefined : ipcError,
    },
    cloud: cloudStatus,
    tools: {
      metaToolsCount: metaToolNames.length,
      metaTools: metaToolNames,
      activeCustomToolsCount: 0,
    },
    harnesses,
  };
}

export function formatStatusForTerminal(summary: DaemonStatusSummary): string {
  const lines: string[] = [];

  lines.push("┌────────────────────────────────────────────────────────┐");
  lines.push("│             TOOL EVOLVER SYSTEM STATUS                 │");
  lines.push("└────────────────────────────────────────────────────────┘");

  // Service Section
  const svcState = summary.service.active
    ? "RUNNING (active)"
    : summary.service.installed
      ? "STOPPED (inactive)"
      : "NOT INSTALLED";
  lines.push("\n[Daemon Service]");
  lines.push(`  Platform:   ${summary.service.platform}`);
  lines.push(`  Unit:       ${summary.service.serviceName}`);
  lines.push(`  State:      ${svcState}`);
  if (summary.service.pid) {
    lines.push(`  PID:        ${summary.service.pid}`);
  }

  // IPC Section
  lines.push("\n[IPC & Subsystems]");
  if (summary.ipc.connected) {
    lines.push(`  IPC Status: Connected (Latency: ${summary.ipc.pingLatencyMs}ms)`);
    lines.push(`  Version:    ${summary.ipc.daemonVersion ?? "v0.1.0"}`);
    if (summary.ipc.uptimeSeconds !== undefined) {
      lines.push(`  Uptime:     ${summary.ipc.uptimeSeconds}s`);
    }
  } else {
    lines.push(`  IPC Status: Offline (${summary.ipc.error ?? "disconnected"})`);
  }

  // Cloud Section
  lines.push("\n[Cloud Authentication]");
  if (summary.cloud.authenticated) {
    const expText = summary.cloud.expired ? "EXPIRED" : "VALID";
    lines.push(`  Status:     Authenticated (${expText})`);
    lines.push(`  Workspace:  ${summary.cloud.workspaceId ?? "unknown"}`);
    lines.push(`  Device ID:  ${summary.cloud.deviceId ?? "unknown"}`);
    lines.push(`  Scopes:     ${(summary.cloud.scopes ?? []).join(", ")}`);
  } else {
    lines.push("  Status:     Not Authenticated (Local-only mode)");
  }

  // Tools Section
  lines.push("\n[Tools & MCP Catalog]");
  lines.push(`  Meta-Tools: ${summary.tools.metaToolsCount} (${summary.tools.metaTools.join(", ")})`);
  lines.push(`  Custom:     ${summary.tools.activeCustomToolsCount} active dynamically evolved tools`);

  // Harnesses Section
  lines.push("\n[Agent Harness Connections]");
  for (const h of summary.harnesses) {
    const instStr = h.installed ? "Installed" : "Not Found";
    const confStr = h.configured ? "Configured (MCP Attached)" : "Not Configured";
    lines.push(`  • ${h.name.padEnd(16)} [${instStr}] → ${confStr}`);
  }

  lines.push("\n");
  return lines.join("\n");
}

export async function statusCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
    customFetch?: typeof fetch;
  } = {},
): Promise<number> {
  const flags = parseStatusFlags(args);

  if (flags.help) {
    printStatusHelp();
    return 0;
  }

  try {
    const summary = await collectStatus({
      home: flags.home,
      socket: flags.socket,
      fsBridge: options.fsBridge,
      customFetch: options.customFetch,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(formatStatusForTerminal(summary));
    }

    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ error: msg, success: false }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`\nError fetching status: ${msg}\n`);
    }
    return 1;
  }
}
