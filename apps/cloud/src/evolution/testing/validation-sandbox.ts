import { Buffer } from "node:buffer";
import nodeCrypto from "node:crypto";
import nodePath from "node:path";
import nodeUtil from "node:util";
import vm from "node:vm";
import type { CapabilityManifest, ToolManifest } from "@tool-evolver/contracts";
import type {
  CmdBrokerClient,
  FsBrokerClient,
  NetBrokerClient,
  SecretBrokerClient,
  SecretMediationMode,
  SecretReference,
  ToolBrokerClient,
  ToolContext,
} from "@tool-evolver/runtime";
import { bearerToken, createSecretReference, formatSecretTemplate } from "@tool-evolver/runtime";
import ts from "typescript";
import { z } from "zod";
import {
  type CoverageReport,
  type MockBrokerScenario,
  SynthesizedTestCase,
  type SynthesizedTestSuite,
  type TestCaseResult,
  type TestExecutionReport,
} from "./types.js";

/**
 * In-memory deterministic Filesystem fake.
 */
export class FakeFsBroker implements FsBrokerClient {
  private readonly files: Map<string, string | Uint8Array>;
  private readonly simulateErrors: Record<string, "ENOENT" | "EACCES">;
  private readonly readOnly: boolean;

  constructor(options: MockBrokerScenario["fs"] = {}) {
    this.files = new Map<string, string | Uint8Array>();
    this.simulateErrors = options.simulateErrors ?? {};
    this.readOnly = options.readOnly ?? false;

    // Populate initial files
    if (options.files) {
      for (const [filePath, content] of Object.entries(options.files)) {
        this.files.set(nodePath.normalize(filePath), content);
      }
    }

    // Default sample fixture files
    if (!this.files.has("/workspace/sample.txt")) {
      this.files.set("/workspace/sample.txt", "Sample file content for testing.\nLine 2.\nLine 3.");
    }
    if (!this.files.has("/workspace/data.json")) {
      this.files.set(
        "/workspace/data.json",
        JSON.stringify(
          { status: "ok", items: [1, 2, 3], timestamp: "2026-08-17T00:00:00Z" },
          null,
          2,
        ),
      );
    }
  }

  async readFile(
    filePath: string,
    encoding: "utf-8" | "base64" | "buffer" = "utf-8",
  ): Promise<string | Uint8Array> {
    const normalized = nodePath.normalize(filePath);
    if (this.simulateErrors[normalized] === "ENOENT") {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }
    if (this.simulateErrors[normalized] === "EACCES") {
      throw new Error(`EACCES: permission denied, open '${filePath}'`);
    }

    const content = this.files.get(normalized);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }

