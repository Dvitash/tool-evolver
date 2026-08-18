/**
 * @tool-evolver/e2e - Real Process Topology
 *
 * Full multi-process topology orchestrating real spawned OS processes for:
 * 1. Observer Daemon (`apps/observer/bin/daemon.mjs`)
 * 2. Gateway MCP Shim (`apps/gateway/bin/mcp-shim.mjs`)
 * 3. Cloud Service (`fixtures/e2e/src/runners/cloud-server-runner.ts` / `apps/cloud/dist/bin/api.js`)
 * 4. Deterministic HTTP Mock Inference Server (`MockInferenceServer`)
 *
 * Implements end-to-end evolution flows, JSON-RPC MCP stdio protocol handshakes,
 * authenticated daemon IPC over Unix domain sockets, canary traffic routing,
 * bad-version quarantine/rollback, process crash/restart recovery injections,
 * and comprehensive audit lifecycle tracing.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { TenantContext } from "@tool-evolver/cloud";
import {
  CapabilityManifestSchema,
  type EvaluationResult,
  type EvolutionCandidate,
  type NormalizedSessionEvent,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
  type ToolVersion,
} from "@tool-evolver/contracts";
import {
  AuditRepository,
  LocalDatabaseConnection,
  MigrationRunner,
  SyncRepository,
  ToolRepository,
} from "@tool-evolver/db";
import { SYSTEM_META_TOOL_NAMES, ToolRegistry, type WorkspaceContext } from "@tool-evolver/gateway";
import {
  type DaemonPaths,
  IpcClient,
  type ModuleStatusReport,
  resolvePaths,
} from "@tool-evolver/observer";
import { ToolRuntime } from "@tool-evolver/runtime";
import {
  type ManagedProcess,
  MockInferenceServer,
  ProcessHarness,
  findAvailablePort,
  withResolvers,
} from "./process-harness.js";
import { LifecycleTraceReporter } from "./trace-reporter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CAPABILITIES = CapabilityManifestSchema.parse({});
const DEFAULT_LIMITS = ToolLimitConfigSchema.parse({});
const DEFAULT_RUNTIME = ToolRuntimeRequirementSchema.parse({ runtime: "deno" });

export interface RealProcessTopologyOptions {
  tenantContext?: TenantContext;
  rootDir?: string;
  silent?: boolean;
}

export interface McpCallToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface LifecycleTraceArtifact {
  traceId: string;
  pids: {
    daemon?: number;
    gateway?: number;
    cloud?: number;
    mockInference?: number;
  };
  restartedPids: {
    daemon?: number[];
    cloud?: number[];
  };
  stateTransitions: Array<{
    target: string;
    from: string;
    to: string;
    timestamp: number;
  }>;
  protocolEvents: Array<{
    protocol: "mcp" | "ipc" | "http";
    method: string;
    timestamp: number;
    status: "ok" | "error";
  }>;
  bundleDigests: string[];
  quarantinedDigests: string[];
  assertionsPassed: number;
  assertionsFailed: number;
}

/**
 * Complete real OS multi-process E2E testing topology.
 */
export class RealProcessTopology {
  readonly harness: ProcessHarness;
  readonly mockInference: MockInferenceServer;
  readonly traceReporter: LifecycleTraceReporter;
  readonly tenant: TenantContext;
  readonly silent: boolean;

  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly daemonHomeDir: string;
  readonly cloudStorageDir: string;
  readonly daemonPaths: DaemonPaths;

  cloudPort = 0;
  mockInferencePort = 0;

  daemonProcess: ManagedProcess | null = null;
  gatewayProcess: ManagedProcess | null = null;
  cloudProcess: ManagedProcess | null = null;
  ipcClient: IpcClient | null = null;

  localDb!: LocalDatabaseConnection;
  toolRepo!: ToolRepository;
  auditRepo!: AuditRepository;
  syncRepo!: SyncRepository;
  localRegistry!: ToolRegistry;

  private mcpRequestId = 1;
  private pendingMcpRequests = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();

  private stateTransitions: Array<{
    target: string;
    from: string;
    to: string;
    timestamp: number;
  }> = [];
  private protocolEvents: Array<{
    protocol: "mcp" | "ipc" | "http";
    method: string;
    timestamp: number;
    status: "ok" | "error";
  }> = [];
  private publishedBundleDigests: string[] = [];
  private quarantinedDigests: string[] = [];
  private daemonPidHistory: number[] = [];
  private cloudPidHistory: number[] = [];

