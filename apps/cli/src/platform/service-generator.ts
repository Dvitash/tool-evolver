import path from "node:path";
import process from "node:process";

export type ServiceManagerKind = "systemd" | "launchd" | "wsl-systemd" | "wsl-fallback";

export interface ServiceGeneratorOptions {
  serviceName?: string;
  description?: string;
  daemonPath?: string;
  nodePath?: string;
  args?: string[];
  homeDir?: string;
  toolEvolverHome?: string;
  logDir?: string;
  stateDir?: string;
  env?: Record<string, string | undefined>;
  restartSec?: number;
  enableHardening?: boolean;
}

/**
 * Escapes strings for XML attributes/nodes.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escapes values for systemd unit file Environment directives.
 */
function escapeSystemdEnv(val: string): string {
  if (/[\s"'\\]/.test(val)) {
    return `"${val.replace(/["\\]/g, "\\$&")}"`;
  }
  return val;
}

/**
 * Generates a systemd user service unit file content for Linux and WSL (systemd).
 */
export function generateSystemdUnit(options: ServiceGeneratorOptions = {}): string {
  const serviceName = options.serviceName ?? "tool-evolver";
  const description =
    options.description ?? "Tool Evolver Background Observer and Evolution Daemon";
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const toolEvolverHome = options.toolEvolverHome ?? path.join(homeDir, ".tool-evolver");
  const daemonPath = options.daemonPath ?? path.join(toolEvolverHome, "bin", "tool-evolver-daemon");
  const nodePath = options.nodePath ?? process.execPath;
  const restartSec = options.restartSec ?? 3;
  const enableHardening = options.enableHardening ?? false;

  const extraArgs = options.args && options.args.length > 0 ? ` ${options.args.join(" ")}` : "";
  const execStart = `${nodePath} ${daemonPath}${extraArgs}`;

  const envEntries: string[] = [
    `Environment="NODE_ENV=production"`,
    `Environment="TOOL_EVOLVER_HOME=${toolEvolverHome}"`,
  ];

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) {
        envEntries.push(`Environment="${key}=${escapeSystemdEnv(value)}"`);
      }
    }
  }

  const hardeningDirectives = enableHardening
    ? [
        "# Security and Sandbox Hardening",
        "NoNewPrivileges=yes",
        "PrivateTmp=true",
        "ProtectSystem=strict",
        `ReadWritePaths=${toolEvolverHome}`,
      ]
    : [];

  const lines = [
    "[Unit]",
    `Description=${description}`,
    "Documentation=https://github.com/tool-evolver/tool-evolver",
    "After=network.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Restart=always",
    `RestartSec=${restartSec}`,
    "TimeoutStopSec=15",
    "StandardOutput=journal",
    "StandardError=journal",
    `WorkingDirectory=${toolEvolverHome}`,
    ...envEntries,
    ...hardeningDirectives,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];

  return lines.join("\n");
}

/**
 * Generates a launchd user agent plist file for macOS.
 */
