import type { WorkerMessageType } from "./protocol.js";

/**
 * Brokered file system client interface.
 */
export interface FsBrokerClient {
  readFile(
    filePath: string,
    encoding?: "utf-8" | "base64" | "buffer",
  ): Promise<string | Uint8Array>;
  writeFile(filePath: string, content: string | Uint8Array): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  listDir(dirPath?: string): Promise<string[]>;
  stat(
    targetPath: string,
  ): Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtime: string }>;
  removeFile(filePath: string): Promise<void>;
}

/**
 * Brokered HTTP fetch response wrapper.
 */
export interface BrokeredFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  ok?: boolean;
  url?: string;
  redirected?: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  bytes?(): Promise<Uint8Array>;
}

/**
 * Brokered network client interface.
 */
export interface NetBrokerClient {
  fetch(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<BrokeredFetchResponse>;
}

/**
 * Brokered command execution client interface.
 */
export interface CmdBrokerClient {
  exec(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Brokered secret and credential client interface.
 */
export interface SecretBrokerClient {
  getSecret(name: string): Promise<string | null>;
}

/**
 * Unified tool broker client interface.
 */
export interface ToolBrokerClient {
  fs: FsBrokerClient;
  net: NetBrokerClient;
  cmd: CmdBrokerClient;
  secret: SecretBrokerClient;
  request<T = unknown>(
    service: "fs" | "net" | "cmd" | "secret",
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<T>;
}

/**
 * Tool logger interface.
 */
export interface ToolLogger {
  debug(message: string, data?: unknown): Promise<void>;
  info(message: string, data?: unknown): Promise<void>;
  warn(message: string, data?: unknown): Promise<void>;
  error(message: string, data?: unknown): Promise<void>;
}

/**
 * Execution context passed to generated tool entrypoints.
 */
export interface ToolContext<TInput = unknown> {
  readonly input: TInput;
  readonly invocationId: string;
  readonly workspaceRoot: string;
  readonly scratchDir: string;
  readonly metadata: Record<string, unknown>;

  progress(percentage: number, message?: string, stage?: string): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): Promise<void>;
  readonly logger: ToolLogger;
  readonly broker: ToolBrokerClient;
  readonly fs?: FsBrokerClient;
  readonly net?: NetBrokerClient;
  readonly cmd?: CmdBrokerClient;
  readonly secret?: SecretBrokerClient;
}

/**
 * Tool entrypoint function signature.
 */
export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  context: ToolContext<TInput>,
) => Promise<TOutput> | TOutput;

/**
 * Helper to define and type a tool execution handler.
 */
export function defineTool<TInput = unknown, TOutput = unknown>(
  handler: ToolHandler<TInput, TOutput>,
): ToolHandler<TInput, TOutput> {
  return handler;
}

export type BrokerRequestHandlerFn = (
  service: "fs" | "net" | "cmd" | "secret",
  action: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

export interface ToolContextOptions<TInput = unknown> {
  input: TInput;
  invocationId: string;
  workspaceRoot?: string;
  scratchDir?: string;
  metadata?: Record<string, unknown>;
  onProgress?: (percentage: number, message?: string, stage?: string) => void | Promise<void>;
  onLog?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ) => void | Promise<void>;
  brokerHandler: BrokerRequestHandlerFn;
}

/**
 * Concrete implementation of ToolBrokerClient backed by a request handler function.
 */
export class DefaultToolBrokerClient implements ToolBrokerClient {
  constructor(private readonly handler: BrokerRequestHandlerFn) {}

  async request<T = unknown>(
    service: "fs" | "net" | "cmd" | "secret",
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    return (await this.handler(service, action, payload)) as T;
  }

  readonly fs: FsBrokerClient = {
    readFile: async (filePath: string, encoding: "utf-8" | "base64" | "buffer" = "utf-8") => {
      const res = await this.request<{ content: string; encoding: string }>("fs", "readFile", {
        path: filePath,
        encoding,
      });
      if (encoding === "buffer") {
        return typeof Buffer !== "undefined"
          ? Buffer.from(res.content, "base64")
          : new TextEncoder().encode(res.content);
      }
      return res.content;
    },
    writeFile: async (filePath: string, content: string | Uint8Array) => {
      const serialized =
        typeof content === "string"
          ? content
          : typeof Buffer !== "undefined"
            ? Buffer.from(content).toString("base64")
            : btoa(String.fromCharCode(...content));
      const encoding = typeof content === "string" ? "utf-8" : "base64";
      await this.request("fs", "writeFile", { path: filePath, content: serialized, encoding });
    },
    exists: async (filePath: string) => {
      const res = await this.request<{ exists: boolean }>("fs", "exists", { path: filePath });
      return res.exists;
    },
    listDir: async (dirPath = ".") => {
      const res = await this.request<{ entries: string[] }>("fs", "listDir", { path: dirPath });
      return res.entries;
    },
    stat: async (targetPath: string) => {
      return await this.request<{
        size: number;
        isFile: boolean;
        isDirectory: boolean;
        mtime: string;
      }>("fs", "stat", { path: targetPath });
    },
    removeFile: async (filePath: string) => {
      await this.request("fs", "removeFile", { path: filePath });
    },
  };

  readonly net: NetBrokerClient = {
    fetch: async (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      const res = await this.request<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: string;
      }>("net", "fetch", { url, ...init });

      return {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        text: async () => res.body,
        json: async <T = unknown>() => JSON.parse(res.body) as T,
      };
    },
  };

  readonly cmd: CmdBrokerClient = {
    exec: async (
      command: string,
      args: string[] = [],
      options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
    ) => {
      return await this.request<{ exitCode: number; stdout: string; stderr: string }>(
        "cmd",
        "exec",
        {
          command,
          args,
          ...options,
        },
      );
    },
  };

  readonly secret: SecretBrokerClient = {
    getSecret: async (name: string) => {
      const res = await this.request<{ secret: string | null }>("secret", "getSecret", { name });
      return res.secret;
    },
  };
}

/**
 * Creates a fully functional ToolContext instance.
 */
export function createToolContext<TInput = unknown>(
  options: ToolContextOptions<TInput>,
): ToolContext<TInput> {
  const brokerClient = new DefaultToolBrokerClient(options.brokerHandler);

  const logFn = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ) => {
    if (options.onLog) {
      await options.onLog(level, message, data);
    }
  };

  const progressFn = async (percentage: number, message?: string, stage?: string) => {
    if (options.onProgress) {
      await options.onProgress(percentage, message, stage);
    }
  };

  const logger: ToolLogger = {
    debug: (msg, data) => logFn("debug", msg, data),
    info: (msg, data) => logFn("info", msg, data),
    warn: (msg, data) => logFn("warn", msg, data),
    error: (msg, data) => logFn("error", msg, data),
  };

  return {
    input: options.input,
    invocationId: options.invocationId,
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    scratchDir: options.scratchDir ?? "",
    metadata: options.metadata ?? {},
    progress: progressFn,
    log: logFn,
    logger,
    broker: brokerClient,
    fs: brokerClient.fs,
    net: brokerClient.net,
    cmd: brokerClient.cmd,
    secret: brokerClient.secret,
  };
}
