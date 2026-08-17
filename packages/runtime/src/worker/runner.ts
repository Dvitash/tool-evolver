import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { type ToolManifest, ToolManifestSchema } from "@tool-evolver/contracts";
import {
  type ErrorMessage,
  type LogMessage,
  type ProgressMessage,
  createLogMessage,
  createProgressMessage,
  withResolvers,
} from "./protocol.js";
import {
  type BrokerRequestHandlerFn,
  type ToolContext,
  createToolContext,
  defineTool,
} from "./sdk.js";
import { validateAgainstSchema } from "./bootstrap.js";
import { WorkerProcess } from "./process.js";

/**
 * Tool execution modes.
 */
export type ExecutionMode = "auto" | "deno" | "in-process" | "sandbox-vm";

/**
 * Options for executing a tool via ToolRuntime.
 */
export interface ToolExecutionOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxOutputSizeBytes?: number;
  mode?: ExecutionMode;
  denoExecutable?: string;
  brokerHandler?: BrokerRequestHandlerFn;
  onProgress?: (progress: ProgressMessage) => void;
  onLog?: (log: LogMessage) => void;
  environment?: Record<string, string>;
  workspaceRoot?: string;
  sessionId?: string;
  workspaceId?: string;
  allowDirectHostAccess?: boolean;
}

/**
 * Structured invocation result returned by ToolRuntime.
 */
export interface InvocationResult {
  status: "success" | "error" | "timeout" | "cancelled" | "validation_error";
  output?: unknown;
  error?: {
    type: string;
    message: string;
    stack?: string;
    details?: unknown;
  };
  durationMs: number;
  resourceUsage?: {
    cpuTimeMs?: number;
    memoryBytes?: number;
  };
  logs: LogMessage[];
  progress: ProgressMessage[];
}

/**
 * Checks whether Deno binary is installed and executable in PATH.
 */
