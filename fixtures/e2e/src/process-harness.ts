/**
 * @tool-evolver/e2e - Real Process Harness
 *
 * Spawns and manages real Linux OS subprocesses for Daemon, Gateway MCP Shim,
 * Cloud Server, and Deterministic HTTP Mock Inference Service with PID tracking,
 * lifecycle state machines, disposable ports/directories, and clean teardown.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import net from "node:net";
import readline from "node:readline";

/**
 * Polyfill for Promise.withResolvers.
 */
export function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Finds an available disposable TCP port.
 */
export async function findAvailablePort(preferredPort = 0): Promise<number> {
  const { promise, resolve, reject } = withResolvers<number>();
  const srv = net.createServer();
  srv.unref();
  srv.on("error", reject);
  srv.listen(preferredPort, "127.0.0.1", () => {
    const addr = srv.address() as net.AddressInfo;
    const port = addr.port;
    srv.close(() => resolve(port));
  });
  return promise;
}

/**
 * Lifecycle state of a managed subprocess.
 */
export type ProcessLifecycleState =
  | "uninitialized"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"
  | "killed";

/**
 * Options for spawning a managed subprocess.
 */
export interface ManagedProcessOptions {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  readyPattern?: RegExp;
  readyCheck?: (proc: ManagedProcess) => Promise<boolean>;
  readyTimeoutMs?: number;
  silent?: boolean;
}

/**
 * Representation of a single spawned real OS child process.
 */
export class ManagedProcess extends EventEmitter {
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly readyPattern?: RegExp;
  readonly readyCheck?: (proc: ManagedProcess) => Promise<boolean>;
  readonly readyTimeoutMs: number;
  readonly silent: boolean;

  private _child: ChildProcess | null = null;
  private _pid: number | undefined;
  private _status: ProcessLifecycleState = "uninitialized";
  private _startedAt?: number;
  private _stoppedAt?: number;
  private _exitCode: number | null = null;
  private _stdoutLogs: string[] = [];
  private _stderrLogs: string[] = [];
  private _stopPromise: Promise<void> | null = null;

