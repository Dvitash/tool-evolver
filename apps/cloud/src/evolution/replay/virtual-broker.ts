import { Buffer } from "node:buffer";
import nodePath from "node:path";
import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import type {
  BrokeredFetchResponse,
  CmdBrokerClient,
  FsBrokerClient,
  NetBrokerClient,
  SecretBrokerClient,
  SecretMediationMode,
  SecretReference,
  ToolBrokerClient,
} from "@tool-evolver/runtime";
import { bearerToken, createSecretReference, formatSecretTemplate } from "@tool-evolver/runtime";
import type { ResolvedEvidenceSet } from "../../storage/models/evidence.js";
import type { Episode } from "../opportunity/types.js";
import type { EvidenceSource, ExecutedBrokerOperation, VirtualBrokerState } from "./types.js";

/**
 * Deterministic pseudo-random number generator using Mulberry32 algorithm.
 */
export class DeterministicRandom {
  private state: number;

  constructor(seed: number | string = 42) {
    if (typeof seed === "string") {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
      }
      this.state = h;
    } else {
      this.state = seed >>> 0 || 1;
    }
  }

  /**
   * Returns a deterministic pseudo-random float between 0 (inclusive) and 1 (exclusive).
   */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns a deterministic integer in range [min, max].
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Returns a deterministic UUID v4 string.
   */
  nextUuid(): string {
    const hex = "0123456789abcdef";
    let uuid = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        uuid += "-";
      } else if (i === 14) {
        uuid += "4";
      } else if (i === 19) {
        uuid += hex[this.nextInt(8, 11)];
      } else {
        uuid += hex[this.nextInt(0, 15)];
      }
    }
    return uuid;
  }
}

/**
 * In-memory deterministic Filesystem broker client with operation recording.
 */
export class VirtualFsBroker implements FsBrokerClient {
  private readonly files = new Map<string, string | Uint8Array>();
  private readonly simulateErrors: Record<string, "ENOENT" | "EACCES">;
  private readonly readOnly: boolean;
  private readonly modifiedFiles = new Map<string, string>();
  private readonly trace: ExecutedBrokerOperation[];

  constructor(options: VirtualBrokerState["fs"] = {}, trace: ExecutedBrokerOperation[] = []) {
    this.simulateErrors = options.simulateErrors ?? {};
    this.readOnly = options.readOnly ?? false;
    this.trace = trace;

    if (options.files) {
      for (const [filePath, content] of Object.entries(options.files)) {
        this.files.set(this.normalizePath(filePath), content);
      }
    }

    // Default workspace fixture if empty
    if (this.files.size === 0) {
      this.files.set("/workspace/README.md", "# Workspace Fixture\n");
    }
  }