export function isDenoAvailable(denoExecutable = "deno"): boolean {
  try {
    const res = spawnSync(denoExecutable, ["--version"], {
      stdio: "ignore",
      timeout: 1000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Deterministic In-Memory Worker Sandbox.
 * Provides strict sandbox isolation and deterministic tool execution in-process.
 */
export class DeterministicWorkerSandbox {
  /**
   * Executes a tool handler or bundle entrypoint in an isolated, permissionless context.
   */
  static async execute(
    manifest: ToolManifest | Record<string, unknown>,
    bundleOrHandler: string | ((ctx: ToolContext) => unknown | Promise<unknown>),
    input: unknown,
    options: ToolExecutionOptions = {}
  ): Promise<InvocationResult> {
    const startTime = Date.now();
    const invocationId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const manifestLimits =
      manifest && typeof manifest === "object" && "limits" in manifest && manifest.limits && typeof manifest.limits === "object"
        ? (manifest.limits as Record<string, unknown>)
        : {};
    const timeoutMs = options.timeoutMs ?? (typeof manifestLimits.timeoutMs === "number" ? manifestLimits.timeoutMs : 30000);
    const logs: LogMessage[] = [];
    const progressList: ProgressMessage[] = [];

    // Create unique scratch directory
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "te-sandbox-"));

    const onLog = (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => {
      const msg = createLogMessage({ invocationId, level, message, data });
      logs.push(msg);
      options.onLog?.(msg);
    };

    const onProgress = (percentage: number, message?: string, stage?: string) => {
      const msg = createProgressMessage({ invocationId, percentage, message, stage });
      progressList.push(msg);
      options.onProgress?.(msg);
    };

    try {
      // 1. Validate input against manifest parameters schema
      if (manifest.parameters) {
        const inputValidation = validateAgainstSchema(manifest.parameters, input, "input");
        if (!inputValidation.valid) {
          return {
            status: "validation_error",
            error: {
              type: "validation_error",
              message: `Input validation failed: ${inputValidation.errors.join("; ")}`,
              details: { errors: inputValidation.errors },
            },
            durationMs: Date.now() - startTime,
            logs,
            progress: progressList,
          };
        }
      }

      // 2. Set up context
      const defaultBrokerHandler: BrokerRequestHandlerFn = options.brokerHandler ?? (async () => {
        throw new Error("No broker handler configured for sandbox");
      });

      const toolContext = createToolContext({
        input,
        invocationId,
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
        scratchDir,
        metadata: {
          sessionId: options.sessionId,
          workspaceId: options.workspaceId,
        },
        onLog,
        onProgress,
        brokerHandler: defaultBrokerHandler,
      });

      // 3. Resolve tool handler
      let handler: (ctx: ToolContext) => unknown | Promise<unknown>;

      if (typeof bundleOrHandler === "function") {
        handler = bundleOrHandler;
      } else {
        const bundlePath = bundleOrHandler;
        let fileContent: string;
        if (fs.existsSync(bundlePath)) {
          const stat = fs.statSync(bundlePath);
          if (stat.isDirectory()) {
            const entryTs = path.join(bundlePath, "src/index.ts");
            const entryJs = path.join(bundlePath, "src/index.js");
            const entryDirect = path.join(bundlePath, "index.js");
            const target = fs.existsSync(entryTs)
              ? entryTs
              : fs.existsSync(entryJs)
              ? entryJs
              : fs.existsSync(entryDirect)
              ? entryDirect
              : null;
            if (!target) {
              throw new Error(`Cannot find entrypoint in bundle directory: ${bundlePath}`);
            }
            fileContent = fs.readFileSync(target, "utf-8");
          } else {
            fileContent = fs.readFileSync(bundlePath, "utf-8");
          }
        } else {
          fileContent = bundlePath; // treated as inline code
        }

        // Execute inside permissionless VM sandbox context
        handler = DeterministicWorkerSandbox.compileSandboxedHandler(fileContent, options);
      }

      // 4. Run handler with timeout
      const { promise: execPromise, resolve: execResolve, reject: execReject } = withResolvers<unknown>();

      const timer = setTimeout(() => {
        execReject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      Promise.resolve()
        .then(() => handler(toolContext))
        .then(
          (res) => {
            clearTimeout(timer);
            execResolve(res);
          },
          (err) => {
            clearTimeout(timer);
            execReject(err);
          }
        );

      let rawOutput: unknown;
      try {
        rawOutput = await execPromise;
      } catch (runErr) {
        const isTimeout = runErr instanceof Error && runErr.message.includes("timed out");
        return {
          status: isTimeout ? "timeout" : "error",
          error: {
            type: isTimeout ? "timeout" : "execution_error",
            message: runErr instanceof Error ? runErr.message : String(runErr),
            stack: runErr instanceof Error ? runErr.stack : undefined,
          },
          durationMs: Date.now() - startTime,
          logs,
          progress: progressList,
        };
      }

      // 5. Validate output against outputSchema
      if (manifest.outputSchema) {
        const outputValidation = validateAgainstSchema(manifest.outputSchema, rawOutput, "output");
        if (!outputValidation.valid) {
          return {
            status: "validation_error",
            error: {
              type: "validation_error",
              message: `Output validation failed: ${outputValidation.errors.join("; ")}`,
              details: { errors: outputValidation.errors },
            },
            durationMs: Date.now() - startTime,
            logs,
            progress: progressList,
          };
        }
      }

      return {
        status: "success",
        output: rawOutput,
        durationMs: Date.now() - startTime,
        resourceUsage: {
          cpuTimeMs: Date.now() - startTime,
          memoryBytes: process.memoryUsage().heapUsed,
        },
        logs,
        progress: progressList,
      };
    } finally {
      // Scratch directory cleanup
      try {
        if (fs.existsSync(scratchDir)) {
          fs.rmSync(scratchDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup error
      }
    }
  }

  /**
   * Compiles code inside a Node VM context with ambient access denied.
   */
  private static compileSandboxedHandler(
    code: string,
    options: ToolExecutionOptions
  ): (ctx: ToolContext) => unknown | Promise<unknown> {
    const sandboxExports: Record<string, unknown> = {};
    const sandboxModule = { exports: sandboxExports };

    // Strict permissionless sandbox environment
    const sandboxGlobals: Record<string, unknown> = {
      module: sandboxModule,
      exports: sandboxExports,
      console: {
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      Buffer: undefined, // Disallowed unless authorized
      // Direct host access denials:
      process: {
        env: {},
        cwd: () => "/",
        version: "sandbox-1.0.0",
        exit: () => {
          throw new Error("Permission Denied: process.exit is not allowed in sandbox");
        },
      },
      require: (moduleName: string) => {
        throw new Error(
          `Permission Denied: direct require('${moduleName}') is not allowed in sandbox. Use context.broker instead.`
        );
      },
      fetch: () => {
        throw new Error(
          "Permission Denied: direct fetch() is not allowed in permissionless sandbox. Use context.broker.net.fetch instead."
        );
      },
    };

    // If direct host access is explicitly enabled (e.g. for testing)
    if (options.allowDirectHostAccess) {
      sandboxGlobals.Buffer = Buffer;
      sandboxGlobals.fetch = globalThis.fetch;
    }

    const context = vm.createContext(sandboxGlobals);

    // Transform simple export patterns if CommonJS/ESM
    let runnableCode = code;
    if (code.includes("export default") || code.includes("export const")) {
      runnableCode = code
        .replace(/export\s+default\s+/g, "module.exports = ")
        .replace(/export\s+const\s+(\w+)\s*=/g, "exports.$1 =");
    }

    try {
      vm.runInContext(runnableCode, context, {
        timeout: options.timeoutMs ?? 30000,
      });
    } catch (compileErr) {
      throw new Error(`Failed to execute sandboxed tool script: ${compileErr instanceof Error ? compileErr.message : String(compileErr)}`);
    }

    const exported = sandboxModule.exports;
    const handler =
      typeof exported === "function"
        ? exported
        : typeof (exported as Record<string, unknown>).default === "function"
        ? (exported as Record<string, unknown>).default
        : typeof (exported as Record<string, unknown>).execute === "function"
        ? (exported as Record<string, unknown>).execute
        : typeof (exported as Record<string, unknown>).run === "function"
        ? (exported as Record<string, unknown>).run
        : typeof (exported as Record<string, unknown>).handler === "function"
        ? (exported as Record<string, unknown>).handler
        : null;

    if (!handler || typeof handler !== "function") {
      throw new Error("Sandboxed code does not export a callable tool handler");
    }

    return handler as (ctx: ToolContext) => unknown | Promise<unknown>;
  }
}

/**
 * ToolRuntime: Primary interface for executing generated tools in isolated sandboxes.
 */
export class ToolRuntime {
  constructor(private readonly defaultOptions: ToolExecutionOptions = {}) {}

  /**
   * Executes a tool defined by manifest and bundle/handler in an isolated sandbox.
   */
  async executeTool(
    manifest: ToolManifest | Record<string, unknown>,
    bundlePathOrHandler: string | ((ctx: ToolContext) => unknown | Promise<unknown>),
    input: unknown,
    options: ToolExecutionOptions = {}
  ): Promise<InvocationResult> {
    const mergedOptions: ToolExecutionOptions = {
      ...this.defaultOptions,
      ...options,
    };

    const mode = mergedOptions.mode ?? "auto";

    // If in-process or sandbox-vm explicitly selected, or handler is a direct function:
    if (mode === "in-process" || mode === "sandbox-vm" || typeof bundlePathOrHandler === "function") {
      return await DeterministicWorkerSandbox.execute(
        manifest,
        bundlePathOrHandler,
        input,
        mergedOptions
      );
    }

    // Check if Deno is available when in auto mode
    const denoAvailable = isDenoAvailable(mergedOptions.denoExecutable);

    if (mode === "deno" || (mode === "auto" && denoAvailable)) {
      if (!denoAvailable && mode === "deno") {
        throw new Error(
          `Deno executable '${mergedOptions.denoExecutable ?? "deno"}' is not available in PATH`
        );
      }

      // Execute via Deno Child Process
      const workerProcess = new WorkerProcess({
        manifest,
        bundleEntrypoint: bundlePathOrHandler as string,
        workspaceRoot: mergedOptions.workspaceRoot,
        environment: mergedOptions.environment,
        timeoutMs: mergedOptions.timeoutMs,
        memoryLimitMb: mergedOptions.memoryLimitMb,
        maxOutputSizeBytes: mergedOptions.maxOutputSizeBytes,
        denoExecutable: mergedOptions.denoExecutable,
        brokerHandler: mergedOptions.brokerHandler,
        onProgress: mergedOptions.onProgress,
        onLog: mergedOptions.onLog,
      });

      const invocationId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const workerRes = await workerProcess.execute(invocationId, input, {
        sessionId: mergedOptions.sessionId,
        workspaceId: mergedOptions.workspaceId,
      });

      return {
        status: workerRes.status,
        output: workerRes.output,
        error: workerRes.error,
        durationMs: workerRes.durationMs,
        resourceUsage: workerRes.resourceUsage,
        logs: workerRes.logs,
        progress: workerRes.progress,
      };
    }

    // Fallback to DeterministicWorkerSandbox
    return await DeterministicWorkerSandbox.execute(
      manifest,
      bundlePathOrHandler,
      input,
      mergedOptions
    );
  }
}
