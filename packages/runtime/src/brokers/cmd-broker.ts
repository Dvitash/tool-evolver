import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CommandCapability,
  type SecretReference,
  isSecretReference,
} from "@tool-evolver/contracts";
import { isPathInsideRoot, normalizeSlashes } from "../policy/canonicalizers.js";
import { withResolvers } from "../worker/protocol.js";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";
import type { SecretBroker } from "./secret-broker.js";

/**
 * Standard parameters for brokered command execution.
 */
export interface CommandExecuteParams {
  command?: string;
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | SecretReference>;
  stdin?: string | SecretReference;
  timeoutMs?: number;
  maxOutputSizeBytes?: number;
  secretEnv?: Record<string, SecretReference | string>;
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
 * Options for configuring CommandBroker.
 */
export interface CommandBrokerOptions extends BaseCapabilityBrokerOptions {
  secretBroker?: SecretBroker;
}

/**
 * Dangerous shell metacharacters and control flow operators forbidden in binary arguments.
 */
const FORBIDDEN_SHELL_PATTERNS = [
  /`/, // Command substitution
  /\$\(/, // Command substitution
  /\$\{/, // Variable expansion
  /\|\|/, // Conditional OR
  /&&/, // Conditional AND
  /[;|<>&]/, // Redirections and pipes
  /\n|\r/, // Line breaks / multiline injections
];

/**
 * Capability broker for authorized subprocess execution.
 * Enforces binary allowlists, argument sanitization (preventing shell injection),
 * strict working directory isolation inside workspace/scratch boundaries,
 * environment isolation, timeout enforcement, output size quotas, and non-disclosure secret mediation.
 */
export class CommandBroker extends BaseCapabilityBroker {
  readonly serviceName = "cmd" as const;
  private secretBroker?: SecretBroker;

  constructor(options: CommandBrokerOptions = {}) {
    super(options);
    this.secretBroker = options.secretBroker;
  }

  /**
   * Sets or updates the secret broker for credential mediation.
   */
  setSecretBroker(broker: SecretBroker): void {
    this.secretBroker = broker;
  }

  /**
   * Validates and resolves an authorized command executable, working directory, and environment.
   */
  private authorizeExecution(
    params: CommandExecuteParams,
    context: BrokerContext,
    cmdCap: CommandCapability,
  ): {
    executable: string;
    args: string[];
    cwd: string;
    childEnv: NodeJS.ProcessEnv;
  } {
    // 1. Shell execution restriction
    const SHELL_BINARIES = [
      "sh",
      "bash",
      "zsh",
      "csh",
      "ksh",
      "dash",
      "cmd.exe",
      "cmd",
      "powershell.exe",
      "powershell",
      "pwsh",
    ];

    if (cmdCap.allowShellExecution === false && params.command && !params.executable) {
      const parts = params.command.trim().split(/\s+/);
      if (parts.length > 1 && !cmdCap.allowedBinaries.includes(parts[0])) {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          "Arbitrary shell commands are prohibited; specify an authorized executable and explicit args array",
          { command: params.command },
        );
      }
    }
    // 2. Binary resolution
    const binary = params.executable ?? params.command?.trim().split(/\s+/)[0];
    if (!binary) {
      throw new BrokerSecurityError("INVALID_PATH", "Executable binary name must be specified");
    }

    const binaryName = path.basename(binary);
    if (cmdCap.allowShellExecution === false && SHELL_BINARIES.includes(binaryName)) {
      throw new BrokerSecurityError(
        "SHELL_EXECUTION_DENIED",
        `Shell execution is prohibited by capability grant: ${binaryName}`,
        { binary: binaryName },
      );
    }

    const allowedBinaries = cmdCap.allowedBinaries ?? [];

    if (allowedBinaries.length > 0) {
      const isAllowed = allowedBinaries.some((allowed) => {
        if (allowed === binaryName) return true;
        if (path.resolve(allowed) === path.resolve(binary)) return true;
        return false;
      });

      if (!isAllowed) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_BINARY",
          `Binary '${binaryName}' is not permitted by capability grant (allowed: ${allowedBinaries.join(", ")})`,
          { binary: binaryName, allowedBinaries },
        );
      }
    }

    // 3. Arguments resolution & shell metacharacter defense
    let args: string[] = [];
    if (params.args && Array.isArray(params.args)) {
      args = [...params.args];
    } else if (params.command && !params.executable) {
      const parts = params.command.trim().split(/\s+/);
      args = parts.slice(1);
    }
    // Check built-in forbidden shell metacharacters
    if (cmdCap.allowShellExecution === false) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        for (const regex of FORBIDDEN_SHELL_PATTERNS) {
          if (regex.test(arg)) {
            throw new BrokerSecurityError(
              "SHELL_EXECUTION_DENIED",
              `Argument at index ${i} contains forbidden shell pattern: '${arg}'`,
              { argumentIndex: i, pattern: regex.source },
            );
          }
        }
      }
    }

    // Check capability grant forbidden patterns
    if (cmdCap.forbiddenPatterns) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        for (const pat of cmdCap.forbiddenPatterns) {
          const regex = new RegExp(pat);
          if (regex.test(arg)) {
            throw new BrokerSecurityError(
              "FORBIDDEN_PATTERN",
              `Argument at index ${i} matches forbidden pattern: '${arg}'`,
              { argumentIndex: i, pattern: pat },
            );
          }
        }
      }
    }
    // 4. Working Directory Resolution & Sandbox Boundary
    const workspaceRoot = context.workspaceRoot ?? process.cwd();
    const scratchDir = context.scratchDir ?? os.tmpdir();

    let resolvedCwd = workspaceRoot;
    if (params.cwd) {
      const targetCwd = path.resolve(workspaceRoot, params.cwd);
      const inWorkspace = isPathInsideRoot(targetCwd, workspaceRoot);
      const inScratch = isPathInsideRoot(targetCwd, scratchDir);

      if (!inWorkspace && !inScratch) {
        throw new BrokerSecurityError(
          "WORKING_DIRECTORY_DENIED",
          `Working directory '${normalizeSlashes(targetCwd)}' is outside allowed workspace/scratch roots`,
          { cwd: targetCwd, workspaceRoot, scratchDir },
        );
      }

      if (!fs.existsSync(targetCwd) || !fs.statSync(targetCwd).isDirectory()) {
        throw new BrokerSecurityError(
          "FILE_NOT_FOUND",
          `Working directory does not exist or is not a directory: ${targetCwd}`,
          { cwd: targetCwd },
        );
      }

      resolvedCwd = targetCwd;
    }

    // 5. Base Environment Isolation
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

    return {
      executable: binary,
      args,
      cwd: resolvedCwd,
      childEnv,
    };
  }

  /**
   * Executes an authorized subprocess with output limits, timeout bounds, and mediated credentials.
   */
  async execute(
    params: CommandExecuteParams,
    context: BrokerContext,
  ): Promise<CommandExecuteResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const cmdCap = grant.capabilities.command ?? {};
    const limits = grant.capabilities.limits;

    const timeoutMs = Math.min(
      params.timeoutMs ?? limits?.maxExecutionTimeMs ?? 30000,
      limits?.maxExecutionTimeMs ?? 30000,
    );
    const maxOutputBytes = limits?.maxOutputSizeBytes ?? 10485760; // 10MB default

    const secretBroker = this.secretBroker ?? (context.secretBroker as SecretBroker | undefined);
    const redactor = secretBroker?.getRedactor();

    try {
      const { executable, args, cwd, childEnv } = this.authorizeExecution(params, context, cmdCap);

      // 1. Host-side stdin secret mediation
      let resolvedStdin: string | undefined = undefined;
      if (params.stdin !== undefined) {
        if (secretBroker) {
          resolvedStdin = await secretBroker.mediateCommandStdin(params.stdin, context);
        } else if (typeof params.stdin === "string") {
          resolvedStdin = params.stdin;
        }
      }

      // 2. Host-side environment secret mediation
      const rawEnv: Record<string, string | SecretReference> = {
        ...(params.env ?? {}),
        ...(params.secretEnv ?? {}),
      };

      if (secretBroker) {
        const mediatedEnv = await secretBroker.mediateCommandEnv(rawEnv, context);
        for (const [key, val] of Object.entries(mediatedEnv)) {
          // Exclude dangerous loader overrides
          if (
            key.startsWith("LD_") ||
            key.startsWith("DYLD_") ||
            key === "NODE_OPTIONS" ||
            key === "PYTHONWARNINGS"
          ) {
            continue;
          }
          childEnv[key] = val;
        }
      } else {
        for (const [key, val] of Object.entries(rawEnv)) {
          if (
            key.startsWith("LD_") ||
            key.startsWith("DYLD_") ||
            key === "NODE_OPTIONS" ||
            key === "PYTHONWARNINGS"
          ) {
            continue;
          }
          if (typeof val === "string") {
            childEnv[key] = val;
          }
        }
      }

      // 3. Execute subprocess
      const rawResult = await this.spawnSubprocess({
        executable,
        args,
        cwd,
        env: childEnv,
        stdin: resolvedStdin,
        timeoutMs,
        maxOutputBytes,
      });

      // 4. Output Redaction & Sanitization
      const sanitizedStdout = redactor ? redactor.redact(rawResult.stdout) : rawResult.stdout;
      const sanitizedStderr = redactor ? redactor.redact(rawResult.stderr) : rawResult.stderr;
      const totalBytes =
        Buffer.byteLength(sanitizedStdout, "utf-8") + Buffer.byteLength(sanitizedStderr, "utf-8");
      this.trackOutputBytes(context.invocationId, totalBytes, limits);
      this.recordAudit(
        "execute",
        context,
        rawResult.exitCode === 0 ? "allowed" : "error",
        {
          executable: path.basename(executable),
          argsCount: args.length,
          exitCode: rawResult.exitCode,
          outputBytes: totalBytes,
        },
        { durationMs: Date.now() - startTime },
      );

      return {
        exitCode: rawResult.exitCode,
        stdout: sanitizedStdout,
        stderr: sanitizedStderr,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const isSecErr = error instanceof BrokerSecurityError;
      const errCode = isSecErr ? error.code : "PROCESS_SPAWN_FAILED";
      const rawErrMsg = (error as Error).message;
      const errMsg = redactor ? redactor.redact(rawErrMsg) : rawErrMsg;

      this.recordAudit(
        "execute",
        context,
        "denied",
        {
          executable: params.executable ?? params.command,
          reason: errMsg,
        },
        {
          error: { code: errCode, message: errMsg },
          durationMs: Date.now() - startTime,
        },
      );

      if (isSecErr) {
        throw new BrokerSecurityError(
          error.code,
          errMsg,
          redactor && error.details ? redactor.redactObject(error.details) : error.details,
        );
      }
      throw new BrokerSecurityError("PROCESS_SPAWN_FAILED", errMsg);
    }
  }

  /**
   * Spawns a child process and collects standard output and error streams with timeout protection.
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
        stdio: ["pipe", "pipe", "pipe"],
        detached: isPosix, // Enable process group killing on POSIX
      });
    } catch (err) {
      reject(
        new BrokerSecurityError(
          "PROCESS_SPAWN_FAILED",
          `Failed to spawn binary '${options.executable}': ${(err as Error).message}`,
          { executable: options.executable },
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

    let timedOut = false;
    let killedForSize = false;
    let totalBytes = 0;

    const killProcessGroup = (signal: NodeJS.Signals = "SIGKILL") => {
      try {
        if (isPosix && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Process might already be dead
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          killProcessGroup("SIGKILL");
        }
      }, 2000).unref();
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const str = chunk.toString("utf-8");
      totalBytes += Buffer.byteLength(str, "utf-8");
      if (totalBytes > options.maxOutputBytes) {
        killedForSize = true;
        killProcessGroup("SIGKILL");
        return;
      }
      stdoutData += str;
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const str = chunk.toString("utf-8");
      totalBytes += Buffer.byteLength(str, "utf-8");
      if (totalBytes > options.maxOutputBytes) {
        killedForSize = true;
        killProcessGroup("SIGKILL");
        return;
      }
      stderrData += str;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new BrokerSecurityError(
          "PROCESS_SPAWN_FAILED",
          `Child process emitted error: ${err.message}`,
          { executable: options.executable },
        ),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new BrokerSecurityError(
            "COMMAND_TIMEOUT",
            `Command execution exceeded timeout limit of ${options.timeoutMs}ms`,
            { timeoutMs: options.timeoutMs, executable: options.executable },
          ),
        );
        return;
      }

      if (killedForSize) {
        reject(
          new BrokerSecurityError(
            "MAX_OUTPUT_EXCEEDED",
            `Subprocess output exceeded quota limit of ${options.maxOutputBytes} bytes`,
            { maxOutputBytes: options.maxOutputBytes, bytesReceived: totalBytes },
          ),
        );
        return;
      }

      const exitCode = code !== null ? code : signal ? 128 : 1;
      resolve({
        exitCode,
        stdout: stdoutData,
        stderr: stderrData,
        durationMs: Date.now() - startTime,
      });
    });

    return promise;
  }

  /**
   * Convenience execution method matching typical shell exec signatures.
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