  private normalizePath(p: string): string {
    const normalized = nodePath.normalize(p.replace(/\\/g, "/"));
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  private recordOp(
    operation: string,
    args: unknown[],
    result?: unknown,
    error?: string,
    durationMs = 1,
  ): void {
    this.trace.push({
      service: "fs",
      operation,
      args,
      result,
      error,
      timestamp: Date.now(),
      durationMs,
    });
  }

  async readFile(
    filePath: string,
    encoding: "utf-8" | "base64" | "buffer" = "utf-8",
  ): Promise<string | Uint8Array> {
    const start = Date.now();
    const normalized = this.normalizePath(filePath);

    if (
      this.simulateErrors[normalized] === "ENOENT" ||
      this.simulateErrors[filePath] === "ENOENT"
    ) {
      const err = `ENOENT: no such file or directory, open '${filePath}'`;
      this.recordOp("readFile", [filePath, encoding], undefined, err, Date.now() - start);
      throw new Error(err);
    }
    if (
      this.simulateErrors[normalized] === "EACCES" ||
      this.simulateErrors[filePath] === "EACCES"
    ) {
      const err = `EACCES: permission denied, open '${filePath}'`;
      this.recordOp("readFile", [filePath, encoding], undefined, err, Date.now() - start);
      throw new Error(err);
    }

    const content = this.files.get(normalized);
    if (content === undefined) {
      const err = `ENOENT: no such file or directory, open '${filePath}'`;
      this.recordOp("readFile", [filePath, encoding], undefined, err, Date.now() - start);
      throw new Error(err);
    }

    let result: string | Uint8Array;
    if (encoding === "buffer") {
      result = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    } else if (encoding === "base64") {
      result =
        typeof content === "string"
          ? Buffer.from(content, "utf-8").toString("base64")
          : Buffer.from(content).toString("base64");
    } else {
      result = typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
    }

    this.recordOp("readFile", [filePath, encoding], result, undefined, Date.now() - start);
    return result;
  }

  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    const start = Date.now();
    const normalized = this.normalizePath(filePath);

    if (this.readOnly) {
      const err = `EROFS: read-only file system, open '${filePath}'`;
      this.recordOp(
        "writeFile",
        [filePath, typeof content === "string" ? content.slice(0, 100) : "[binary]"],
        undefined,
        err,
        Date.now() - start,
      );
      throw new Error(err);
    }
    if (
      this.simulateErrors[normalized] === "EACCES" ||
      this.simulateErrors[filePath] === "EACCES"
    ) {
      const err = `EACCES: permission denied, open '${filePath}'`;
      this.recordOp(
        "writeFile",
        [filePath, typeof content === "string" ? content.slice(0, 100) : "[binary]"],
        undefined,
        err,
        Date.now() - start,
      );
      throw new Error(err);
    }

    const stringContent =
      typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
    this.files.set(normalized, content);
    this.modifiedFiles.set(normalized, stringContent);

    this.recordOp(
      "writeFile",
      [filePath, typeof content === "string" ? content.slice(0, 100) : "[binary]"],
      { written: true },
      undefined,
      Date.now() - start,
    );
  }

  async exists(filePath: string): Promise<boolean> {
    const start = Date.now();
    const normalized = this.normalizePath(filePath);
    if (
      this.simulateErrors[normalized] === "ENOENT" ||
      this.simulateErrors[filePath] === "ENOENT"
    ) {
      this.recordOp("exists", [filePath], false, undefined, Date.now() - start);
      return false;
    }
    const res = this.files.has(normalized);
    this.recordOp("exists", [filePath], res, undefined, Date.now() - start);
    return res;
  }

  async listDir(dirPath = "/workspace"): Promise<string[]> {
    const start = Date.now();
    const normalized = this.normalizePath(dirPath);
    const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
    const entries = new Set<string>();

    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const relative = key.slice(prefix.length);
        const segment = relative.split("/")[0];
        if (segment) entries.add(segment);
      }
    }

    const result = Array.from(entries);
    this.recordOp("listDir", [dirPath], result, undefined, Date.now() - start);
    return result;
  }

  async stat(
    targetPath: string,
  ): Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtime: string }> {
    const start = Date.now();
    const normalized = this.normalizePath(targetPath);

    if (this.files.has(normalized)) {
      const content = this.files.get(normalized)!;
      const size = typeof content === "string" ? Buffer.byteLength(content) : content.length;
      const statRes = {
        size,
        isFile: true,
        isDirectory: false,
        mtime: new Date().toISOString(),
      };
      this.recordOp("stat", [targetPath], statRes, undefined, Date.now() - start);
      return statRes;
    }

    const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
    const isDir = Array.from(this.files.keys()).some((k) => k.startsWith(prefix));
    if (isDir) {
      const statRes = {
        size: 0,
        isFile: false,
        isDirectory: true,
        mtime: new Date().toISOString(),
      };
      this.recordOp("stat", [targetPath], statRes, undefined, Date.now() - start);
      return statRes;
    }

    const err = `ENOENT: no such file or directory, stat '${targetPath}'`;
    this.recordOp("stat", [targetPath], undefined, err, Date.now() - start);
    throw new Error(err);
  }

  async removeFile(filePath: string): Promise<void> {
    const start = Date.now();
    const normalized = this.normalizePath(filePath);
    if (this.readOnly) {
      const err = `EROFS: read-only file system, unlink '${filePath}'`;
      this.recordOp("removeFile", [filePath], undefined, err, Date.now() - start);
      throw new Error(err);
    }
    this.files.delete(normalized);
    this.modifiedFiles.set(normalized, "[DELETED]");
    this.recordOp("removeFile", [filePath], { removed: true }, undefined, Date.now() - start);
  }

  getModifiedFiles(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.modifiedFiles.entries()) {
      result[k] = v;
    }
    return result;
  }

  getAllFiles(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.files.entries()) {
      result[k] = typeof v === "string" ? v : Buffer.from(v).toString("utf-8");
    }
    return result;
  }
}

