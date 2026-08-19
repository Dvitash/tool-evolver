import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CommandCapability,
  type SecretReference,
  isSecretReference,
} from "@tool-evolver/contracts";
import {
  type CommandIdentity,
  containsForbiddenArgMetacharacters,
  containsShellMetacharacters,
  isDangerousEnvVar,
  isDangerousOption,
  isInterpreterEscapeArg,
  isPathInsideRoot,
  isResponseFileEscape,
  isShellExecutable,
  matchesArgPattern,
  normalizeSlashes,
  resolveCanonicalBinary,
  verifyExecutableIdentity,
} from "../policy/canonicalizers.js";
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
 * Broker that securely handles subprocess execution and command delegation.
 * Enforces canonical binary path resolution, immutable executable identity verification,
 * shell restriction, argument vector validation, and strict child environment sanitization.
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
    identity: CommandIdentity;
    executable: string;
    args: string[];
    cwd: string;
    childEnv: NodeJS.ProcessEnv;
  } {
    // 1. Extract raw binary and validate string
    const rawBinary = params.executable ?? params.command?.trim().split(/\s+/)[0];
    if (!rawBinary || typeof rawBinary !== "string" || rawBinary.trim().length === 0) {
      throw new BrokerSecurityError("INVALID_PATH", "Executable binary name must be specified");
    }
    const binary = rawBinary.trim();

    // 2. Shell execution restriction
    if (cmdCap.allowShellExecution === false) {
      if (params.command && !params.executable) {
        const parts = params.command.trim().split(/\s+/);
        if (parts.length > 1 && !(cmdCap.allowedBinaries ?? []).includes(parts[0])) {
          throw new BrokerSecurityError(
            "SHELL_EXECUTION_DENIED",
            "Arbitrary shell commands are prohibited; specify an authorized executable and explicit args array",
            { command: params.command },
          );
        }
      }
      if (isShellExecutable(binary)) {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          `Shell execution is prohibited by capability grant: ${path.basename(binary)}`,
          { binary },
        );
      }
    }

    // 3. Binary resolution to canonical absolute path and identity
    const workspaceRoot = path.resolve(context.workspaceRoot ?? process.cwd());
    const scratchDir = path.resolve(
      context.scratchDir ?? path.join(os.tmpdir(), "tool_evolver_scratch"),
    );

    let identity: CommandIdentity;
    try {
      identity = resolveCanonicalBinary(binary, {
        workspaceRoot,
        allowNonExistent: false,
        computeDigest: true,
      });
    } catch (err) {
      throw new BrokerSecurityError(
        "UNAUTHORIZED_BINARY",
        `Binary '${binary}' could not be resolved or is invalid: ${(err as Error).message}`,
        { binary },
      );
    }

    if (cmdCap.allowShellExecution === false) {
      if (isShellExecutable(identity.realPath) || isShellExecutable(identity.canonicalPath)) {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          `Resolved executable '${identity.realPath}' is a shell executable and shell execution is disabled`,
          { binary, realPath: identity.realPath },
        );
      }
    }

    // 4. Validate against canonical approved executable identities.
    const allowedBinaries = cmdCap.allowedBinaries ?? [];
    const allowedCommands = cmdCap.allowedCommands ?? [];
    if (allowedBinaries.length > 0) {
      const resolvedAllowed = allowedBinaries.map((allowed) => {
        try {
          return resolveCanonicalBinary(allowed, { workspaceRoot, allowNonExistent: true });
        } catch {
          return {
            canonicalPath: path.resolve(allowed),
            realPath: path.resolve(allowed),
          };
        }
      });

      const isAllowed = resolvedAllowed.some((allowedId) => {
        if (allowedId.realPath === identity.realPath) return true;
        if (allowedId.canonicalPath === identity.canonicalPath) return true;
        return false;
      });

      if (!isAllowed) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_BINARY",
          `Binary '${binary}' (${identity.realPath}) is not permitted by capability grant (allowed: ${allowedBinaries.join(", ")})`,
          { binary, realPath: identity.realPath, allowedBinaries },
        );
      }
    } else if (allowedCommands.length > 0) {
      const allowedCommandIdentities = allowedCommands.map((commandProfile) => {
        const allowedBinary = commandProfile.trim().split(/\s+/)[0];
        try {
          return resolveCanonicalBinary(allowedBinary, {
            workspaceRoot,
            allowNonExistent: false,
            computeDigest: true,
          });
        } catch (error) {
          throw new BrokerSecurityError(
            "UNAUTHORIZED_BINARY",
            `Configured allowed command '${commandProfile}' could not be resolved: ${(error as Error).message}`,
            { commandProfile },
          );
        }
      });
      const isAllowedCommandIdentity = allowedCommandIdentities.some(
        (allowedIdentity) =>
          allowedIdentity.realPath === identity.realPath &&
          allowedIdentity.canonicalPath === identity.canonicalPath,
      );
      if (!isAllowedCommandIdentity) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_BINARY",
          `Binary '${binary}' (${identity.realPath}) is not permitted by allowedCommands`,
          { binary, realPath: identity.realPath, allowedCommands },
        );
      }
    } else {
      throw new BrokerSecurityError(
        "UNAUTHORIZED_BINARY",
        `Binary '${binary}' is not permitted (no canonical command identity configured)`,
        { binary },
      );
    }

    // 5. Validate arguments
    const rawArgs: string[] = params.args
      ? [...params.args]
      : params.command
        ? params.command.trim().split(/\s+/).slice(1)
        : [];

    for (let i = 0; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (typeof arg !== "string") {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          "All command arguments must be strings",
        );
      }

      if (containsForbiddenArgMetacharacters(arg)) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          `Argument contains forbidden shell metacharacters or control bytes: '${arg}'`,
          { arg },
        );
      }

      if (isInterpreterEscapeArg(identity.realPath, arg, rawArgs[i + 1])) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          `Interpreter escape flag '${arg}' is prohibited for binary '${path.basename(identity.realPath)}'`,
          { binary: identity.realPath, arg },
        );
      }

      if (isDangerousOption(identity.realPath, arg)) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          `Dangerous option '${arg}' is prohibited for binary '${path.basename(identity.realPath)}'`,
          { binary: identity.realPath, arg },
        );
      }

      if (isResponseFileEscape(arg, workspaceRoot)) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          `Response file argument '${arg}' escapes authorized workspace boundaries`,
          { arg },
        );
      }

      for (const pattern of cmdCap.forbiddenPatterns ?? []) {
        if (matchesArgPattern(arg, pattern) || arg.includes(pattern)) {
          throw new BrokerSecurityError(
            "FORBIDDEN_PATTERN",
            `Command argument '${arg}' matches forbidden pattern '${pattern}'`,
            { arg, pattern },
          );
        }
      }
    }

    // 6. Validate working directory boundaries
    const targetCwd = params.cwd ? path.resolve(workspaceRoot, params.cwd) : workspaceRoot;
    const inWorkspace = isPathInsideRoot(targetCwd, workspaceRoot);
    const inScratch = isPathInsideRoot(targetCwd, scratchDir);

    if (!inWorkspace && !inScratch) {
      throw new BrokerSecurityError(
        "WORKING_DIRECTORY_DENIED",
        `Working directory '${params.cwd}' resolves outside allowed roots (${workspaceRoot}): ${targetCwd}`,
        { cwd: params.cwd, resolvedCwd: targetCwd, workspaceRoot },
      );
    }

    if (!fs.existsSync(targetCwd) || !fs.statSync(targetCwd).isDirectory()) {
      throw new BrokerSecurityError(
        "FILE_NOT_FOUND",
        `Working directory does not exist or is not a directory: ${targetCwd}`,
        { cwd: targetCwd },
      );
    }

    // 7. Construct minimal sanitized child environment
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TMPDIR: scratchDir,
      HOME: workspaceRoot,
    };

    if (process.platform === "win32") {
      if (process.env.SYSTEMROOT) childEnv.SYSTEMROOT = process.env.SYSTEMROOT;
      if (process.env.WINDIR) childEnv.WINDIR = process.env.WINDIR;
      if (process.env.COMSPEC) childEnv.COMSPEC = process.env.COMSPEC;
      if (process.env.PATHEXT) childEnv.PATHEXT = process.env.PATHEXT;
    }

    const passthroughKeys = cmdCap.allowEnvPassthrough ?? [];
    for (const key of passthroughKeys) {
      if (!isDangerousEnvVar(key) && process.env[key] !== undefined) {
        childEnv[key] = process.env[key];
      }
    }

    if (params.env) {
      const secretsCap = context.grant?.capabilities?.secrets;
      const allowedSecretNames = secretsCap?.allowedSecretNames ?? [];
      const allowedPrefixes = secretsCap?.allowedPrefixes ?? [];
      const hasSecretsCapability = allowedSecretNames.length > 0 || allowedPrefixes.length > 0;

      for (const [key, val] of Object.entries(params.env)) {
        if (isDangerousEnvVar(key)) {
          throw new BrokerSecurityError(
            "DANGEROUS_ENV_VAR",
            `Dangerous environment variable '${key}' cannot be provided by caller`,
            { envVar: key },
          );
        }

        if (isSecretReference(val)) {
          continue;
        }

        const isAllowedPassthrough = passthroughKeys.includes(key);
        const isAllowedSecret =
          allowedSecretNames.includes(key) || allowedPrefixes.some((p) => key.startsWith(p));
        if (!isAllowedPassthrough && !isAllowedSecret) {
          throw new BrokerSecurityError(
            "UNAUTHORIZED_ENV_VAR",
            `Environment variable '${key}' is not authorized in capability grant (allowed: ${passthroughKeys.join(", ")})`,
            { envVar: key, allowEnvPassthrough: passthroughKeys },
          );
        }

        if (typeof val === "string") {
          childEnv[key] = val;
        }
      }
    }

    return {
      identity,
      executable: identity.realPath,
      args: rawArgs,
      cwd: targetCwd,
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
      const { identity, executable, args, cwd, childEnv } = this.authorizeExecution(
        params,
        context,
        cmdCap,
      );

      // Pre-spawn executable identity re-verification (detects symlink swaps / replacements)
      const verifyResult = verifyExecutableIdentity(identity);
      if (!verifyResult.valid) {
        throw new BrokerSecurityError(
          "COMMAND_IDENTITY_VIOLATION",
          `Executable identity verification failed before spawn: ${verifyResult.reason}`,
          { executable: identity.realPath, reason: verifyResult.reason },
        );
      }

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

      if (Object.keys(rawEnv).length > 0 && secretBroker) {
        const mediatedEnv = await secretBroker.mediateCommandEnv(rawEnv, context);
        for (const [key, val] of Object.entries(mediatedEnv)) {
          if (!isDangerousEnvVar(key)) {
            childEnv[key] = val;
          }
        }
      }

      // 3. Subprocess execution with process group termination and timeout protection
      const rawResult = await this.spawnSubprocess({
        executable,
        args,
        cwd,
        env: childEnv,
        stdin: resolvedStdin,
        timeoutMs,
        maxOutputBytes,
      });

      // 4. Output Redaction
      const sanitizedStdout = redactor ? redactor.redact(rawResult.stdout) : rawResult.stdout;
      const sanitizedStderr = redactor ? redactor.redact(rawResult.stderr) : rawResult.stderr;

      // 5. Emit Audit Event
      this.recordAudit(
        "execute",
        context,
        rawResult.exitCode === 0 ? "allowed" : "denied",
        {
          command: executable,
          args: redactor ? args.map((a) => redactor.redact(a)) : args,
          cwd,
          exitCode: rawResult.exitCode,
        },
        { durationMs: rawResult.durationMs },
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
      const errMsg = (error as Error).message;

      this.recordAudit(
        "execute",
        context,
        "denied",
        {
          command: params.executable ?? params.command ?? "unknown",
          params:
            redactor && params.args
              ? { ...params, args: params.args.map((a) => redactor.redact(a)) }
              : params,
        },
        {
          error: {
            code: errCode,
            message: errMsg,
            details:
              redactor && isSecErr && error.details
                ? redactor.redactObject(error.details)
                : undefined,
          },
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
          { executable: options.executable, error: (err as Error).message },
        ),
      );
      return promise;
    }

    const killProcessGroup = (signal: NodeJS.Signals = "SIGKILL") => {
      if (child.killed) return;
      if (isPosix && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // already exited
          }
        }
      } else {
        try {
          child.kill(signal);
        } catch {
          // already exited
        }
      }
    };

    let stdoutData = "";
    let stderrData = "";
    let totalBytes = 0;
    let timedOut = false;
    let killedForSize = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        killProcessGroup("SIGKILL");
      }, 50);
    }, options.timeoutMs);

    if (options.stdin && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const str = chunk.toString();
      totalBytes += Buffer.byteLength(str);
      if (totalBytes > options.maxOutputBytes) {
        killedForSize = true;
        killProcessGroup("SIGKILL");
        return;
      }
      stdoutData += str;
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const str = chunk.toString();
      totalBytes += Buffer.byteLength(str);
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
          { error: err.message },
        ),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new BrokerSecurityError(
            "COMMAND_TIMEOUT",
            `Command execution timed out after ${options.timeoutMs}ms`,
            { timeoutMs: options.timeoutMs, signal },
          ),
        );
        return;
      }

      if (killedForSize) {
        reject(
          new BrokerSecurityError(
            "MAX_OUTPUT_EXCEEDED",
            `Subprocess output exceeded quota limit of ${options.maxOutputBytes} bytes`,
            { maxOutputBytes: options.maxOutputBytes },
          ),
        );
        return;
      }

      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout: stdoutData,
        stderr: stderrData,
        durationMs: Date.now() - startTime,
      });
    });

    return promise;
  }

  /**
   * Convenience alias for executing commands.
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
