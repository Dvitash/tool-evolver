import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandCapability } from "@tool-evolver/contracts";
import { isPathInsideRoot, normalizeSlashes } from "../policy/canonicalizers.js";
import { withResolvers } from "../worker/protocol.js";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";

/**
 * Standard parameters for brokered command execution.
 */
export interface CommandExecuteParams {
  command?: string;
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputSizeBytes?: number;
}

/**
 * Result of brokered command execution.
 */
export interface CommandExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Shell binaries blocked when shell execution is disallowed.
 */
const FORBIDDEN_SHELL_BINARIES: Record<string, true> = {
  sh: true,
  bash: true,
  zsh: true,
  csh: true,
  tcsh: true,
  ksh: true,
  dash: true,
  fish: true,
  cmd: true,
  "cmd.exe": true,
  powershell: true,
  "powershell.exe": true,
  pwsh: true,
  "pwsh.exe": true,
};

/**
 * Characters that indicate shell execution or injection attempts.
 */
const SHELL_METACHARACTERS_REGEX = /[;&|`$><\n\r\0]/;

/**
 * Capability broker for command and subprocess execution.
 * Enforces approved binary allowlists, shell denial, forbidden pattern matching,
 * working directory containment, environment isolation, process timeouts, and output limits.
 */
export class CommandBroker extends BaseCapabilityBroker {
  readonly serviceName = "cmd" as const;

  constructor(options: BaseCapabilityBrokerOptions = {}) {
    super(options);
  }

  /**
   * Validates and resolves an authorized command executable, working directory, and environment.
   */
  private authorizeExecution(
    params: CommandExecuteParams,
    context: BrokerContext,
    cmdCap: CommandCapability,
  ): {
    resolvedExecutable: string;
    resolvedArgs: string[];
    resolvedCwd: string;
    childEnv: NodeJS.ProcessEnv;
  } {
    const rawExe = (params.executable ?? params.command ?? "").trim();
    if (!rawExe) {
      throw new BrokerSecurityError("UNAUTHORIZED_BINARY", "Executable command must be specified");
    }

    const args = params.args ? [...params.args] : [];

    // 1. Shell Execution & Metacharacter Checks
    const allowShell = cmdCap.allowShellExecution ?? false;
    const baseExe = path.basename(rawExe).toLowerCase();

    if (!allowShell) {
      if (FORBIDDEN_SHELL_BINARIES[baseExe]) {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          `Direct execution of shell binary '${rawExe}' is denied when allowShellExecution is false`,
          { executable: rawExe },
        );
      }

      if (SHELL_METACHARACTERS_REGEX.test(rawExe)) {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          `Shell metacharacters in executable name are forbidden: ${rawExe}`,
          { executable: rawExe },
        );
      }

      for (const arg of args) {
        if (SHELL_METACHARACTERS_REGEX.test(arg)) {
          throw new BrokerSecurityError(
            "SHELL_EXECUTION_DENIED",
            `Shell metacharacters in argument are forbidden: ${arg}`,
            { argument: arg },
          );
        }
      }
    }

    // 2. Binary Allowlist Check
    const allowedBinaries = cmdCap.allowedBinaries ?? [];
    const allowedCommands = cmdCap.allowedCommands ?? [];
    const hasAllowlist = allowedBinaries.length > 0 || allowedCommands.length > 0;

    if (!hasAllowlist) {
      throw new BrokerSecurityError(
        "COMMAND_EXECUTION_DISABLED",
        "Command execution is disabled: no binaries or commands are authorized by capability policy",
        { executable: rawExe },
      );
    }

    let isBinaryAllowed = false;

    // Check exact binary name, base name, or full path against allowlists
    for (const allowed of [...allowedBinaries, ...allowedCommands]) {
      const normAllowed = allowed.trim();
      if (
        rawExe === normAllowed ||
        baseExe === normAllowed.toLowerCase() ||
        path.basename(normAllowed).toLowerCase() === baseExe
      ) {
        isBinaryAllowed = true;
        break;
      }
    }

    if (!isBinaryAllowed) {
      throw new BrokerSecurityError(
        "UNAUTHORIZED_BINARY",
        `Executable '${rawExe}' is not permitted by command capability allowlist`,
        { executable: rawExe, allowedBinaries, allowedCommands },
      );
    }

    // 3. PATH Injection Defense
    // Disallow relative paths like ./evil_bin or ../bin/evil unless explicitly in allowlist
    if (rawExe.startsWith("./") || rawExe.startsWith("../")) {
      if (!allowedBinaries.includes(rawExe) && !allowedCommands.includes(rawExe)) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_BINARY",
          `Relative path executable is not permitted: ${rawExe}`,
          { executable: rawExe },
        );
      }
    }

    // 4. Forbidden Patterns Check
    const forbiddenPatterns = cmdCap.forbiddenPatterns ?? [];
    const fullCommandLine = `${rawExe} ${args.join(" ")}`;

    for (const pattern of forbiddenPatterns) {
      const reg = new RegExp(pattern, "i");
      if (reg.test(fullCommandLine)) {
        throw new BrokerSecurityError(
          "FORBIDDEN_PATTERN",
          `Command line matches forbidden pattern '${pattern}'`,
          { commandLine: fullCommandLine, pattern },
        );
      }
    }

    // 5. Working Directory Containment
    const workspaceRoot = normalizeSlashes(path.resolve(context.workspaceRoot ?? process.cwd()));
    const scratchDir = context.scratchDir
      ? normalizeSlashes(path.resolve(context.scratchDir))
      : normalizeSlashes(os.tmpdir());

    let resolvedCwd = workspaceRoot;
    if (params.cwd) {
      const targetCwd = path.isAbsolute(params.cwd)
        ? normalizeSlashes(path.resolve(params.cwd))
        : normalizeSlashes(path.resolve(workspaceRoot, params.cwd));

      if (!isPathInsideRoot(targetCwd, workspaceRoot) && !isPathInsideRoot(targetCwd, scratchDir)) {
        throw new BrokerSecurityError(
          "WORKING_DIRECTORY_DENIED",
          `Working directory '${params.cwd}' is outside authorized roots`,
          { cwd: params.cwd, resolvedCwd: targetCwd },
        );
      }

      if (!fs.existsSync(targetCwd)) {
        throw new BrokerSecurityError(
          "WORKING_DIRECTORY_DENIED",
          `Working directory does not exist: ${params.cwd}`,
          { cwd: params.cwd },
        );
      }

      resolvedCwd = targetCwd;
    }

    // 6. Environment Isolation & Allowlist
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      TMPDIR: scratchDir,
    };

    // Pass through explicitly allowed environment variables from host
    const passthroughKeys = cmdCap.allowEnvPassthrough ?? [];
    for (const key of passthroughKeys) {
      if (process.env[key] !== undefined) {
        childEnv[key] = process.env[key];
      }
    }

    // Merge explicitly provided invocation env params (excluding dangerous loader overrides)
    if (params.env) {
      for (const [key, val] of Object.entries(params.env)) {
        const upper = key.toUpperCase();
        if (
          upper === "LD_PRELOAD" ||
          upper === "LD_LIBRARY_PATH" ||
          upper === "DYLD_INSERT_LIBRARIES"
        ) {
          continue; // Block dynamic linker hijacking
        }
        childEnv[key] = val;
      }
    }

    return {
      resolvedExecutable: rawExe,
      resolvedArgs: args,
      resolvedCwd,
      childEnv,
    };
  }

  /**
   * Executes a command within the authorized capability boundaries.
   */
  async execute(
    params: CommandExecuteParams,
    context: BrokerContext,
  ): Promise<CommandExecuteResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const cmdCap = grant.capabilities.command ?? {};
    const limits = grant.capabilities.limits;

    const maxOutputBytes = params.maxOutputSizeBytes ?? limits?.maxOutputSizeBytes ?? 1048576; // 1MB default
    const timeoutMs = Math.min(
      params.timeoutMs ?? limits?.maxExecutionTimeMs ?? 30000,
      limits?.maxExecutionTimeMs ?? 30000,
    );

    try {
      const { resolvedExecutable, resolvedArgs, resolvedCwd, childEnv } = this.authorizeExecution(
        params,
        context,
        cmdCap,
      );

      const result = await this.spawnSubprocess({
        executable: resolvedExecutable,
        args: resolvedArgs,
        cwd: resolvedCwd,
        env: childEnv,
        stdin: params.stdin,
        timeoutMs,
        maxOutputBytes,
      });

      const totalOutputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      this.trackOutputBytes(context.invocationId, totalOutputBytes, limits);

      this.recordAudit(
        "execute",
        context,
        "allowed",
        {
          executable: resolvedExecutable,
          argCount: resolvedArgs.length,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          outputBytes: totalOutputBytes,
        },
        { durationMs: Date.now() - startTime },
      );

      return result;
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError("PROCESS_SPAWN_FAILED", (error as Error).message);

      this.recordAudit(
        "execute",
        context,
        "error",
        {
          command: params.command ?? params.executable,
          error: err.message,
        },
        { durationMs: Date.now() - startTime, error: { code: err.code, message: err.message } },
      );

      throw err;
    }
  }

  /**
   * Spawns subprocess with output size caps, timeout handling, and process-tree termination.
   */
  private spawnSubprocess(options: {
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin?: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }): Promise<CommandExecuteResult> {
    const { promise, resolve, reject } = withResolvers<CommandExecuteResult>();
    const startTime = Date.now();

    const isPosix = process.platform !== "win32";
    let child: ChildProcess;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false, // Strict: never invoke through shell
        detached: isPosix, // Enable process group on POSIX for clean termination
      });
    } catch (spawnErr) {
      reject(
        new BrokerSecurityError(
          "PROCESS_SPAWN_FAILED",
          `Failed to spawn executable: ${(spawnErr as Error).message}`,
        ),
      );
      return promise;
    }
    let stdoutData = "";
    let stderrData = "";
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
    let totalBytes = 0;
    let timedOut = false;
    let killedForSize = false;

    // Helper to terminate entire process tree
    const killTree = (sig: NodeJS.Signals = "SIGKILL") => {
      try {
        if (isPosix && child.pid) {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {}
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGKILL");
      reject(
        new BrokerSecurityError(
          "COMMAND_TIMEOUT",
          `Command execution timed out after ${options.timeoutMs}ms`,
          { timeoutMs: options.timeoutMs },
        ),
      );
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > options.maxOutputBytes) {
        killedForSize = true;
        killTree("SIGKILL");
        clearTimeout(timer);
        reject(
          new BrokerSecurityError(
            "MAX_OUTPUT_EXCEEDED",
            `Command output size ${totalBytes} bytes exceeded maximum limit ${options.maxOutputBytes} bytes`,
            { totalBytes, maxBytes: options.maxOutputBytes },
          ),
        );
        return;
      }
      stdoutData += chunk.toString("utf-8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > options.maxOutputBytes) {
        killedForSize = true;
        killTree("SIGKILL");
        clearTimeout(timer);
        reject(
          new BrokerSecurityError(
            "MAX_OUTPUT_EXCEEDED",
            `Command output size ${totalBytes} bytes exceeded maximum limit ${options.maxOutputBytes} bytes`,
            { totalBytes, maxBytes: options.maxOutputBytes },
          ),
        );
        return;
      }
      stderrData += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!timedOut && !killedForSize) {
        reject(
          new BrokerSecurityError("PROCESS_SPAWN_FAILED", `Child process error: ${err.message}`),
        );
      }
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut || killedForSize) return;

      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: code ?? (signal ? 128 + 9 : 0),
        stdout: stdoutData,
        stderr: stderrData,
        durationMs,
      });
    });

    return promise;
  }

  /**
   * Alias for execute.
   */
  async exec(
    command: string,
    args: string[],
    options: Omit<CommandExecuteParams, "command" | "args">,
    context: BrokerContext,
  ): Promise<CommandExecuteResult> {
    return this.execute({ ...options, command, args }, context);
  }
}