/**
 * In-memory deterministic Network broker client with operation recording.
 */
export class VirtualNetBroker implements NetBrokerClient {
  private readonly routes: Record<
    string,
    { status: number; body: unknown; headers?: Record<string, string> }
  >;
  private readonly simulateTimeout: boolean;
  private readonly simulateNetworkError: boolean;
  private readonly networkRequests: Array<{ url: string; method: string }> = [];
  private readonly trace: ExecutedBrokerOperation[];

  constructor(options: VirtualBrokerState["net"] = {}, trace: ExecutedBrokerOperation[] = []) {
    this.routes = options.routes ?? {};
    this.simulateTimeout = options.simulateTimeout ?? false;
    this.simulateNetworkError = options.simulateNetworkError ?? false;
    this.trace = trace;
  }

  private recordOp(
    operation: string,
    args: unknown[],
    result?: unknown,
    error?: string,
    durationMs = 1,
  ): void {
    this.trace.push({
      service: "net",
      operation,
      args,
      result,
      error,
      timestamp: Date.now(),
      durationMs,
    });
  }

  async fetch(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<BrokeredFetchResponse> {
    const start = Date.now();
    const method = init?.method?.toUpperCase() ?? "GET";
    this.networkRequests.push({ url, method });

    if (this.simulateTimeout) {
      const err = `ETIMEDOUT: Network request to '${url}' timed out`;
      this.recordOp("fetch", [url, init], undefined, err, Date.now() - start);
      throw new Error(err);
    }
    if (this.simulateNetworkError) {
      const err = `ECONNREFUSED: Connection refused for '${url}'`;
      this.recordOp("fetch", [url, init], undefined, err, Date.now() - start);
      throw new Error(err);
    }

    // Match exact URL, or URL path pattern
    let matchedResponse = this.routes[url];
    if (!matchedResponse) {
      try {
        const parsed = new URL(url);
        matchedResponse = this.routes[parsed.pathname] ?? this.routes[parsed.host];
        if (!matchedResponse) {
          // Check prefix or wildcard routes
          for (const [routePattern, routeResp] of Object.entries(this.routes)) {
            if (url.includes(routePattern) || parsed.pathname.startsWith(routePattern)) {
              matchedResponse = routeResp;
              break;
            }
          }
        }
      } catch {
        // Not a standard URL, try string search
        for (const [routePattern, routeResp] of Object.entries(this.routes)) {
          if (url.includes(routePattern)) {
            matchedResponse = routeResp;
            break;
          }
        }
      }
    }

    const responseData = matchedResponse ?? {
      status: 200,
      body: { status: "ok", mock: true, url, method },
      headers: { "content-type": "application/json" },
    };

    const status = responseData.status;
    const headers = responseData.headers ?? { "content-type": "application/json" };
    const bodyObj = responseData.body;
    const bodyStr = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);

    const brokeredResponse: BrokeredFetchResponse = {
      status,
      statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : "Error",
      headers,
      ok: status >= 200 && status < 300,
      url,
      redirected: false,
      text: async () => bodyStr,
      json: async <T = unknown>() => {
        if (typeof bodyObj === "object" && bodyObj !== null) return bodyObj as T;
        return JSON.parse(bodyStr) as T;
      },
      arrayBuffer: async () => Buffer.from(bodyStr).buffer as ArrayBuffer,
      bytes: async () => new Uint8Array(Buffer.from(bodyStr)),
    };

    this.recordOp(
      "fetch",
      [url, init],
      { status, ok: brokeredResponse.ok },
      undefined,
      Date.now() - start,
    );
    return brokeredResponse;
  }