  constructor(options: ManagedProcessOptions) {
    super();
    this.name = options.name;
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env ?? {};
    this.readyPattern = options.readyPattern;
    this.readyCheck = options.readyCheck;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15000;
    this.silent = options.silent ?? true;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get status(): ProcessLifecycleState {
    return this._status;
  }

  get startedAt(): number | undefined {
    return this._startedAt;
  }

  get stoppedAt(): number | undefined {
    return this._stoppedAt;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get child(): ChildProcess | null {
    return this._child;
  }

  get stdoutLogs(): readonly string[] {
    return this._stdoutLogs;
  }

  get stderrLogs(): readonly string[] {
    return this._stderrLogs;
  }

  get allLogs(): string {
    return [
      ...this._stdoutLogs.map((l) => `[stdout] ${l}`),
      ...this._stderrLogs.map((l) => `[stderr] ${l}`),
    ].join("\n");
  }

  /**
   * Starts the subprocess and awaits readiness verification.
   */
  async start(): Promise<number> {
    if (this._status === "running" || this._status === "starting") {
      throw new Error(`Process ${this.name} is already ${this._status}`);
    }

    this._status = "starting";
    this._exitCode = null;
    this._stdoutLogs = [];
    this._stderrLogs = [];

    const mergedEnv = {
      ...process.env,
      ...this.env,
    };

    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._child = child;
    this._pid = child.pid;
    this._startedAt = Date.now();

    child.on("error", (err) => {
      this.emit("error", err);
      if (this._status === "starting" || this._status === "running") {
        this._status = "crashed";
      }
    });

    child.on("exit", (code, signal) => {
      this._exitCode = code;
      this._stoppedAt = Date.now();
      if (this._status === "stopping") {
        this._status = "stopped";
      } else if (signal === "SIGKILL") {
        this._status = "killed";
      } else {
        this._status = code === 0 ? "stopped" : "crashed";
      }
      this.emit("exit", code, signal);
    });

    if (child.stdout) {
      const rlStdout = readline.createInterface({ input: child.stdout });
      rlStdout.on("line", (line) => {
        this._stdoutLogs.push(line);
        if (!this.silent) {
          process.stdout.write(`[${this.name}:stdout] ${line}\n`);
        }
        this.emit("stdout", line);
      });
    }

    if (child.stderr) {
      const rlStderr = readline.createInterface({ input: child.stderr });
      rlStderr.on("line", (line) => {
        this._stderrLogs.push(line);
        if (!this.silent) {
          process.stderr.write(`[${this.name}:stderr] ${line}\n`);
        }
        this.emit("stderr", line);
      });
    }

    await this.waitForReadiness();
    this._status = "running";
    this.emit("ready", this._pid);
    return this._pid!;
  }

  private async waitForReadiness(): Promise<void> {
    const startTime = Date.now();
    const { promise, resolve, reject } = withResolvers<void>();
    let isSettled = false;

    const timer = setInterval(async () => {
      if (isSettled) return;

      if (this._exitCode !== null) {
        isSettled = true;
        clearInterval(timer);
        reject(
          new Error(
            `Process ${this.name} exited prematurely with code ${this._exitCode} before becoming ready.\nLogs:\n${this.allLogs}`,
          ),
        );
        return;
      }

      if (Date.now() - startTime > this.readyTimeoutMs) {
        isSettled = true;
        clearInterval(timer);
        reject(
          new Error(
            `Timed out waiting ${this.readyTimeoutMs}ms for process ${this.name} (PID ${this._pid}) to become ready.\nLogs:\n${this.allLogs}`,
          ),
        );
        return;
      }

      if (this.readyPattern) {
        const match =
          this._stdoutLogs.some((l) => this.readyPattern!.test(l)) ||
          this._stderrLogs.some((l) => this.readyPattern!.test(l));
        if (match) {
          isSettled = true;
          clearInterval(timer);
          resolve();
          return;
        }
      }

      if (this.readyCheck) {
        try {
          const ready = await this.readyCheck(this);
          if (ready) {
            isSettled = true;
            clearInterval(timer);
            resolve();
            return;
          }
        } catch {
          // keep polling until timeout
        }
      }

      if (!this.readyPattern && !this.readyCheck) {
        if (this._pid) {
          isSettled = true;
          clearInterval(timer);
          resolve();
          return;
        }
      }
    }, 50);

    return promise;
  }

  /**
   * Writes a line of string to the process stdin.
   */
  writeStdin(data: string): void {
    if (!this._child || !this._child.stdin || !this._child.stdin.writable) {
      throw new Error(`Cannot write to stdin of process ${this.name}: stdin not writable`);
    }
    this._child.stdin.write(data.endsWith("\n") ? data : `${data}\n`);
  }

  /**
   * Forcibly kills the process with SIGKILL and waits for exit.
   */
  async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (!this._child || this._child.killed || this._exitCode !== null) {
      this._status = "stopped";
      return;
    }

    this._status = "killed";
    const { promise, resolve } = withResolvers<void>();
    this.once("exit", () => resolve());
    try {
      this._child?.kill(signal);
    } catch {
      resolve();
    }
    return promise;
  }

  /**
   * Gracefully stops the process with SIGTERM, falling back to SIGKILL on timeout.
   */
  async stop(timeoutMs = 5000): Promise<void> {
    if (!this._child || this._child.killed || this._exitCode !== null) {
      this._status = "stopped";
      return;
    }

    if (this._stopPromise) return this._stopPromise;

    this._status = "stopping";
    const { promise, resolve } = withResolvers<void>();
    let resolved = false;

    const onExit = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      this._status = "stopped";
      this._stopPromise = null;
      resolve();
    };

    this.once("exit", onExit);

    const killTimer = setTimeout(() => {
      if (!resolved && this._child) {
        try {
          this._child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, timeoutMs);

    try {
      this._child?.kill("SIGTERM");
    } catch {
      onExit();
    }

    this._stopPromise = promise;
    return this._stopPromise;
  }

  /**
   * Restarts the process and verifies readiness of the new instance.
   */
  async restart(extraEnv?: Record<string, string | undefined>): Promise<number> {
    await this.stop(3000);
    if (extraEnv) {
      Object.assign(this.env, extraEnv);
    }
    return this.start();
  }

  /**
   * Awaits a log line matching pattern.
   */
  async waitForLog(pattern: RegExp | string, timeoutMs = 10000): Promise<string> {
    const reg = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    const existing = [...this._stdoutLogs, ...this._stderrLogs].find((l) => reg.test(l));
    if (existing) return existing;

    const { promise, resolve, reject } = withResolvers<string>();

    const timer = setTimeout(() => {
      this.removeListener("stdout", check);
      this.removeListener("stderr", check);
      reject(new Error(`Timed out waiting for log pattern ${pattern} in process ${this.name}`));
    }, timeoutMs);

    const check = (line: string) => {
      if (reg.test(line)) {
        clearTimeout(timer);
        this.removeListener("stdout", check);
        this.removeListener("stderr", check);
        resolve(line);
      }
    };

    this.on("stdout", check);
    this.on("stderr", check);

    return promise;
  }
}

/**
 * Process Harness orchestrating multiple real subprocesses.
 */
export class ProcessHarness {
  private processes = new Map<string, ManagedProcess>();

  /**
   * Spawns and manages a process.
   */
  async spawnProcess(options: ManagedProcessOptions): Promise<ManagedProcess> {
    const proc = new ManagedProcess(options);
    this.processes.set(proc.name, proc);
    await proc.start();
    return proc;
  }

  getProcess(name: string): ManagedProcess | undefined {
    return this.processes.get(name);
  }

  getAllProcesses(): ManagedProcess[] {
    return Array.from(this.processes.values());
  }

  getPids(): Record<string, number | undefined> {
    const pids: Record<string, number | undefined> = {};
    for (const [name, proc] of this.processes.entries()) {
      pids[name] = proc.pid;
    }
    return pids;
  }

  /**
   * Stops all managed processes in reverse registration order.
   */
  async stopAll(timeoutMs = 5000): Promise<void> {
    const procs = Array.from(this.processes.values()).reverse();
    await Promise.all(procs.map((p) => p.stop(timeoutMs).catch(() => {})));
    this.processes.clear();
  }
}

export interface RecordedInferenceRequest {
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export type MockInferenceCustomHandler = (req: {
  method: string;
  url: string;
  body: unknown;
}) => { statusCode?: number; body: unknown } | null;

/**
 * Deterministic HTTP Mock Inference Server.
 * Answers OpenAI-compatible `/v1/chat/completions` requests deterministically.
 */
export class MockInferenceServer {
  private server: Server | null = null;
  private _port = 0;
  private recordedRequests: RecordedInferenceRequest[] = [];
  private customHandler?: MockInferenceCustomHandler;

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get requests(): readonly RecordedInferenceRequest[] {
    return this.recordedRequests;
  }

  setHandler(handler: MockInferenceCustomHandler | undefined): void {
    this.customHandler = handler;
  }

  async start(preferredPort = 0): Promise<number> {
    const port = await findAvailablePort(preferredPort);
    this._port = port;

    const { promise, resolve, reject } = withResolvers<number>();

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      let rawBody = "";
      req.on("data", (chunk: Buffer) => {
        rawBody += chunk.toString("utf-8");
      });

      req.on("end", () => {
        let body: unknown = null;
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            body = rawBody;
          }
        }

        this.recordedRequests.push({
          timestamp: Date.now(),
          method,
          url,
          headers: req.headers,
          body,
        });

        // Health / Readiness check
        if (url === "/healthz" || url === "/readyz") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", port }));
          return;
        }

        // Custom handler hook
        if (this.customHandler) {
          const handled = this.customHandler({ method, url, body });
          if (handled) {
            res.writeHead(handled.statusCode ?? 200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(handled.body));
            return;
          }
        }

        // Default OpenAI /chat/completions deterministic response
        if (url.includes("/chat/completions") && method === "POST") {
          const parsedObj =
            body && typeof body === "object" ? (body as Record<string, unknown>) : {};
          const promptText = JSON.stringify(parsedObj.messages ?? []);

          const responseFormat = parsedObj.response_format as
            | { json_schema?: { name?: string } }
            | undefined;
          const schemaName = responseFormat?.json_schema?.name ?? "";

          const parseJsonSection = (label: string): Record<string, unknown> | undefined => {
            const marker = `${label}:`;
            const markerIndex = promptText.indexOf(marker);
            if (markerIndex < 0) return undefined;
            const tail = promptText.slice(markerIndex + marker.length);
            const firstBrace = tail.indexOf("{");
            if (firstBrace < 0) return undefined;
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let index = firstBrace; index < tail.length; index++) {
              const char = tail[index]!;
              if (inString) {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === '"') inString = false;
                continue;
              }
              if (char === '"') inString = true;
              else if (char === "{") depth++;
              else if (char === "}") {
                depth--;
                if (depth === 0) {
                  try {
                    return JSON.parse(tail.slice(firstBrace, index + 1)) as Record<string, unknown>;
                  } catch {
                    return undefined;
                  }
                }
              }
            }
            return undefined;
          };

          let structuredOutput: Record<string, unknown>;
          if (schemaName.includes("opportunity_detection")) {
            structuredOutput = {
              opportunities: [
                {
                  id: "opp_http_001",
                  title: "Inspect Git Working Tree Status",
                  description: "Repeated immutable git status inspection workflow.",
                  taskClass: "vcs",
                  pattern: "vcs_git_status_porcelain",
                  confidenceScore: 0.95,
                  evidence: ["repeated sessions"],
                  priority: "high",
                },
              ],
            };
          } else if (schemaName.includes("candidate_planning")) {
            const classification = parseJsonSection("Classification");
            structuredOutput = {
              planId: "plan_http_001",
              targetToolName:
                (classification?.suggestedToolName as string | undefined) ?? "git_status_checker",
              action: "create",
              summary: "Create a tool from the persisted deterministic opportunity.",
              interfaceChanges: [],
              securityRisks: ["Command execution is restricted to the observed immutable profile."],
              estimatedImpact: "Eliminates a repeated multi-step workflow.",
              suggestedInputs: [],
            };
          } else if (schemaName.includes("schema_generation")) {
            const observedMatch = promptText.match(/Observed Variables:\n(\[[\s\S]*?\])\n/i);
            let observed: Array<Record<string, unknown>> = [];
            if (observedMatch?.[1]) {
              try {
                const parsedObserved = JSON.parse(observedMatch[1]);
                if (Array.isArray(parsedObserved)) observed = parsedObserved;
              } catch {
                observed = [];
              }
            }
            structuredOutput = {
              toolName: "git_status_checker",
              description: "Schema derived only from observed variables.",
              parameters: observed.map((value) => ({
                name: String(value.name ?? "input"),
                type: String(value.type ?? "string"),
                description: String(value.description ?? "Observed input"),
                required: value.required !== false,
              })),
              outputSchema: {
                type: "object",
                description: "Command execution result",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "object" },
                },
                required: ["success"],
              },
            };
          } else if (schemaName.includes("tool_synthesis")) {
            const specification = parseJsonSection("Specification") ?? {};
            const toolName = String(specification.name ?? "generated_tool");
            const description = String(specification.description ?? "Generated tool");
            const steps = Array.isArray(specification.steps)
              ? (specification.steps as Array<Record<string, unknown>>)
              : [];
            const commandStep = steps.find(
              (step) => step.service === "cmd" || String(step.action ?? "").startsWith("cmd."),
            );
            const stepInputs =
              commandStep?.inputs && typeof commandStep.inputs === "object"
                ? (commandStep.inputs as Record<string, unknown>)
                : {};
            const command = String(stepInputs.command ?? "git");
            const args = Array.isArray(stepInputs.args)
              ? stepInputs.args.filter((value): value is string => typeof value === "string")
              : [];
            const code = commandStep
              ? `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";
export const InputSchema = z.object({}).strict();
export const OutputSchema = z.object({ success: z.boolean(), data: z.record(z.unknown()).optional() }).strict();
type ToolInput = z.infer<typeof InputSchema>;
type ToolOutput = z.infer<typeof OutputSchema>;
export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { broker, logger, progress } = context;
  await progress(0, "Starting execution");
  await logger.info("Executing tool", { toolName: ${JSON.stringify(toolName)} });
  const result = await broker.cmd.exec(${JSON.stringify(command)}, ${JSON.stringify(args)});
  if (result.exitCode !== 0) throw new Error(\`Command failed with exit code \${result.exitCode}: \${result.stderr}\`);
  await progress(100, "Execution finished", "complete");
  return { success: true, data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } };
});`
              : `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";
export const InputSchema = z.object({ input: z.unknown().optional() }).strict();
export const OutputSchema = z.object({ success: z.boolean(), data: z.record(z.unknown()).optional() }).strict();
type ToolInput = z.infer<typeof InputSchema>;
type ToolOutput = z.infer<typeof OutputSchema>;
export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  return { success: true, data: { input: context.input.input } };
});`;
            structuredOutput = {
              toolId: `tool_${toolName}`,
              name: toolName,
              version: "1.0.0",
              description,
              schema: specification.inputSchema ?? { type: "object", properties: {} },
              code,
              runtimeRequirements: ["deno:runtime"],
            };
          } else if (schemaName.includes("test_generation")) {
            structuredOutput = {
              suiteId: "suite_http_001",
              targetTool: "generated_tool",
              unitTests: [
                {
                  name: "executes valid input",
                  description: "Validates the generated tool happy path.",
                  code: "Deno.test('executes', () => {});",
                },
              ],
              propertyTests: [],
              edgeCases: ["broker failure"],
            };
          } else if (schemaName.includes("tool_repair")) {
            structuredOutput = {
              toolId: "tool_repaired_http",
              name: "repaired_tool",
              version: "1.0.1",
              code: "",
              fixedIssues: [],
              explanation: "No repair supplied by deterministic HTTP fixture.",
            };
          } else {
            structuredOutput = { status: "success" };
          }

          const assistantContent = JSON.stringify(structuredOutput);

          const responsePayload = {
            id: `chatcmpl-mock-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: parsedObj.model ?? "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: assistantContent,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 128,
              completion_tokens: 64,
              total_tokens: 192,
            },
          };

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responsePayload));
          return;
        }

        // Fallback 404
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found", url }));
      });
    });

    this.server.listen(this._port, "127.0.0.1", () => {
      resolve(this._port);
    });

    this.server.on("error", reject);

    return promise;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const { promise, resolve } = withResolvers<void>();
    this.server.close(() => {
      this.server = null;
      resolve();
    });
    return promise;
  }
}