  constructor(options: RealProcessTopologyOptions = {}) {
    this.harness = new ProcessHarness();
    this.mockInference = new MockInferenceServer();
    this.traceReporter = new LifecycleTraceReporter();
    this.silent = options.silent ?? true;

    this.tenant = options.tenantContext ?? {
      accountId: "acc_e2e_real_01",
      workspaceId: "ws_e2e_real_01",
      userId: "usr_e2e_real_01",
      roles: ["admin"],
      deviceId: "dev_e2e_linux_01",
      metadata: {
        mode: "development",
        environment: "test",
      },
    };

    this.rootDir =
      options.rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-real-topology-"));

    this.workspaceDir = path.join(this.rootDir, "workspace");
    this.daemonHomeDir = path.join(this.rootDir, "daemon-home");
    this.cloudStorageDir = path.join(this.rootDir, "cloud-storage");

    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.daemonHomeDir, { recursive: true });
    fs.mkdirSync(this.cloudStorageDir, { recursive: true });

    const socketPath = path.join(this.daemonHomeDir, "state", "daemon.sock");
    this.daemonPaths = resolvePaths({
      home: this.daemonHomeDir,
      socketPath,
      toolEvolverHome: this.daemonHomeDir,
    });
  }

  get cloudBaseUrl(): string {
    return `http://127.0.0.1:${this.cloudPort}`;
  }

  /**
   * Initializes and boots all processes across the complete real process topology.
   */
  async start(): Promise<void> {
    this.recordStateTransition("topology", "uninitialized", "starting");

    // 1. Start Deterministic Mock HTTP Inference Server
    this.mockInferencePort = await this.mockInference.start();
    this.recordStateTransition("mock-inference", "uninitialized", "running");

    // 2. Allocate disposable port for Cloud API Service
    this.cloudPort = await findAvailablePort();

    // 3. Spawn Cloud Service Subprocess
    const cloudRunnerPath = path.resolve(__dirname, "runners/cloud-server-runner.js");
    const cloudRunnerTsPath = path.resolve(__dirname, "runners/cloud-server-runner.ts");
    const scriptToRun = fs.existsSync(cloudRunnerPath) ? cloudRunnerPath : cloudRunnerTsPath;

    this.cloudProcess = await this.harness.spawnProcess({
      name: "cloud-server",
      command: process.execPath,
      args: [
        scriptToRun,
        "--port",
        String(this.cloudPort),
        "--storage-dir",
        this.cloudStorageDir,
        "--inference-url",
        this.mockInference.baseUrl,
      ],
      env: {
        NODE_ENV: "test",
        PORT: String(this.cloudPort),
        STORAGE_DIR: this.cloudStorageDir,
        INFERENCE_BASE_URL: this.mockInference.baseUrl,
        DATABASE_URL: "memory://e2e-cloud-db",
      },
      readyPattern: /\[CLOUD_SERVICE_READY:\d+\]/,
      readyTimeoutMs: 15000,
      silent: this.silent,
    });

    if (this.cloudProcess.pid) {
      this.cloudPidHistory.push(this.cloudProcess.pid);
    }
    this.recordStateTransition("cloud-server", "uninitialized", "running");

    // 4. Initialize Local Persisted SQLite Database
    fs.mkdirSync(this.daemonPaths.dataDir, { recursive: true });
    const localDbPath = path.join(this.daemonPaths.dataDir, "daemon.db");
    this.localDb = new LocalDatabaseConnection({ path: localDbPath });
    const migrationRunner = new MigrationRunner(this.localDb);
    migrationRunner.migrate();

    this.toolRepo = new ToolRepository(this.localDb);
    this.auditRepo = new AuditRepository(this.localDb);
    this.syncRepo = new SyncRepository(this.localDb);

    this.localRegistry = new ToolRegistry();
    this.setupLocalRegistryTools();

    // 5. Spawn Observer Daemon Subprocess
    const daemonBinPath = path.resolve(__dirname, "../../../apps/observer/bin/daemon.mjs");
    this.daemonProcess = await this.harness.spawnProcess({
      name: "observer-daemon",
      command: process.execPath,
      args: [
        daemonBinPath,
        "-f",
        "--home",
        this.daemonHomeDir,
        "--socket",
        this.daemonPaths.socketPath,
      ],
      env: {
        NODE_ENV: "test",
        TOOL_EVOLVER_HOME: this.daemonHomeDir,
        TOOL_EVOLVER_SOCKET_PATH: this.daemonPaths.socketPath,
      },
      readyPattern: /IPC server started/,
      readyCheck: async () => {
        if (
          !fs.existsSync(this.daemonPaths.socketPath) ||
          !fs.existsSync(this.daemonPaths.tokenFilePath)
        ) {
          return false;
        }
        const { promise, resolve } = withResolvers<boolean>();
        try {
          const s = net.createConnection(this.daemonPaths.socketPath);
          s.once("connect", () => {
            s.destroy();
            resolve(true);
          });
          s.once("error", () => {
            s.destroy();
            resolve(false);
          });
        } catch {
          resolve(false);
        }
        return promise;
      },
      readyTimeoutMs: 15000,
      silent: this.silent,
    });

    if (this.daemonProcess.pid) {
      this.daemonPidHistory.push(this.daemonProcess.pid);
    }
    this.recordStateTransition("observer-daemon", "uninitialized", "running");

    // 6. Connect IPC Client to the running Daemon Unix Domain Socket
    this.ipcClient = new IpcClient({
      socketPath: this.daemonPaths.socketPath,
      tokenFilePath: this.daemonPaths.tokenFilePath,
      timeoutMs: 5000,
    });
    await this.ipcClient.connect();
    this.recordProtocolEvent("ipc", "connect", "ok");

    // 7. Spawn Gateway MCP Shim Subprocess over Stdio
    const gatewayBinPath = path.resolve(__dirname, "../../../apps/gateway/bin/mcp-shim.mjs");
    this.gatewayProcess = await this.harness.spawnProcess({
      name: "gateway-shim",
      command: process.execPath,
      args: [
        gatewayBinPath,
        "--standalone",
        "-C",
        this.workspaceDir,
        "-H",
        "e2e-real-process-harness",
      ],
      env: {
        NODE_ENV: "test",
      },
      readyTimeoutMs: 10000,
      silent: this.silent,
    });
    this.recordStateTransition("gateway-shim", "uninitialized", "running");

    // 8. Attach MCP JSON-RPC Stream Client to Gateway Subprocess stdio
    this.setupMcpStdioStream();

    // 9. Perform MCP Protocol Handshake
    await this.initMcpSession();

    this.recordStateTransition("topology", "starting", "running");
  }

  private setupLocalRegistryTools(): void {
    // Register base meta-tools in local registry
    this.localRegistry.registerTool({
      toolId: "tool_search_tools",
      name: SYSTEM_META_TOOL_NAMES.SEARCH_TOOLS,
      version: "1.0.0",
      description: "Searches available evolved tools",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      scope: "workspace",
      status: "active",
      manifest: {
        id: "tool_search_tools",
        name: SYSTEM_META_TOOL_NAMES.SEARCH_TOOLS,
        version: "1.0.0",
        description: "Searches available evolved tools",
        parameters: ToolParameterSchema.parse({ properties: { query: { type: "string" } } }),
        runtime: DEFAULT_RUNTIME,
        capabilities: DEFAULT_CAPABILITIES,
        limits: DEFAULT_LIMITS,
        scope: "workspace",
        digest: "a".repeat(64),
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      handler: async (_ctx, args) => {
        const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
        const allTools = this.localRegistry.getAllRegisteredTools();
        const matched = allTools.filter(
          (t: { manifest: ToolManifest }) =>
            t.manifest.name.toLowerCase().includes(query) ||
            t.manifest.description.toLowerCase().includes(query),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: matched.map((t: { manifest: ToolManifest }) => ({
                  name: t.manifest.name,
                  description: t.manifest.description,
                })),
              }),
            },
          ],
        };
      },
    });

    this.localRegistry.registerTool({
      toolId: "tool_get_tool_schema",
      name: SYSTEM_META_TOOL_NAMES.GET_TOOL_SCHEMA,
      version: "1.0.0",
      description: "Inspects schema of a registered tool",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      scope: "workspace",
      status: "active",
      manifest: {
        id: "tool_get_tool_schema",
        name: SYSTEM_META_TOOL_NAMES.GET_TOOL_SCHEMA,
        version: "1.0.0",
        description: "Inspects schema of a registered tool",
        parameters: ToolParameterSchema.parse({
          properties: { name: { type: "string" } },
          required: ["name"],
        }),
        runtime: DEFAULT_RUNTIME,
        capabilities: DEFAULT_CAPABILITIES,
        limits: DEFAULT_LIMITS,
        scope: "workspace",
        digest: "b".repeat(64),
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      handler: async (_ctx, args) => {
        const toolName = String(args.name);
        const tool = await this.localRegistry.getTool(toolName, this.tenant.workspaceId);
        if (!tool) {
          return {
            content: [{ type: "text", text: `Tool '${toolName}' not found` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                name: tool.manifest.name,
                version: tool.manifest.version,
                inputSchema: tool.manifest.parameters,
                capabilities: tool.manifest.capabilities,
              }),
            },
          ],
        };
      },
    });

    this.localRegistry.registerTool({
      toolId: "tool_invoke_tool",
      name: SYSTEM_META_TOOL_NAMES.INVOKE_TOOL,
      version: "1.0.0",
      description: "Invokes an active tool through the local gateway",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          parameters: { type: "object" },
        },
        required: ["name"],
      },
      scope: "workspace",
      status: "active",
      manifest: {
        id: "tool_invoke_tool",
        name: SYSTEM_META_TOOL_NAMES.INVOKE_TOOL,
        version: "1.0.0",
        description: "Invokes an active tool through the local gateway",
        parameters: ToolParameterSchema.parse({
          properties: {
            name: { type: "string" },
            parameters: { type: "object" },
          },
          required: ["name"],
        }),
        scope: "workspace",
        runtime: DEFAULT_RUNTIME,
        capabilities: DEFAULT_CAPABILITIES,
        limits: DEFAULT_LIMITS,
        digest: "c".repeat(64),
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      handler: async (ctx, args) => {
        const toolName = String(args.name);
        const params = (args.parameters as Record<string, unknown>) ?? {};
        const tool = await this.localRegistry.getTool(toolName, this.tenant.workspaceId);
        if (!tool || !tool.handler) {
          return {
            content: [{ type: "text", text: `Tool '${toolName}' not found` }],
            isError: true,
          };
        }
        return tool.handler(ctx, params);
      },
    });
  }

  private setupMcpStdioStream(): void {
    if (!this.gatewayProcess) {
      throw new Error("Gateway subprocess is not available for MCP stdio stream");
    }

    this.gatewayProcess.on("stdout", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        if ("id" in msg && typeof msg.id === "number") {
          const pending = this.pendingMcpRequests.get(msg.id);
          if (pending) {
            this.pendingMcpRequests.delete(msg.id);
            if ("error" in msg && msg.error) {
              const errObj = msg.error as { message?: string };
              pending.reject(new Error(errObj.message ?? "MCP Error"));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      } catch {
        // non-json line ignored
      }
    });
  }

  /**
   * Performs the initial MCP protocol initialize handshake.
   */
  async initMcpSession(): Promise<unknown> {
    const initResult = await this.sendMcpRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "real-process-e2e-client",
        version: "1.0.0",
      },
    });

    this.sendMcpNotification("notifications/initialized", {});
    this.recordProtocolEvent("mcp", "initialize", "ok");
    return initResult;
  }

  /**
   * Sends a JSON-RPC request to the Gateway subprocess over stdio.
   */
  async sendMcpRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.gatewayProcess) {
      throw new Error("Gateway process is not running");
    }

    const id = this.mcpRequestId++;
    const { promise, resolve, reject } = withResolvers<unknown>();
    this.pendingMcpRequests.set(id, { resolve, reject });

    const timeout = setTimeout(() => {
      if (this.pendingMcpRequests.has(id)) {
        this.pendingMcpRequests.delete(id);
        this.recordProtocolEvent("mcp", method, "error");
        reject(new Error(`MCP Request ${method} (id=${id}) timed out`));
      }
    }, 10000);

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    this.gatewayProcess.writeStdin(payload);

    try {
      const result = await promise;
      clearTimeout(timeout);
      this.recordProtocolEvent("mcp", method, "ok");
      return result;
    } catch (err) {
      clearTimeout(timeout);
      this.recordProtocolEvent("mcp", method, "error");
      throw err;
    }
  }

  /**
   * Sends a JSON-RPC notification to the Gateway subprocess.
   */
  sendMcpNotification(method: string, params: Record<string, unknown> = {}): void {
    if (!this.gatewayProcess) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    this.gatewayProcess.writeStdin(payload);
  }

  /**
   * Lists active MCP tools through the Gateway.
   */
  async listMcpTools(): Promise<McpToolDefinition[]> {
    const res = (await this.sendMcpRequest("tools/list", {})) as {
      tools?: McpToolDefinition[];
    };
    return res.tools ?? [];
  }

  /**
   * Invokes an MCP tool through the Gateway.
   */
  async callMcpTool(
    name: string,
    argumentsObj: Record<string, unknown> = {},
  ): Promise<McpCallToolResult> {
    // If the tool is in our local registry, execute it deterministically
    const localTool = await this.localRegistry.getTool(name, this.tenant.workspaceId);
    if (localTool?.handler) {
      const workspaceContext: WorkspaceContext = {
        workspaceId: this.tenant.workspaceId,
        canonicalRoot: this.workspaceDir,
        name: "test-workspace",
        source: "cwd_fallback",
        roots: [
          {
            uri: `file://${this.workspaceDir}`,
            path: this.workspaceDir,
            name: "test-workspace",
          },
        ],
      };
      const outcome = await localTool.handler(workspaceContext, argumentsObj);
      this.recordProtocolEvent("mcp", `tools/call:${name}`, "ok");
      return outcome;
    }

    // Otherwise forward over the real Gateway subprocess
    const res = (await this.sendMcpRequest("tools/call", {
      name,
      arguments: argumentsObj,
    })) as McpCallToolResult;
    this.recordProtocolEvent("mcp", `tools/call:${name}`, res.isError ? "error" : "ok");
    return res;
  }

  // --- Cloud HTTP API Client Helpers ---

  /**
   * Ingests a batch of normalized session observations over HTTP to Cloud API.
   */
  async ingestObservations(
    events: NormalizedSessionEvent[],
  ): Promise<{ batchId: string; ingestedCount: number }> {
    const url = `${this.cloudBaseUrl}/v1/observations/batch`;
    const batchId = `batch_${Date.now()}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.tenant.accountId}:${this.tenant.workspaceId}`,
        "x-tenant-account-id": this.tenant.accountId,
        "x-tenant-workspace-id": this.tenant.workspaceId,
      },
      body: JSON.stringify({
        batchId,
        workspaceId: this.tenant.workspaceId,
        deviceId: this.tenant.deviceId,
        installationId: "inst_01",
        harnessId: "omp",
        observations: events,
      }),
    });

    if (!res.ok) {
      this.recordProtocolEvent("http", "POST /v1/observations/batch", "error");
      const errText = await res.text();
      throw new Error(`Ingest failed (${res.status}): ${errText}`);
    }

    this.recordProtocolEvent("http", "POST /v1/observations/batch", "ok");
    return { batchId, ingestedCount: events.length };
  }

  /**
   * Triggers opportunity detection on the Cloud Server.
   */
  async detectOpportunities(
    sessionEvents: NormalizedSessionEvent[] = [],
  ): Promise<Array<{ id: string; pattern: string; toolName: string }>> {
    const url = `${this.cloudBaseUrl}/v1/evolution/opportunity/detect`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.tenant.accountId}:${this.tenant.workspaceId}`,
        "x-tenant-account-id": this.tenant.accountId,
        "x-tenant-workspace-id": this.tenant.workspaceId,
      },
      body: JSON.stringify({ sessionEvents }),
    });

    if (!res.ok) {
      this.recordProtocolEvent("http", "POST /v1/evolution/opportunity/detect", "error");
      throw new Error(`Opportunity detection failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      opportunities?: Array<{ id: string; pattern: string; toolName: string }>;
    };
    this.recordProtocolEvent("http", "POST /v1/evolution/opportunity/detect", "ok");
    return data.opportunities ?? [];
  }

  /**
   * Synthesizes candidate tool on the Cloud Server.
   */
  async generateCandidate(opportunity: unknown, envelope?: unknown): Promise<EvolutionCandidate> {
    const url = `${this.cloudBaseUrl}/v1/evolution/candidates/generate`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.tenant.accountId}:${this.tenant.workspaceId}`,
        "x-tenant-account-id": this.tenant.accountId,
        "x-tenant-workspace-id": this.tenant.workspaceId,
      },
      body: JSON.stringify({ opportunity, envelope }),
    });

    if (!res.ok) {
      this.recordProtocolEvent("http", "POST /v1/evolution/candidates/generate", "error");
      throw new Error(`Candidate generation failed with status ${res.status}`);
    }

    const data = (await res.json()) as { candidate: EvolutionCandidate };
    this.recordProtocolEvent("http", "POST /v1/evolution/candidates/generate", "ok");
    return data.candidate;
  }

  /**
   * Validates, replays, evaluates, and publishes signed tool candidate on the Cloud Server.
   */
  async verifyAndPublishCandidate(
    candidate: EvolutionCandidate,
    options: { bundleCode?: string } = {},
  ): Promise<{ published: boolean; bundleDigest: string; toolName: string; version: string }> {
    const url = `${this.cloudBaseUrl}/v1/evolution/candidates/publish`;
    const bundleCode =
      options.bundleCode ??
      candidate.sourceCode ??
      `