  getNetworkRequests(): Array<{ url: string; method: string }> {
    return [...this.networkRequests];
  }
}

/**
 * In-memory deterministic Command execution broker client with operation recording.
 */
export class VirtualCmdBroker implements CmdBrokerClient {
  private readonly commands: Record<
    string,
    { stdout?: string; stderr?: string; exitCode?: number }
  >;
  private readonly simulateFailure: boolean;
  private readonly executedCommands: string[] = [];
  private readonly trace: ExecutedBrokerOperation[];

  constructor(options: VirtualBrokerState["cmd"] = {}, trace: ExecutedBrokerOperation[] = []) {
    this.commands = options.commands ?? {};
    this.simulateFailure = options.simulateFailure ?? false;
    this.trace = trace;
  }

  private recordOp(
    operation: string,
    args: unknown[],
    result?: unknown,
    error?: string,
    durationMs = 1,
  ): void {
    this.trace.push({
      service: "cmd",
      operation,
      args,
      result,
      error,
      timestamp: Date.now(),
      durationMs,
    });
  }

  async exec(
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const start = Date.now();
    const fullCmd = [command, ...args].join(" ").trim();
    this.executedCommands.push(fullCmd);

    if (this.simulateFailure) {
      const failRes = {
        exitCode: 1,
        stdout: "",
        stderr: `Command '${command}' failed with exit code 1`,
      };
      this.recordOp("exec", [command, args, options], failRes, undefined, Date.now() - start);
      return failRes;
    }

    // Match exact command string or base command
    let matched = this.commands[fullCmd] ?? this.commands[command];
    if (!matched) {
      for (const [cmdKey, outcome] of Object.entries(this.commands)) {
        if (fullCmd.includes(cmdKey) || command === cmdKey) {
          matched = outcome;
          break;
        }
      }
    }

    const exitCode = matched?.exitCode ?? 0;
    const stdout = matched?.stdout ?? `Mock command execution output for: ${fullCmd}\n`;
    const stderr = matched?.stderr ?? "";

    const result = { exitCode, stdout, stderr };
    this.recordOp("exec", [command, args, options], result, undefined, Date.now() - start);
    return result;
  }

  getExecutedCommands(): string[] {
    return [...this.executedCommands];
  }
}

/**
 * In-memory deterministic Secret broker client with operation recording.
 */
export class VirtualSecretBroker implements SecretBrokerClient {
  private readonly secrets: Record<string, string>;
  private readonly denyAccess: boolean;
  private readonly trace: ExecutedBrokerOperation[];

  constructor(options: VirtualBrokerState["secrets"] = {}, trace: ExecutedBrokerOperation[] = []) {
    this.secrets = options.values ?? {};
    this.denyAccess = options.denyAccess ?? false;
    this.trace = trace;
  }

  private recordOp(
    operation: string,
    args: unknown[],
    result?: unknown,
    error?: string,
    durationMs = 1,
  ): void {
    this.trace.push({
      service: "secret",
      operation,
      args,
      result,
      error,
      timestamp: Date.now(),
      durationMs,
    });
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
    this.recordOp("createReference", [name, options], `sec_ref_${name}`);
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
    const start = Date.now();
    if (this.denyAccess) {
      this.recordOp("getSecret", [name], null, undefined, Date.now() - start);
      return null;
    }
    const val = this.secrets[name] ?? `mock_secret_${name}`;
    this.recordOp("getSecret", [name], val ? "[REDACTED]" : null, undefined, Date.now() - start);
    return val;
  }
}

/**
 * Unified virtual broker client with execution tracing.
 */
export class VirtualToolBrokerClient implements ToolBrokerClient {
  readonly fs: VirtualFsBroker;
  readonly net: VirtualNetBroker;
  readonly cmd: VirtualCmdBroker;
  readonly secret: VirtualSecretBroker;
  readonly trace: ExecutedBrokerOperation[] = [];

