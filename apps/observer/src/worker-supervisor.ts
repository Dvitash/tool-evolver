import child_process from "node:child_process";
import process from "node:process";
import type { Logger } from "./lifecycle.js";

export type WorkerStatus =
  | "completed"
  | "timed_out"
  | "crashed"
  | "memory_exceeded"
  | "killed"
  | "spawn_failed";

export interface WorkerRunOptions {
  command?: string;
  args?: string[];
  scriptPath?: string;
  nodeArgs?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  inheritEnv?: boolean;
  timeoutMs?: number;
  maxMemoryMb?: number;
  maxOutputBytes?: number;
  stdin?: string | Buffer;
}

export interface WorkerRunResult {
  status: WorkerStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  pid?: number;
}

export interface WorkerSupervisorOptions {
  defaultTimeoutMs?: number;
  defaultMaxMemoryMb?: number;
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_MEMORY_MB = 512;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

const SENSITIVE_ENV_KEYS = [
  "TOOL_EVOLVER_AUTH_TOKEN",
  "TOOL_EVOLVER_CLOUD_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

/**
 * Builds a sanitized environment dictionary for child worker processes.
 */
export function buildSanitizedEnv(
  customEnv: Record<string, string | undefined> = {},
  inherit = false,
): Record<string, string> {
  const result: Record<string, string> = {};

  if (inherit) {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !SENSITIVE_ENV_KEYS.includes(k)) {
        result[k] = v;
      }
    }
  } else {
    // Retain only safe baseline variables
    const safeKeys = [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "TEMP",
      "TMP",
      "NODE_ENV",
      "LANG",
      "LC_ALL",
    ];
    for (const key of safeKeys) {
      const val = process.env[key];
      if (val !== undefined) {
        result[key] = val;
      }
    }
  }

  for (const [k, v] of Object.entries(customEnv)) {
    if (v !== undefined) {
      result[k] = v;
    }
  }

  return result;
}

/**
 * Supervises child worker processes, isolating crashes, resource violations, and timeouts.
 */
export class WorkerSupervisor {
  private defaultTimeoutMs: number;
  private defaultMaxMemoryMb: number;
  private logger?: Logger;

  constructor(options: WorkerSupervisorOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxMemoryMb = options.defaultMaxMemoryMb ?? DEFAULT_MAX_MEMORY_MB;
    this.logger = options.logger;
  }

  /**
   * Spawns a child worker and executes it with sandboxed environment, timeout, and buffer controls.
   */
  async runWorker(options: WorkerRunOptions): Promise<WorkerRunResult> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    let command: string;
    let args: string[];

    if (options.scriptPath) {
      command = process.execPath;
      args = [...(options.nodeArgs ?? []), options.scriptPath, ...(options.args ?? [])];
    } else if (options.command) {
      command = options.command;
      args = options.args ?? [];
    } else {
      return {
        status: "spawn_failed",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        error: "Either scriptPath or command must be provided",
      };
    }

    const sanitizedEnv = buildSanitizedEnv(options.env, options.inheritEnv);

    return new Promise<WorkerRunResult>((resolve) => {
      let child: child_process.ChildProcess;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let isTimedOut = false;
      let isSettled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;

      try {
        child = child_process.spawn(command, args, {
          cwd: options.cwd,
          env: sanitizedEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        resolve({
          status: "spawn_failed",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs,
          error: (err as Error).message,
        });
        return;
      }

      const finish = (
        status: WorkerStatus,
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        errorMsg?: string,
      ) => {
        if (isSettled) return;
        isSettled = true;

        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);

        const durationMs = Date.now() - startedAt;
        resolve({
          status,
          exitCode,
          signal,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          durationMs,
          error: errorMsg,
          pid: child.pid,
        });
      };

      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          isTimedOut = true;
          this.logger?.warn(
            `Worker ${child.pid} exceeded timeout of ${timeoutMs}ms, sending SIGTERM`,
          );
          try {
            child.kill("SIGTERM");
          } catch {
            // Ignore
          }

          // Follow up with SIGKILL if not exited after 1.5s
          killTimer = setTimeout(() => {
            if (!isSettled) {
              this.logger?.error(`Worker ${child.pid} did not exit after SIGTERM, sending SIGKILL`);
              try {
                child.kill("SIGKILL");
              } catch {
                // Ignore
              }
            }
          }, 1500);
          if (killTimer.unref) killTimer.unref();
        }, timeoutMs);

        if (timeoutTimer.unref) timeoutTimer.unref();
      }

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          if (stdoutBuffer.length < maxOutputBytes) {
            stdoutBuffer += chunk.toString("utf-8");
            if (stdoutBuffer.length > maxOutputBytes) {
              stdoutBuffer = `${stdoutBuffer.slice(0, maxOutputBytes)}\n...[OUTPUT TRUNCATED]`;
            }
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrBuffer.length < maxOutputBytes) {
            stderrBuffer += chunk.toString("utf-8");
            if (stderrBuffer.length > maxOutputBytes) {
              stderrBuffer = `${stderrBuffer.slice(0, maxOutputBytes)}\n...[STDERR TRUNCATED]`;
            }
          }
        });
      }

      if (options.stdin && child.stdin) {
        try {
          child.stdin.write(options.stdin);
          child.stdin.end();
        } catch {
          // Ignore pipe write errors
        }
      } else if (child.stdin) {
        child.stdin.end();
      }

      child.on("error", (err) => {
        finish("spawn_failed", null, null, err.message);
      });

      child.on("exit", (code, sig) => {
        const signal = sig as NodeJS.Signals | null;
        if (isTimedOut) {
          finish("timed_out", code, signal, `Worker timed out after ${timeoutMs}ms`);
        } else if (code === 0 && !signal) {
          finish("completed", code, null);
        } else {
          finish(
            "crashed",
            code,
            signal,
            signal
              ? `Worker killed with signal ${signal}`
              : `Worker exited with non-zero code ${code}`,
          );
        }
      });
    });
  }
}