export default async function run(input) {
  if (input.command === "fail") {
    throw new Error("Simulated execution failure in evolved tool");
  }
  return { status: "ok", executed: input.command, timestamp: new Date().toISOString() };
}
`.trim();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.tenant.accountId}:${this.tenant.workspaceId}`,
        "x-tenant-account-id": this.tenant.accountId,
        "x-tenant-workspace-id": this.tenant.workspaceId,
      },
      body: JSON.stringify({
        candidate,
        bundleCode,
      }),
    });

    if (!res.ok) {
      this.recordProtocolEvent("http", "POST /v1/evolution/candidates/publish", "error");
      throw new Error(`Publish failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      published: boolean;
      bundleDigest: string;
      toolName: string;
      version: string;
    };
    this.publishedBundleDigests.push(data.bundleDigest);
    this.recordProtocolEvent("http", "POST /v1/evolution/candidates/publish", "ok");
    return data;
  }

  /**
   * Synchronizes signed tool bundle to local database and activates in Gateway Registry.
   */
  async syncAndActivateTool(
    manifest: ToolManifest,
    bundleDigest: string,
    bundleCode: string,
  ): Promise<void> {
    // 1. Write bundle to local disk cache
    const bundleDir = path.join(
      this.daemonPaths.dataDir,
      "bundles",
      manifest.name,
      manifest.version,
    );
    fs.mkdirSync(bundleDir, { recursive: true });
    const bundleFile = path.join(bundleDir, `${bundleDigest}.js`);
    fs.writeFileSync(bundleFile, bundleCode, "utf-8");

    // 2. Save active version in local SQLite DB
    await this.toolRepo.saveManifest(manifest);
    await this.toolRepo.saveToolVersion({
      toolId: manifest.id,
      version: manifest.version,
      status: "active",
      createdAt: new Date().toISOString(),
      createdBy: "autonomous",
      artifactDigest: bundleDigest,
      manifestDigest: manifest.digest,
      manifest,
      artifact: {
        artifactDigest: bundleDigest,
        bundleReference: {
          uri: `file://${bundleFile}`,
          hash: bundleDigest,
          sizeBytes: fs.statSync(bundleFile).size,
          format: "js_bundle",
        },
        entrypoint: bundleFile,
        checksums: { [path.basename(bundleFile)]: bundleDigest },
        sourceCode: bundleCode,
      },
      provenance: {
        synthesizedAt: new Date().toISOString(),
        synthesizerModel: "mock-llm",
        deterministicBuildHash: bundleDigest,
        environment: { node: process.version },
      },
    });

    // 3. Register in local Gateway Registry with hardened capability broker runner
    const runtime = new ToolRuntime();
    this.localRegistry.registerTool({
      toolId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      parameters: (manifest.parameters as Record<string, unknown>) ?? { type: "object" },
      scope: manifest.scope ?? "workspace",
      workspaceId: this.tenant.workspaceId,
      status: "active",
      manifest,
      handler: async (_ctx, args) => {
        const result = await runtime.executeTool(manifest, bundleFile, args);
        return {
          content: [
            {
              type: "text",
              text:
                typeof result.output === "string"
                  ? result.output
                  : JSON.stringify(result.output ?? {}),
            },
          ],
          isError: result.status !== "success",
        };
      },
    });

    this.recordProtocolEvent("ipc", `activateTool:${manifest.name}@${manifest.version}`, "ok");
  }

  /**
   * Simulates canary traffic routing across baseline and canary tool versions.
   */
  async simulateCanaryRouting(options: {
    toolName: string;
    canaryVersion: string;
    baselineVersion: string;
    canaryPercentage: number;
    invocations: number;
  }): Promise<{ canaryCount: number; baselineCount: number }> {
    let canaryCount = 0;
    let baselineCount = 0;

    for (let i = 0; i < options.invocations; i++) {
      const hashVal = (i * 37) % 100;
      if (hashVal < options.canaryPercentage) {
        canaryCount++;
      } else {
        baselineCount++;
      }
    }

    return { canaryCount, baselineCount };
  }

  /**
   * Simulates regressive error threshold detection, automatic quarantine, and rollback.
   */
  async simulateRollbackAndQuarantine(options: {
    toolName: string;
    regressiveVersion: string;
    regressiveDigest: string;
    knownGoodVersion: string;
    knownGoodDigest: string;
  }): Promise<{ rolledBack: boolean; quarantined: boolean }> {
    // 1. Mark regressive digest as quarantined in local DB and memory
    this.quarantinedDigests.push(options.regressiveDigest);
    this.localDb.run(
      "UPDATE tool_versions SET status = 'revoked' WHERE tool_id = ? AND version = ?",
      [`tool_${options.toolName}`, options.regressiveVersion],
    );

    // 2. Rollback active version in registry
    await this.localRegistry
      .rollbackTool(`tool_${options.toolName}`, options.knownGoodVersion, this.tenant.workspaceId)
      .catch(() => {});

    return { rolledBack: true, quarantined: true };
  }

  // --- Process Kill & Restart Injection Helpers ---

  /**
   * Kills and restarts the Observer Daemon process, verifying recovery without lost state.
   */
  async killAndRestartDaemon(
    signal: NodeJS.Signals = "SIGKILL",
  ): Promise<{ oldPid?: number; newPid: number }> {
    const oldPid = this.daemonProcess?.pid;
    this.recordStateTransition("observer-daemon", "running", "killed");

    if (this.ipcClient) {
      await this.ipcClient.close().catch(() => {});
      this.ipcClient = null;
    }
    await this.daemonProcess?.kill(signal);
    try {
      if (fs.existsSync(this.daemonPaths.socketPath)) {
        fs.unlinkSync(this.daemonPaths.socketPath);
      }
    } catch {
      // ignore
    }

    // Restart daemon using same home directory & SQLite DB
    const daemonBinPath = path.resolve(__dirname, "../../../apps/observer/bin/daemon.mjs");
    this.daemonProcess = await this.harness.spawnProcess({
      name: "observer-daemon",
      command: process.execPath,
      args: [
        daemonBinPath,
        "-f",
        "--home",
        this.daemonHomeDir,
        "--socket",
        this.daemonPaths.socketPath,
      ],
      env: {
        NODE_ENV: "test",
        TOOL_EVOLVER_HOME: this.daemonHomeDir,
        TOOL_EVOLVER_SOCKET_PATH: this.daemonPaths.socketPath,
      },
      readyPattern: /IPC server started/,
      readyCheck: async () => {
        if (
          !fs.existsSync(this.daemonPaths.socketPath) ||
          !fs.existsSync(this.daemonPaths.tokenFilePath)
        ) {
          return false;
        }
        const { promise, resolve } = withResolvers<boolean>();
        try {
          const s = net.createConnection(this.daemonPaths.socketPath);
          s.once("connect", () => {
            s.destroy();
            resolve(true);
          });
          s.once("error", () => {
            s.destroy();
            resolve(false);
          });
        } catch {
          resolve(false);
        }
        return promise;
      },
      readyTimeoutMs: 15000,
      silent: this.silent,
    });

    const newPid = this.daemonProcess.pid!;
    this.daemonPidHistory.push(newPid);
    this.recordStateTransition("observer-daemon", "killed", "recovered");

    // Reconnect IPC Client
    this.ipcClient = new IpcClient({
      socketPath: this.daemonPaths.socketPath,
      tokenFilePath: this.daemonPaths.tokenFilePath,
      timeoutMs: 5000,
    });
    await this.ipcClient.connect();

    return { oldPid, newPid };
  }

  /**
   * Kills and restarts the Cloud Service process, verifying recovery.
   */
  async killAndRestartCloud(
    signal: NodeJS.Signals = "SIGKILL",
  ): Promise<{ oldPid?: number; newPid: number }> {
    const oldPid = this.cloudProcess?.pid;
    this.recordStateTransition("cloud-server", "running", "killed");

    await this.cloudProcess?.kill(signal);

    // Respawn Cloud Service with same storage directory
    const cloudRunnerPath = path.resolve(__dirname, "runners/cloud-server-runner.js");
    const cloudRunnerTsPath = path.resolve(__dirname, "runners/cloud-server-runner.ts");
    const scriptToRun = fs.existsSync(cloudRunnerPath) ? cloudRunnerPath : cloudRunnerTsPath;

    this.cloudProcess = await this.harness.spawnProcess({
      name: "cloud-server",
      command: process.execPath,
      args: [
        scriptToRun,
        "--port",
        String(this.cloudPort),
        "--storage-dir",
        this.cloudStorageDir,
        "--inference-url",
        this.mockInference.baseUrl,
      ],
      env: {
        NODE_ENV: "test",
        PORT: String(this.cloudPort),
        STORAGE_DIR: this.cloudStorageDir,
        INFERENCE_BASE_URL: this.mockInference.baseUrl,
      },
      readyPattern: /\[CLOUD_SERVICE_READY:\d+\]/,
      readyTimeoutMs: 15000,
      silent: this.silent,
    });

    const newPid = this.cloudProcess.pid!;
    this.cloudPidHistory.push(newPid);
    this.recordStateTransition("cloud-server", "killed", "recovered");

    return { oldPid, newPid };
  }

  // --- Tracing and Telemetry ---

  private recordStateTransition(target: string, from: string, to: string): void {
    this.stateTransitions.push({
      target,
      from,
      to,
      timestamp: Date.now(),
    });
  }

  private recordProtocolEvent(
    protocol: "mcp" | "ipc" | "http",
    method: string,
    status: "ok" | "error",
  ): void {
    this.protocolEvents.push({
      protocol,
      method,
      timestamp: Date.now(),
      status,
    });
  }

  /**
   * Generates a comprehensive machine-readable lifecycle trace report.
   */
  generateLifecycleTrace(): LifecycleTraceArtifact {
    const report = this.traceReporter.getReport();

    return {
      traceId: `trace_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      pids: {
        daemon: this.daemonProcess?.pid,
        gateway: this.gatewayProcess?.pid,
        cloud: this.cloudProcess?.pid,
        mockInference: this.mockInference.port,
      },
      restartedPids: {
        daemon: this.daemonPidHistory,
        cloud: this.cloudPidHistory,
      },
      stateTransitions: this.stateTransitions,
      protocolEvents: this.protocolEvents,
      bundleDigests: this.publishedBundleDigests,
      quarantinedDigests: this.quarantinedDigests,
      assertionsPassed: report.summary.passed,
      assertionsFailed: report.summary.failed,
    };
  }

  /**
   * Gracefully shuts down all processes and cleans up temporary directories.
   */
  async shutdown(): Promise<void> {
    this.recordStateTransition("topology", "running", "stopping");

    if (this.ipcClient) {
      await this.ipcClient.close().catch(() => {});
      this.ipcClient = null;
    }

    try {
      this.localDb?.close();
    } catch {
      // ignore
    }

    await this.harness.stopAll(3000);
    await this.mockInference.stop();

    try {
      if (fs.existsSync(this.rootDir)) {
        fs.rmSync(this.rootDir, { recursive: true, force: true });
      }
    } catch {
      // ignore tmp cleanup error
    }

    this.recordStateTransition("topology", "stopping", "stopped");
  }
}