  constructor(state: VirtualBrokerState = {}) {
    this.fs = new VirtualFsBroker(state.fs, this.trace);
    this.net = new VirtualNetBroker(state.net, this.trace);
    this.cmd = new VirtualCmdBroker(state.cmd, this.trace);
    this.secret = new VirtualSecretBroker(state.secrets, this.trace);
  }

  async request<T = unknown>(
    service: "fs" | "net" | "cmd" | "secret",
    operation: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    switch (service) {
      case "fs": {
        if (operation === "readFile") {
          return (await this.fs.readFile(String(params.path), params.encoding as "utf-8")) as T;
        }
        if (operation === "writeFile") {
          return (await this.fs.writeFile(String(params.path), params.content as string)) as T;
        }
        if (operation === "exists") {
          return (await this.fs.exists(String(params.path))) as T;
        }
        if (operation === "listDir") {
          return (await this.fs.listDir(params.path as string)) as T;
        }
        if (operation === "stat") {
          return (await this.fs.stat(String(params.path))) as T;
        }
        if (operation === "removeFile") {
          return (await this.fs.removeFile(String(params.path))) as T;
        }
        throw new Error(`Unsupported fs operation '${operation}' in virtual broker`);
      }
      case "net": {
        if (operation === "fetch") {
          return (await this.net.fetch(
            String(params.url),
            params.init as Record<string, unknown>,
          )) as T;
        }
        throw new Error(`Unsupported net operation '${operation}' in virtual broker`);
      }
      case "cmd": {
        if (operation === "exec") {
          return (await this.cmd.exec(
            String(params.command),
            params.args as string[],
            params.options as Record<string, unknown>,
          )) as T;
        }
        throw new Error(`Unsupported cmd operation '${operation}' in virtual broker`);
      }
      case "secret": {
        if (operation === "getSecret") {
          return (await this.secret.getSecret(String(params.name))) as T;
        }
        throw new Error(`Unsupported secret operation '${operation}' in virtual broker`);
      }
      default:
        throw new Error(`Unknown service '${service}' in virtual broker`);
    }
  }

  getStateSnapshot(): {
    modifiedFiles: Record<string, string>;
    networkRequests: Array<{ url: string; method: string }>;
    executedCommands: string[];
  } {
    return {
      modifiedFiles: this.fs.getModifiedFiles(),
      networkRequests: this.net.getNetworkRequests(),
      executedCommands: this.cmd.getExecutedCommands(),
    };
  }
}

/**
 * Reconstructs virtual broker state from historical evidence events and episodes.
 */
export class VirtualBrokerReconstructor {
  /**
   * Unifies and extracts normalized session events from various evidence sources.
   */
  static extractEvents(evidence: EvidenceSource): NormalizedSessionEvent[] {
    if (Array.isArray(evidence)) {
      if (evidence.length === 0) return [];
      if ("events" in evidence[0] && Array.isArray((evidence[0] as Episode).events)) {
        return (evidence as Episode[]).flatMap((ep) => ep.events);
      }
      return evidence as NormalizedSessionEvent[];
    }

    if ("events" in evidence && Array.isArray(evidence.events)) {
      // Could be ResolvedEvidenceSet or Episode
      const first = evidence.events[0];
      if (!first) return [];
      if ("payload" in first && "eventType" in first) {
        // NormalizedEventEntity[] -> reconstruct NormalizedSessionEvent[]
        return (
          evidence.events as unknown as Array<{
            id: string;
            sessionId: string;
            eventType: string;
            timestamp: string;
            schemaVersion: string;
            payload: Record<string, unknown>;
            causalSequence?: number;
          }>
        ).map((ent) => {
          if (ent.payload && typeof ent.payload === "object" && "type" in ent.payload) {
            return ent.payload as unknown as NormalizedSessionEvent;
          }
          return {
            eventId: ent.id,
            sessionId: ent.sessionId,
            type: ent.eventType,
            timestamp: ent.timestamp,
            schemaVersion: ent.schemaVersion ?? "0.1.0",
            causalRef: { sequenceNumber: ent.causalSequence ?? 0 },
            redaction: { isRedacted: false, rulesApplied: [] },
            ...ent.payload,
          } as unknown as NormalizedSessionEvent;
        });
      }
      return evidence.events as NormalizedSessionEvent[];
    }

    return [];
  }