export function generateLaunchdPlist(options: ServiceGeneratorOptions = {}): string {
  const serviceName = options.serviceName ?? "com.toolevolver.daemon";
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const toolEvolverHome = options.toolEvolverHome ?? path.join(homeDir, ".tool-evolver");
  const daemonPath = options.daemonPath ?? path.join(toolEvolverHome, "bin", "tool-evolver-daemon");
  const nodePath = options.nodePath ?? process.execPath;
  const logDir = options.logDir ?? path.join(homeDir, "Library", "Logs", "tool-evolver");

  const stdoutPath = path.join(logDir, "daemon.log");
  const stderrPath = path.join(logDir, "daemon.err.log");

  const programArguments = [nodePath, daemonPath, ...(options.args ?? [])];

  const envDict: Record<string, string> = {
    NODE_ENV: "production",
    TOOL_EVOLVER_HOME: toolEvolverHome,
    ...((options.env as Record<string, string>) ?? {}),
  };

  const programArgsXml = programArguments
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const envXml = Object.entries(envDict)
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) =>
        `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(String(v))}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(serviceName)}</string>

  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ProcessType</key>
  <string>Standard</string>

  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>

  <key>WorkingDirectory</key>
  <string>${escapeXml(toolEvolverHome)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

/**
 * Generates a WSL supervisor fallback script for environments without systemd.
 */
export function generateWslFallbackScript(options: ServiceGeneratorOptions = {}): string {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const toolEvolverHome = options.toolEvolverHome ?? path.join(homeDir, ".tool-evolver");
  const daemonPath = options.daemonPath ?? path.join(toolEvolverHome, "bin", "tool-evolver-daemon");
  const nodePath = options.nodePath ?? process.execPath;
  const stateDir = options.stateDir ?? path.join(toolEvolverHome, "state");
  const logDir = options.logDir ?? path.join(toolEvolverHome, "logs");
  const pidFile = path.join(stateDir, "daemon.pid");
  const stdoutLog = path.join(logDir, "daemon.out.log");
  const stderrLog = path.join(logDir, "daemon.err.log");

  const envExports = Object.entries(options.env ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `export ${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join("\n");

  return `#!/usr/bin/env bash
# Tool Evolver WSL Supervisor Fallback Daemon Runner
# Provides process supervisor, autostart, and health tracking in WSL environments without systemd.

set -euo pipefail

TOOL_EVOLVER_HOME="${toolEvolverHome}"
NODE_PATH="${nodePath}"
DAEMON_PATH="${daemonPath}"
STATE_DIR="${stateDir}"
LOG_DIR="${logDir}"
PID_FILE="${pidFile}"
OUT_LOG="${stdoutLog}"
ERR_LOG="${stderrLog}"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$TOOL_EVOLVER_HOME"

${envExports}
export NODE_ENV="production"
export TOOL_EVOLVER_HOME="$TOOL_EVOLVER_HOME"

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

start_daemon() {
  if is_running; then
    echo "Tool Evolver daemon is already running with PID $(cat "$PID_FILE")."
    return 0
  fi

  echo "Starting Tool Evolver daemon in WSL fallback supervisor mode..."
  nohup "$NODE_PATH" "$DAEMON_PATH" >> "$OUT_LOG" 2>> "$ERR_LOG" &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"
  echo "Tool Evolver daemon started (PID: $new_pid)."
}

stop_daemon() {
  if ! is_running; then
    echo "Tool Evolver daemon is not running."
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  echo "Stopping Tool Evolver daemon (PID: $pid)..."
  kill "$pid" 2>/dev/null || true

  # Wait up to 10 seconds for graceful shutdown
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "Force killing daemon (PID: $pid)..."
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo "Tool Evolver daemon stopped."
}

status_daemon() {
  if is_running; then
    echo "active (running) - PID: $(cat "$PID_FILE")"
    return 0
  else
    echo "inactive (dead)"
    return 3
  fi
}

case "\${1:-status}" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    sleep 1
    start_daemon
    ;;
  status)
    status_daemon
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
`;
}

/**
 * Validates generated service definitions for syntax and completeness.
 */
export function validateServiceDefinition(
  type: ServiceManagerKind,
  content: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!content || content.trim().length === 0) {
    return { valid: false, errors: ["Service content is empty."] };
  }

  if (type === "systemd" || type === "wsl-systemd") {
    if (!content.includes("[Unit]")) errors.push("Missing [Unit] section in systemd service.");
    if (!content.includes("[Service]"))
      errors.push("Missing [Service] section in systemd service.");
    if (!content.includes("[Install]"))
      errors.push("Missing [Install] section in systemd service.");
    if (!content.includes("ExecStart="))
      errors.push("Missing ExecStart directive in systemd service.");
  } else if (type === "launchd") {
    if (!content.includes("<!DOCTYPE plist"))
      errors.push("Missing XML DOCTYPE header in launchd plist.");
    if (!content.includes("<key>Label</key>"))
      errors.push("Missing <key>Label</key> in launchd plist.");
    if (!content.includes("<key>ProgramArguments</key>"))
      errors.push("Missing <key>ProgramArguments</key> in launchd plist.");
    if (!content.includes("<key>RunAtLoad</key>"))
      errors.push("Missing <key>RunAtLoad</key> in launchd plist.");
  } else if (type === "wsl-fallback") {
    if (!content.startsWith("#!/usr/bin/env bash"))
      errors.push("Missing bash shebang in WSL fallback script.");
    if (!content.includes("start_daemon()"))
      errors.push("Missing start_daemon function in WSL fallback script.");
    if (!content.includes("stop_daemon()"))
      errors.push("Missing stop_daemon function in WSL fallback script.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