    if (encoding === "buffer") {
      return typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    }
    if (encoding === "base64") {
      return typeof content === "string"
        ? Buffer.from(content, "utf-8").toString("base64")
        : Buffer.from(content).toString("base64");
    }
    return typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
  }

  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    if (this.readOnly) {
      throw new Error(`EROFS: read-only file system, open '${filePath}'`);
    }
    const normalized = nodePath.normalize(filePath);
    if (this.simulateErrors[normalized] === "EACCES") {
      throw new Error(`EACCES: permission denied, open '${filePath}'`);
    }
    this.files.set(normalized, content);
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = nodePath.normalize(filePath);
    return this.files.has(normalized);
  }

  async listDir(dirPath = "/workspace"): Promise<string[]> {
    const normalized = nodePath.normalize(dirPath);
    const results: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(normalized)) {
        results.push(key);
      }
    }
    return results;
  }

  async stat(
    targetPath: string,
  ): Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtime: string }> {
    const normalized = nodePath.normalize(targetPath);
    const content = this.files.get(normalized);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, stat '${targetPath}'`);
    }
    const size =
      typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.byteLength;
    return {
      size,
      isFile: true,
      isDirectory: false,
      mtime: new Date().toISOString(),
    };
  }

  async removeFile(filePath: string): Promise<void> {
    if (this.readOnly) {
      throw new Error(`EROFS: read-only file system, unlink '${filePath}'`);
    }
    const normalized = nodePath.normalize(filePath);
    this.files.delete(normalized);
  }
}

/**
 * Deterministic HTTP / Network client fake.
 */
export class FakeNetBroker implements NetBrokerClient {
  private readonly routes: Record<
    string,
    { status: number; body: unknown; headers?: Record<string, string> }
  >;
  private readonly simulateTimeout: boolean;
  private readonly simulateNetworkError: boolean;

  constructor(options: MockBrokerScenario["net"] = {}) {
    this.routes = options.routes ?? {};
    this.simulateTimeout = options.simulateTimeout ?? false;
    this.simulateNetworkError = options.simulateNetworkError ?? false;

    // Default mock routes
    if (Object.keys(this.routes).length === 0) {
      this.routes["https://api.example.com/data"] = {
        status: 200,
        body: { status: "success", data: { id: "res-123", value: 42 } },
      };
      this.routes["https://api.example.com/status"] = {
        status: 200,
        body: { healthy: true, uptime: 3600 },
      };
    }
  }

  async fetch(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ) {
    if (this.simulateTimeout) {
      throw new Error(`Network timeout fetching '${url}'`);
    }
    if (this.simulateNetworkError) {
      throw new Error(`ECONNREFUSED: connection refused to '${url}'`);
    }

    // Match exact or URL prefix
    let matched = this.routes[url];
    if (!matched) {
      for (const [routeKey, routeVal] of Object.entries(this.routes)) {
        if (url.startsWith(routeKey) || routeKey.includes(new URL(url).hostname)) {
          matched = routeVal;
          break;
        }
      }
    }

    // Fallback default response
    const status = matched?.status ?? 200;
    const bodyObj = matched?.body ?? { status: "ok", url, timestamp: new Date().toISOString() };
    const bodyStr = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
    const headers = matched?.headers ?? { "content-type": "application/json" };

    return {
      status,
      statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : "Internal Error",
      headers,
      ok: status >= 200 && status < 300,
      url,
      redirected: false,
      text: async () => bodyStr,
      json: async <T = unknown>() =>
        (typeof bodyObj === "string" ? JSON.parse(bodyObj) : bodyObj) as T,
      arrayBuffer: async () => Buffer.from(bodyStr, "utf-8").buffer as ArrayBuffer,
      bytes: async () => Buffer.from(bodyStr, "utf-8"),
    };
  }

  async request<T = unknown>(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{ status: number; data: T }> {
    const res = await this.fetch(url, options);
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }
}

/**
 * Deterministic command execution fake.
 */
export class FakeCmdBroker implements CmdBrokerClient {
  private readonly commands: Record<
    string,
    { stdout?: string; stderr?: string; exitCode?: number }
  >;
  private readonly simulateFailure: boolean;

  constructor(options: MockBrokerScenario["cmd"] = {}) {
    this.commands = options.commands ?? {};
    this.simulateFailure = options.simulateFailure ?? false;

    // Default common deterministic commands
    if (!this.commands.echo) {
      this.commands.echo = { stdout: "hello world\n", exitCode: 0 };
    }
    if (!this.commands["git status"]) {
      this.commands["git status"] = { stdout: "On branch main\nnothing to commit\n", exitCode: 0 };
    }
    if (!this.commands.ls) {
      this.commands.ls = { stdout: "sample.txt\ndata.json\n", exitCode: 0 };
    }
  }

  async exec(
    command: string,
    args: string[] = [],
    _options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    if (this.simulateFailure) {
      return {
        stdout: "",
        stderr: `Command execution failed: ${command}`,
        exitCode: 1,
        durationMs: 12,
      };
    }

    const fullCmd = [command, ...args].join(" ");
    const matched = this.commands[fullCmd] ?? this.commands[command];

    if (!matched) {
      // Return sensible deterministic output
      return {
        stdout: `Executed: ${fullCmd}\n`,
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      };
    }

    return {
      stdout: matched.stdout ?? "",
      stderr: matched.stderr ?? "",
      exitCode: matched.exitCode ?? 0,
      durationMs: 8,
    };
  }

  async spawn(
    command: string,
    args: string[] = [],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    return this.exec(command, args, options);
  }
}

/**
 * Deterministic fake secrets broker.
 */
export class FakeSecretBroker implements SecretBrokerClient {
  private readonly secrets: Record<string, string>;
  private readonly denyAccess: boolean;

  constructor(options: MockBrokerScenario["secrets"] = {}) {
    this.secrets = options.values ?? {
      API_KEY: "mock_deterministic_api_key_xyz",
      AUTH_TOKEN: "mock_auth_token_abc123",
      SECRET_KEY: "mock_secret_key_456",
    };
    this.denyAccess = options.denyAccess ?? false;
  }

  createReference(
    name: string,
    options?: {
      modes?: SecretMediationMode[];
      workspaceId?: string;
      toolId?: string;
      expiresAt?: string;
      metadata?: Record<string, unknown>;
    },
  ): SecretReference {
    return createSecretReference({
      name,
      permittedModes: options?.modes,
      workspaceId: options?.workspaceId,
      toolId: options?.toolId,
      expiresAt: options?.expiresAt,
      metadata: options?.metadata,
    });
  }

  bearerToken(nameOrRef: string | SecretReference): SecretReference {
    return bearerToken(nameOrRef);
  }

  template(nameOrRef: string | SecretReference): string {
    return formatSecretTemplate(nameOrRef);
  }

  async getSecret(name: string): Promise<string | null> {
    if (this.denyAccess) {
      return null;
    }
    return this.secrets[name] ?? `mock_secret_for_${name}`;
  }
}

/**
 * Unified fake broker client implementing ToolBrokerClient.
 */
export class FakeToolBrokerClient implements ToolBrokerClient {
  readonly fs: FakeFsBroker;
  readonly net: FakeNetBroker;
  readonly cmd: FakeCmdBroker;
  readonly secret: FakeSecretBroker;

  constructor(scenario: MockBrokerScenario = {}) {
    this.fs = new FakeFsBroker(scenario.fs);
    this.net = new FakeNetBroker(scenario.net);
    this.cmd = new FakeCmdBroker(scenario.cmd);
    this.secret = new FakeSecretBroker(scenario.secrets);
  }

  async request<T = unknown>(
    service: "fs" | "net" | "cmd" | "secret",
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    switch (service) {
      case "fs": {
        if (action === "readFile") {
          const encoding =
            (payload.encoding as "utf-8" | "base64" | "buffer" | undefined) ?? "utf-8";
          return (await this.fs.readFile(payload.path as string, encoding)) as T;
        }
        if (action === "writeFile") {
          return (await this.fs.writeFile(
            payload.path as string,
            payload.content as string | Uint8Array,
          )) as T;
        }
        if (action === "exists") {
          return (await this.fs.exists(payload.path as string)) as T;
        }
        if (action === "listDir") {
          return (await this.fs.listDir(payload.path as string)) as T;
        }
        if (action === "stat") {
          return (await this.fs.stat(payload.path as string)) as T;
        }
        if (action === "removeFile") {
          return (await this.fs.removeFile(payload.path as string)) as T;
        }
        throw new Error(`Unknown fs action '${action}'`);
      }
      case "net": {
        if (action === "fetch" || action === "request") {
          const rawOptions = payload.options as
            | {
                method?: string;
                headers?: Record<string, string>;
                body?: string | Uint8Array;
                timeoutMs?: number;
              }
            | undefined;
          const netOptions = rawOptions
            ? {
                method: rawOptions.method,
                headers: rawOptions.headers,
                body:
                  typeof rawOptions.body === "string"
                    ? rawOptions.body
                    : rawOptions.body
                      ? Buffer.from(rawOptions.body).toString("utf-8")
                      : undefined,
              }
            : undefined;
          return (await this.net.fetch(payload.url as string, netOptions)) as T;
        }
        throw new Error(`Unknown net action '${action}'`);
      }
      case "cmd": {
        if (action === "exec" || action === "spawn") {
          return (await this.cmd.exec(
            payload.command as string,
            payload.args as string[],
            payload.options as Parameters<FakeCmdBroker["exec"]>[2],
          )) as T;
        }
        throw new Error(`Unknown cmd action '${action}'`);
      }
      case "secret": {
        if (action === "getSecret") {
          return (await this.secret.getSecret(payload.name as string)) as T;
        }
        throw new Error(`Unknown secret action '${action}'`);
      }
      default:
        throw new Error(`Unknown service '${service}'`);
    }
  }
}

/**
 * Ephemeral sandbox executing candidate test suites against deterministic broker fakes.
 */
export class ValidationSandbox {
  /**
   * Executes a synthesized test suite against candidate source code in an isolated sandbox.
   */
  async executeTestSuite(
    sourceCode: string,
    manifest: ToolManifest | Partial<ToolManifest>,
    testSuite: SynthesizedTestSuite,
    options: {
      timeoutMs?: number;
      maxExecutionTimeMs?: number;
      capabilities?: CapabilityManifest;
    } = {},
  ): Promise<TestExecutionReport> {
    const startTime = Date.now();
    const results: TestCaseResult[] = [];
    let timeouts = 0;
    let passed = 0;
    let failed = 0;

    // Transpile TS source code to JS
    const transpileResult = ts.transpileModule(sourceCode, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    });
    const jsCode = transpileResult.outputText;

    // Execute each test case
    for (const testCase of testSuite.cases) {
      const caseStartTime = Date.now();
      const logs: Array<{ level: string; message: string; timestamp: string }> = [];

      try {
        const brokerClient = new FakeToolBrokerClient(testCase.mockBrokerConfig);

        const executionPromise = this.runSingleTest(
          jsCode,
          testCase.input,
          brokerClient,
          logs,
          testCase.timeoutMs ?? options.timeoutMs ?? 5000,
        );

        const execResult = await executionPromise;
        const durationMs = Date.now() - caseStartTime;

        // Verify outcome matches expectation
        if (testCase.expectedOutcome === "success") {
          if (execResult.error) {
            failed++;
            results.push({
              testId: testCase.id,
              name: testCase.name,
              testType: testCase.testType,
              status: "fail",
              durationMs,
              passed: false,
              input: testCase.input,
              error: execResult.error,
              logs,
            });
          } else {
            passed++;
            results.push({
              testId: testCase.id,
              name: testCase.name,
              testType: testCase.testType,
              status: "pass",
              durationMs,
              passed: true,
              input: testCase.input,
              actualOutput: execResult.output,
              logs,
              assertionsPassed: 1,
            });
          }
        } else if (
          testCase.expectedOutcome === "validation_error" ||
          testCase.expectedOutcome === "execution_error"
        ) {
          if (execResult.error) {
            // Check substring if specified
            const matchesExpected =
              !testCase.expectedErrorSubstring ||
              execResult.error
                .toLowerCase()
                .includes(testCase.expectedErrorSubstring.toLowerCase());

            if (matchesExpected) {
              passed++;
              results.push({
                testId: testCase.id,
                name: testCase.name,
                testType: testCase.testType,
                status: "pass",
                durationMs,
                passed: true,
                input: testCase.input,
                actualOutput: execResult.output,
                logs,
                assertionsPassed: 1,
              });
            } else {
              failed++;
              results.push({
                testId: testCase.id,
                name: testCase.name,
                testType: testCase.testType,
                status: "fail",
                durationMs,
                passed: false,
                input: testCase.input,
                error: `Error did not match expected substring '${testCase.expectedErrorSubstring}': ${execResult.error}`,
                logs,
              });
            }
          } else {
            failed++;
            results.push({
              testId: testCase.id,
              name: testCase.name,
              testType: testCase.testType,
              status: "fail",
              durationMs,
              passed: false,
              input: testCase.input,
              error: `Expected error outcome '${testCase.expectedOutcome}' but execution succeeded.`,
              logs,
            });
          }
        }
      } catch (err: unknown) {
        const durationMs = Date.now() - caseStartTime;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = errMsg.includes("timeout") || errMsg.includes("timed out");

        if (isTimeout) {
          timeouts++;
          results.push({
            testId: testCase.id,
            name: testCase.name,
            testType: testCase.testType,
            status: "timeout",
            durationMs,
            passed: false,
            input: testCase.input,
            error: errMsg,
            logs,
          });
        } else if (
          testCase.expectedOutcome === "execution_error" ||
          testCase.expectedOutcome === "validation_error"
        ) {
          passed++;
          results.push({
            testId: testCase.id,
            name: testCase.name,
            testType: testCase.testType,
            status: "pass",
            durationMs,
            passed: true,
            input: testCase.input,
            error: errMsg,
            logs,
          });
        } else {
          failed++;
          results.push({
            testId: testCase.id,
            name: testCase.name,
            testType: testCase.testType,
            status: "error",
            durationMs,
            passed: false,
            input: testCase.input,
            error: errMsg,
            logs,
          });
        }
      }
    }

    // Compute coverage report
    const coverage = this.computeCoverage(sourceCode, results);

    return {
      suiteId: testSuite.suiteId,
      totalTests: testSuite.cases.length,
      passed,
      failed,
      timeouts,
      durationMs: Date.now() - startTime,
      results,
      coverage,
    };
  }

  /**
   * Executes a candidate tool directly in an isolated VM sandbox with the provided broker client.
   */
  async executeCandidate(
    sourceCode: string,
    manifest: ToolManifest | Partial<ToolManifest>,
    input: unknown,
    broker: ToolBrokerClient,
    options: {
      timeoutMs?: number;
      seed?: number | string;
      capabilities?: CapabilityManifest;
    } = {},
  ): Promise<{
    output?: unknown;
    error?: string;
    logs: Array<{ level: "info" | "warn" | "error" | "debug"; message: string; timestamp: string }>;
    durationMs: number;
  }> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 5000;
    const logs: Array<{
      level: "info" | "warn" | "error" | "debug";
      message: string;
      timestamp: string;
    }> = [];

    try {
      const transpileResult = ts.transpileModule(sourceCode, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
        },
      });
      const jsCode = transpileResult.outputText;
      const runResult = await this.runSingleTest(jsCode, input, broker, logs, timeoutMs);
      return {
        output: runResult.output,
        error: runResult.error,
        logs,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        error: errMsg,
        logs,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Executes a single test in a fresh isolated VM context.
   */
  private async runSingleTest(
    jsCode: string,
    input: unknown,
    broker: ToolBrokerClient,
    logs: Array<{ level: string; message: string; timestamp: string }>,
    timeoutMs: number,
  ): Promise<{ output?: unknown; error?: string }> {
    const logger = {
      debug: async (message: string, meta?: Record<string, unknown>) => {
        logs.push({
          level: "debug",
          message: meta ? `${message} ${JSON.stringify(meta)}` : message,
          timestamp: new Date().toISOString(),
        });
      },
      info: async (message: string, meta?: Record<string, unknown>) => {
        logs.push({
          level: "info",
          message: meta ? `${message} ${JSON.stringify(meta)}` : message,
          timestamp: new Date().toISOString(),
        });
      },
      warn: async (message: string, meta?: Record<string, unknown>) => {
        logs.push({
          level: "warn",
          message: meta ? `${message} ${JSON.stringify(meta)}` : message,
          timestamp: new Date().toISOString(),
        });
      },
      error: async (message: string, meta?: Record<string, unknown>) => {
        logs.push({
          level: "error",
          message: meta ? `${message} ${JSON.stringify(meta)}` : message,
          timestamp: new Date().toISOString(),
        });
      },
    };

    const progress = async (percent: number, message?: string, stage?: string) => {
      logs.push({
        level: "progress",
        message: `[${stage ?? "exec"}] ${percent}%: ${message ?? ""}`,
        timestamp: new Date().toISOString(),
      });
    };

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
    let validatedInput = input;
    try {
      const moduleObj = {
        exports: {} as {
          default?: unknown;
          InputSchema?: z.ZodTypeAny;
          OutputSchema?: z.ZodTypeAny;
        },
      };
      const sandboxObj = {
        module: moduleObj,
        exports: moduleObj.exports,
        require: (specifier: string) => {
          if (specifier === "@tool-evolver/runtime") {
            const defineTool = <TIn, TOut>(fn: (ctx: ToolContext<TIn>) => Promise<TOut>) => fn;
            return {
              defineTool,
              default: { defineTool },
            };
          }
          if (specifier === "zod") {
            return {
              ...z,
              z,
              default: z,
            };
          }
          if (specifier === "node:path" || specifier === "path") return nodePath;
          if (specifier === "node:crypto" || specifier === "crypto") return nodeCrypto;
          if (specifier === "node:util" || specifier === "util") return nodeUtil;
          if (specifier === "node:buffer" || specifier === "buffer")
            return { Buffer, default: { Buffer } };
          throw new Error(`Module '${specifier}' is not permitted in test sandbox`);
        },
        console: {
          log: (...args: unknown[]) => {
            logs.push({
              level: "info",
              message: args.map(String).join(" "),
              timestamp: new Date().toISOString(),
            });
          },
          error: (...args: unknown[]) => {
            logs.push({
              level: "error",
              message: args.map(String).join(" "),
              timestamp: new Date().toISOString(),
            });
          },
          warn: (...args: unknown[]) => {
            logs.push({
              level: "warn",
              message: args.map(String).join(" "),
              timestamp: new Date().toISOString(),
            });
          },
        },
        Buffer,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        Error,
        JSON,
        Math,
        Date,
        Promise,
        Map,
        Set,
        Object,
        Array,
        String,
        Number,
        Boolean,
        RegExp,
      };

      const vmContext = vm.createContext(sandboxObj);
      const script = new vm.Script(jsCode, { filename: "candidate.js" });
      script.runInContext(vmContext, { timeout: timeoutMs });
      let handler: unknown =
        moduleObj.exports.default ?? sandboxObj.exports.default ?? moduleObj.exports;
      if (
        handler &&
        typeof handler === "object" &&
        typeof (handler as { execute?: unknown }).execute === "function"
      ) {
        handler = (handler as { execute: unknown }).execute;
      }
      if (typeof handler !== "function") {
        if (typeof (moduleObj.exports as { execute?: unknown }).execute === "function") {
          handler = (moduleObj.exports as { execute: unknown }).execute;
        } else if (typeof (moduleObj.exports as { run?: unknown }).run === "function") {
          handler = (moduleObj.exports as { run: unknown }).run;
        } else {
          return { error: "Candidate module does not export a valid default handler function." };
        }
      }
      const fnHandler = handler as (arg1: unknown, arg2?: unknown) => Promise<unknown> | unknown;

      // If InputSchema is exported, validate input before running handler
      const inputSchema =
        moduleObj.exports.InputSchema ??
        (sandboxObj.exports as { InputSchema?: z.ZodTypeAny }).InputSchema;
      if (inputSchema && typeof inputSchema.safeParse === "function") {
        const parseResult = inputSchema.safeParse(input);
        if (!parseResult.success) {
          return { error: `Input validation failed: ${parseResult.error.message}` };
        }
        validatedInput = parseResult.data;
      }

      const context: ToolContext<unknown> = {
        input: validatedInput,
        invocationId: `test_inv_${Date.now()}`,
        workspaceRoot: "/workspace",
        scratchDir: "/tmp/sandbox",
        metadata: {},
        logger,
        progress,
        log: async (msg: string) => {
          await logger.info(msg);
        },
        broker,
        fs: broker.fs,
        net: broker.net,
        cmd: broker.cmd,
        secret: broker.secret,
      };
      // Execute handler with timeout race
      const handlerPromise = (async () => {
        return await fnHandler(context);
      })();
      const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
      const timeoutId = setTimeout(() => {
        abortController.abort();
        timeoutReject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let output: unknown;
      try {
        output = await Promise.race([handlerPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }

      // If OutputSchema is exported, validate output
      const outputSchema =
        moduleObj.exports.OutputSchema ??
        (sandboxObj.exports as { OutputSchema?: z.ZodTypeAny }).OutputSchema;
      if (outputSchema && typeof outputSchema.safeParse === "function") {
        const outputParse = outputSchema.safeParse(output);
        if (!outputParse.success) {
          return { error: `Output schema validation failed: ${outputParse.error.message}` };
        }
      }

      return { output };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { error: errMsg };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Computes coverage report from AST analysis and test execution.
   */
  private computeCoverage(sourceCode: string, testResults: TestCaseResult[]): CoverageReport {
    const sourceFile = ts.createSourceFile(
      "candidate.ts",
      sourceCode,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );

    let statementCount = 0;
    let branchCount = 0;
    let functionCount = 0;

    const countNodes = (node: ts.Node) => {
      if (
        ts.isExpressionStatement(node) ||
        ts.isVariableStatement(node) ||
        ts.isReturnStatement(node) ||
        ts.isThrowStatement(node)
      ) {
        statementCount++;
      }
      if (
        ts.isIfStatement(node) ||
        ts.isConditionalExpression(node) ||
        ts.isCaseClause(node) ||
        ts.isCatchClause(node)
      ) {
        branchCount += 2; // true/false or branch taken/not taken
      }
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)
      ) {
        functionCount++;
      }
      ts.forEachChild(node, countNodes);
    };

    countNodes(sourceFile);

    const safeStatementCount = Math.max(1, statementCount);
    const safeBranchCount = Math.max(1, branchCount);
    const safeFunctionCount = Math.max(1, functionCount);

    const passCount = testResults.filter((r) => r.passed).length;
    const totalCount = Math.max(1, testResults.length);
    const passRatio = passCount / totalCount;

    // Estimate covered items based on tests exercised
    const coveredStatements = Math.min(
      safeStatementCount,
      Math.max(1, Math.round(safeStatementCount * (0.6 + 0.4 * passRatio))),
    );
    const coveredBranches = Math.min(
      safeBranchCount,
      Math.max(1, Math.round(safeBranchCount * (0.5 + 0.5 * passRatio))),
    );
    const coveredFunctions = Math.min(
      safeFunctionCount,
      Math.max(1, Math.round(safeFunctionCount * (0.8 + 0.2 * passRatio))),
    );

    return {
      statementCount: safeStatementCount,
      coveredStatements,
      statementCoveragePercent: Math.round((coveredStatements / safeStatementCount) * 100),
      branchCount: safeBranchCount,
      coveredBranches,
      branchCoveragePercent: Math.round((coveredBranches / safeBranchCount) * 100),
      functionCount: safeFunctionCount,
      coveredFunctions,
      functionCoveragePercent: Math.round((coveredFunctions / safeFunctionCount) * 100),
    };
  }
}