  /**
   * Constructs virtual broker state by analyzing observed events.
   */
  static buildFromEvents(events: NormalizedSessionEvent[]): VirtualBrokerState {
    const files: Record<string, string> = {};
    const routes: Record<
      string,
      { status: number; body: unknown; headers?: Record<string, string> }
    > = {};
    const commands: Record<string, { stdout?: string; stderr?: string; exitCode?: number }> = {};
    const secrets: Record<string, string> = {};

    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;

      // Handle file edit events
      if (ev.type === "file_edit") {
        const fd = ev as unknown as { filePath?: string; patch?: string };
        if (fd.filePath) {
          files[fd.filePath] = fd.patch ?? "// Synthesized file content\n";
        }
      }

      // Handle command execution events
      if (ev.type === "command_exec") {
        const ce = ev as unknown as {
          command?: string;
          args?: string[];
          stdout?: string;
          stderr?: string;
          exitCode?: number;
        };
        if (ce.command) {
          const full = [ce.command, ...(ce.args ?? [])].join(" ").trim();
          commands[full] = {
            stdout: ce.stdout ?? "",
            stderr: ce.stderr ?? "",
            exitCode: ce.exitCode ?? 0,
          };
          commands[ce.command] = commands[full];
        }
      }

      // Handle tool call & tool result pairs
      if (ev.type === "tool_call") {
        const tc = ev as unknown as { toolName?: string; parameters?: Record<string, unknown> };
        const params = tc.parameters ?? {};

        // Extract observed file paths
        const pathVal = params.path ?? params.filePath ?? params.file ?? params.targetPath;
        if (typeof pathVal === "string" && pathVal.length > 0) {
          if (!files[pathVal]) {
            const initialContent =
              typeof params.content === "string"
                ? params.content
                : `// File content for ${pathVal}\n`;
            files[pathVal] = initialContent;
          }
        }

        // Extract observed URLs
        const urlVal = params.url ?? params.targetUrl ?? params.uri;
        if (typeof urlVal === "string" && urlVal.length > 0) {
          if (!routes[urlVal]) {
            routes[urlVal] = {
              status: 200,
              body: { status: "ok", result: `Observed response for ${urlVal}` },
              headers: { "content-type": "application/json" },
            };
          }
        }

        // Extract observed commands
        const cmdVal = params.command ?? params.cmd;
        if (typeof cmdVal === "string" && cmdVal.length > 0) {
          if (!commands[cmdVal]) {
            commands[cmdVal] = {
              stdout: `Command output for ${cmdVal}\n`,
              stderr: "",
              exitCode: 0,
            };
          }
        }
      }

      if (ev.type === "tool_result") {
        const tr = ev as unknown as { toolName?: string; result?: unknown; isError?: boolean };
        const toolName = tr.toolName?.toLowerCase() ?? "";
        // If it was a read tool and result is a string, update file content
        if (
          (toolName.includes("read") || toolName.includes("cat")) &&
          typeof tr.result === "string"
        ) {
          // Keep existing content
        }
      }
    }

    return {
      fs: {
        files,
        readOnly: false,
      },
      net: {
        routes,
      },
      cmd: {
        commands,
      },
      secrets: {
        values: secrets,
      },
    };
  }

  /**
   * Constructs virtual broker state from an Episode.
   */
  static buildFromEpisode(episode: Episode): VirtualBrokerState {
    return VirtualBrokerReconstructor.buildFromEvents(episode.events);
  }

  /**
   * Constructs virtual broker state from a ResolvedEvidenceSet.
   */
  static buildFromEvidenceSet(evidenceSet: ResolvedEvidenceSet): VirtualBrokerState {
    const events = VirtualBrokerReconstructor.extractEvents(evidenceSet);
    return VirtualBrokerReconstructor.buildFromEvents(events);
  }

  /**
   * Factory creating a VirtualToolBrokerClient for execution.
   */
  static createClient(state: VirtualBrokerState = {}): VirtualToolBrokerClient {
    return new VirtualToolBrokerClient(state);
  }
}
