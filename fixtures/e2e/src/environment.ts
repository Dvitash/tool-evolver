/**
 * @tool-evolver/e2e - Hermetic End-to-End Test Environment
 *
 * Orchestrates in-memory CloudService, LocalStateStore, LocalDaemon,
 * LocalMcpGateway, and HarnessAdapters with a deterministic clock and fake inference.
 */

import { ClaudeHarnessAdapter } from "@tool-evolver/adapter-claude-code";
import { CodexHarnessAdapter } from "@tool-evolver/adapter-codex";
import { OmpHarnessAdapter } from "@tool-evolver/adapter-omp";
import {
  type CloudService,
  FakeModelProvider,
  type ProviderExecutionRequest,
  type TenantContext,
  createCloudService,
  runWithTenant,
} from "@tool-evolver/cloud";
import {
  type NormalizedSessionEvent,
  type ToolManifest,
  type ToolVersion,
  nowIso,
} from "@tool-evolver/contracts";
import {
  AuditRepository,
  CapabilityRepository,
  LocalDatabaseConnection,
  MigrationRunner,
  SessionRepository,
  SyncRepository,
  ToolRepository,
} from "@tool-evolver/db";
import {
  type CallToolResult,
  type GatewayRouter,
  type JsonRpcMessage,
  LocalMcpGateway,
  ToolRegistry,
  type WorkspaceContext,
  createRegistryGatewayRouter,
  createSystemMetaTools,
} from "@tool-evolver/gateway";
import { InMemoryConfigFsBridge } from "@tool-evolver/harness-contracts";
import {
  AuditTrailManager,
  DeploymentActivator,
  HealthAggregator,
  KillSwitchManager,
  RecoveryController,
  redactSensitiveData,
} from "@tool-evolver/observer";
import { DeterministicIdGenerator, FakeClock } from "@tool-evolver/test-fixtures";
import { LifecycleTraceReporter } from "./trace-reporter.js";

export interface HermeticE2EOptions {
  tenant?: TenantContext;
  workspacePath?: string;
  initialTime?: number;
}

export interface InvocationOutcome {
  success: boolean;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  toolResult?: unknown;
}

export class HermeticE2EEnvironment {
  // Deterministic Controls
  readonly clock: FakeClock;
  readonly idGen: DeterministicIdGenerator;
  readonly traceReporter: LifecycleTraceReporter;

  // Tenant & Workspace
  readonly tenant: TenantContext;
  readonly workspacePath: string;

  // Cloud Platform Subsystems
  cloudService!: CloudService;
  fakeModelProvider!: FakeModelProvider;

  // Local State Store Subsystems
  localDb!: LocalDatabaseConnection;
  sessionRepo!: SessionRepository;
  toolRepo!: ToolRepository;
  capabilityRepo!: CapabilityRepository;
  syncRepo!: SyncRepository;
  auditRepo!: AuditRepository;

  // Local Gateway Subsystems
  toolRegistry!: ToolRegistry;
  gatewayRouter!: GatewayRouter;
  localGateway!: LocalMcpGateway;

  // Local Daemon & Observability Subsystems
  killSwitches!: KillSwitchManager;
  auditTrail!: AuditTrailManager;
  healthAggregator!: HealthAggregator;
  recoveryController!: RecoveryController;
  deploymentActivator!: DeploymentActivator;

  // Harness Adapters
  claudeCodeAdapter!: ClaudeHarnessAdapter;
  codexCliAdapter!: CodexHarnessAdapter;
  ompAdapter!: OmpHarnessAdapter;
  readonly fsBridge = new InMemoryConfigFsBridge();

  private isRunning = false;

  constructor(options: HermeticE2EOptions = {}) {
    const initialTime = options.initialTime ?? 1773705600000; // 2026-03-17T00:00:00.000Z
    this.clock = new FakeClock(initialTime);
    this.idGen = new DeterministicIdGenerator(42);
    this.traceReporter = new LifecycleTraceReporter();

    this.tenant = options.tenant ?? {
      accountId: "acc_e2e_tenant_01",
      workspaceId: "ws_e2e_default_01",
      deviceId: "dev_e2e_node_01",
    };
    this.workspacePath = options.workspacePath ?? "/workspace/project";
  }

  /**
   * Initializes and boots all in-memory services hermetically.
   */
  async initialize(): Promise<void> {
    if (this.isRunning) return;

    // 1. Setup Fake Inference Provider with default synthesis responses
    this.fakeModelProvider = new FakeModelProvider({
      id: "fake-e2e-llm",
      name: "Deterministic E2E Fake LLM",
    });
    this.seedDefaultModelResponses();

    // 2. Setup Cloud Service in-memory
    this.cloudService = createCloudService({
      config: {
        server: { port: 0 },
      },
    });
    await this.cloudService.initialize();

    // 3. Setup Local State Store in-memory SQLite with schema migrations
    this.localDb = new LocalDatabaseConnection({ inMemory: true });
    const migrationRunner = new MigrationRunner(this.localDb);
    await migrationRunner.migrate();

    this.sessionRepo = new SessionRepository(this.localDb);
    this.toolRepo = new ToolRepository(this.localDb);
    this.capabilityRepo = new CapabilityRepository(this.localDb);
    this.syncRepo = new SyncRepository(this.localDb);
    this.auditRepo = new AuditRepository(this.localDb);

    // 4. Setup Local Observability Managers
    this.auditTrail = new AuditTrailManager(this.localDb);
    this.killSwitches = new KillSwitchManager(this.localDb, this.auditTrail);
    await this.killSwitches.initialize();
    this.healthAggregator = new HealthAggregator();
    this.recoveryController = new RecoveryController();

    // 5. Setup Deployment Activator
    this.deploymentActivator = new DeploymentActivator({
      conn: this.localDb,
      toolRepo: this.toolRepo,
    });

    // 6. Setup Local Dynamic Tool Registry & System Meta-Tools
    this.toolRegistry = new ToolRegistry();
    const systemMetaTools = createSystemMetaTools(this.toolRegistry);
    for (const tool of systemMetaTools) {
      this.toolRegistry.registerTool(tool);
    }

    this.gatewayRouter = createRegistryGatewayRouter(this.toolRegistry);
    this.localGateway = new LocalMcpGateway({
      router: this.gatewayRouter,
      serverInfo: { name: "tool-evolver-local-gateway", version: "0.1.0" },
    });

    // 7. Setup Harness Adapters
    this.claudeCodeAdapter = new ClaudeHarnessAdapter({ fsBridge: this.fsBridge });
    this.codexCliAdapter = new CodexHarnessAdapter({ fsBridge: this.fsBridge });
    this.ompAdapter = new OmpHarnessAdapter({ fsBridge: this.fsBridge });

    this.isRunning = true;
  }

  /**
   * Shuts down all in-memory services.
   */
  async shutdown(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.cloudService.shutdown();
    } catch {
      // ignore
    }

    try {
      this.localDb.close();
    } catch {
      // ignore
    }

    this.isRunning = false;
  }

  /**
   * Advance simulated clock by milliseconds.
   */
  advanceClock(ms: number): void {
    this.clock.advance(ms);
  }

  /**
   * Ingest normalized session events into cloud observation store.
   */
  async ingestSessionEvents(
    events: NormalizedSessionEvent[],
    tenant: TenantContext = this.tenant,
  ): Promise<{ ingestedCount: number; batchId: string }> {
    await this.cloudService.authService.consentManager.setConsent({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      deviceId: tenant.deviceId,
      normalizedObservations: true,
      rawTranscriptUpload: false,
    });

    const redactedEvents = events.map((e) => {
      const redacted = redactSensitiveData(e) as NormalizedSessionEvent;
      return {
        ...redacted,
        redaction: {
          isRedacted: true,
          redactedFields: redacted.redaction?.redactedFields ?? [],
          redactionStrategy: "mask" as const,
          scrubbedPatterns: redacted.redaction?.scrubbedPatterns ?? [],
        },
      };
    });

    const batchId = this.idGen.nextId("batch");
    const result = await this.cloudService.ingestionService.ingestBatch(tenant, {
      batchId,
      workspaceId: tenant.workspaceId,
      deviceId: tenant.deviceId ?? "dev_01",
      installationId: "inst_01",
      compressed: false,
      compression: "none",
      observations: redactedEvents,
    });

    return {
      ingestedCount: result.acceptedCount,
      batchId: result.batchId,
    };
  }

  /**
   * Drain and execute all pending evolution background jobs in the cloud queue.
   */
  async drainEvolutionJobs(maxSteps = 20): Promise<number> {
    let executedJobs = 0;
    for (let step = 0; step < maxSteps; step++) {
      const activeOrPending = await this.cloudService.queue.getQueueStats();
      if (activeOrPending.pendingCount === 0 && activeOrPending.processingCount === 0) {
        break;
      }

      const job = await this.cloudService.queue.dequeue();
      if (!job) break;

      const handlers = (
        this.cloudService.worker as unknown as {
          handlers: Map<string, (j: unknown, s: AbortSignal) => Promise<void>>;
        }
      ).handlers;
      const handler = handlers?.get(job.jobType);
      if (handler) {
        await handler(job, new AbortController().signal);
        await this.cloudService.queue.ack(job.jobId);
        executedJobs++;
      }
    }

    return executedJobs;
  }

  /**
   * Call a tool on the Local MCP Gateway.
   */
  async invokeTool(
    name: string,
    args: Record<string, unknown> = {},
    options: {
      workspacePath?: string;
      workspaceId?: string;
      accountId?: string;
      harnessId?: string;
    } = {},
  ): Promise<InvocationOutcome> {
    const resolvedPath = options.workspacePath ?? this.workspacePath;
    const workspaceId = options.workspaceId ?? this.tenant.workspaceId;
    const context: WorkspaceContext = {
      workspaceId,
      canonicalRoot: resolvedPath,
      name: "project",
      source: "roots",
      roots: [{ uri: `file://${resolvedPath}`, path: resolvedPath, name: "project" }],
      harnessId: options.harnessId ?? "claude-code",
      sessionId: this.idGen.nextId("sess"),
    };

    // Check kill switches
    const executionEval = this.killSwitches.canExecuteTool(name, context.workspaceId);
    if (!executionEval.allowed) {
      return {
        success: false,
        isError: true,
        content: [
          {
            type: "text",
            text: `Execution disabled by kill switch: ${executionEval.reason ?? "Disabled"}`,
          },
        ],
      };
    }

    try {
      const result: CallToolResult = await this.gatewayRouter.callTool(context, name, args);
      return {
        success: !result.isError,
        isError: result.isError,
        content: result.content as Array<{ type: string; text: string }>,
        toolResult: result,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        isError: true,
        content: [{ type: "text", text: errorMsg }],
      };
    }
  }

  /**
   * Execute JSON-RPC message directly through gateway.
   */
  async callGatewayJsonRpc(
    message: JsonRpcMessage,
    connectionId = "conn_e2e_01",
  ): Promise<JsonRpcMessage | null> {
    if (!this.localGateway.getConnection(connectionId)) {
      this.localGateway.createConnection({
        connectionId,
        harnessId: "claude-code",
        cwd: this.workspacePath,
      });
    }
    return this.localGateway.handleMessage(connectionId, message);
  }

  async syncAndActivateCloudTools(workspaceId: string = this.tenant.workspaceId): Promise<number> {
    const tenantObj = { accountId: this.tenant.accountId, workspaceId };

    const snapshot = await runWithTenant(tenantObj, async () => {
      await this.cloudService.catalogService.invalidateWorkspaceCatalog(
        tenantObj,
        "version_published",
      );
      return this.cloudService.catalogService.getCatalogSnapshot(tenantObj);
    });

    const dbTools = await runWithTenant(tenantObj, async () => {
      return this.cloudService.artifactRegistryService.toolRegistryRepo.listTools(tenantObj);
    });

    let activatedCount = 0;

    // Activate snapshot tools
    for (const toolDef of snapshot.tools) {
      const digest =
        toolDef.digest ?? "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const manifest: ToolManifest = {
        id: toolDef.id,
        name: toolDef.name,
        version: toolDef.version,
        description: toolDef.description,
        parameters: {
          type: "object",
          properties:
            (toolDef.parameters?.properties as Record<string, Record<string, unknown>>) ?? {},
          required: (toolDef.parameters?.required as string[]) ?? [],
          additionalProperties: false,
        },
        runtime: {
          runtime: "node",
          timeoutMs: 15000,
          memoryLimitMb: 256,
          cpuLimitPercent: 80,
          maxOutputSizeBytes: 2097152,
        },
        capabilities: toolDef.capabilities ?? {
          fs: {
            readPaths: [this.workspacePath],
            writePaths: [this.workspacePath],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 10485760,
          },
          net: {
            allowOutbound: false,
            allowedDomains: [],
            allowedHosts: [],
            allowedPorts: [],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
          command: {
            allowShellExecution: false,
            allowedCommands: ["git"],
            allowedBinaries: ["git"],
            forbiddenPatterns: [],
            allowEnvPassthrough: [],
          },
          secrets: {
            allowedSecretNames: [],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
          limits: {
            maxConcurrentExecutions: 4,
            maxCpuUsagePercent: 100,
            maxMemoryMb: 256,
            maxExecutionTimeMs: 15000,
            maxOutputSizeBytes: 2097152,
          },
        },
        scope: "workspace",
        digest,
        createdAt: nowIso(),
        metadata: {},
        limits: {
          timeoutMs: 15000,
          maxMemoryBytes: 268435456,
          maxOutputBytes: 2097152,
          maxConcurrentInvocations: 4,
        },
      };

      await this.toolRepo.saveManifest(manifest);

      const toolVersion: ToolVersion = {
        toolId: toolDef.id,
        version: toolDef.version,
        manifestDigest: digest,
        artifactDigest: digest,
        manifest,
        artifact: {
          artifactDigest: digest,
          bundleReference: {
            uri: `local://${toolDef.id}/${toolDef.version}`,
            hash: digest,
            sizeBytes: 1024,
            format: "zip",
          },
          entrypoint: "index.js",
          checksums: {
            sha256: digest,
          },
        },
        provenance: {
          synthesizedAt: nowIso(),
          synthesizerModel: "fake-e2e-llm",
          deterministicBuildHash: digest,
          sourceCandidateId: `cand_${toolDef.id}`,
          environment: {},
        },
        status: "active",
        createdAt: nowIso(),
        createdBy: "system",
      };
      await this.toolRepo.saveToolVersion(toolVersion);

      const toolHandler = async (_ctx: unknown, params: Record<string, unknown>) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "executed",
              tool: toolDef.name,
              params,
              output: `Autonomous output for ${toolDef.name}`,
            }),
          },
        ],
      });

      this.toolRegistry.registerTool({
        toolId: toolDef.id,
        name: toolDef.name,
        exposedName: toolDef.name,
        version: toolDef.version,
        description: toolDef.description,
        scope: "global",
        workspaceId,
        status: "active",
        parameters: manifest.parameters,
        manifest,
        handler: toolHandler,
      });

      if (toolDef.id !== toolDef.name) {
        this.toolRegistry.registerTool({
          toolId: toolDef.name,
          name: toolDef.name,
          exposedName: toolDef.name,
          version: toolDef.version,
          description: toolDef.description,
          scope: "global",
          workspaceId,
          status: "active",
          parameters: manifest.parameters,
          manifest,
          handler: toolHandler,
        });
      }

      await this.toolRegistry.activateToolVersion(toolDef.id, toolDef.version, workspaceId);

      activatedCount++;
    }

    // Activate database tools
    for (const dbTool of dbTools) {
      const activeVer = dbTool.activeVersion ?? "1.0.0";
      const toolVersion = await runWithTenant(tenantObj, async () => {
        return this.cloudService.artifactRegistryService.toolRegistryRepo.getToolVersion(
          tenantObj,
          dbTool.id,
          activeVer,
        );
      });

      if (toolVersion) {
        await this.toolRepo.saveManifest(toolVersion.manifest);
        await this.toolRepo.saveToolVersion(toolVersion);

        const toolHandler = async (_ctx: unknown, params: Record<string, unknown>) => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "executed",
                tool: dbTool.name,
                params,
                output: `Autonomous output for ${dbTool.name}`,
              }),
            },
          ],
        });

        this.toolRegistry.registerTool({
          toolId: dbTool.id,
          name: dbTool.name,
          exposedName: dbTool.name,
          version: activeVer,
          description: dbTool.description ?? "",
          scope: "global",
          workspaceId,
          status: "active",
          parameters: toolVersion.manifest.parameters,
          manifest: toolVersion.manifest,
          handler: toolHandler,
        });
        if (dbTool.id !== dbTool.name) {
          this.toolRegistry.registerTool({
            toolId: dbTool.name,
            name: dbTool.name,
            exposedName: dbTool.name,
            version: activeVer,
            description: dbTool.description ?? "",
            scope: "global",
            workspaceId,
            status: "active",
            parameters: toolVersion.manifest.parameters,
            manifest: toolVersion.manifest,
            handler: toolHandler,
          });
        }

        await this.toolRegistry.activateToolVersion(dbTool.id, activeVer, workspaceId);

        activatedCount++;
      }
    }

    return activatedCount;
  }

  /**
   * Seed default deterministic model responses for evolution pipelines.
   */
  private seedDefaultModelResponses(): void {
    // Opportunity detection response
    this.fakeModelProvider.setMockResponse(
      (req: ProviderExecutionRequest) =>
        req.systemInstruction.includes("opportunity") || req.userMessage.includes("opportunity"),
      () =>
        JSON.stringify({
          opportunities: [
            {
              title: "Optimize Repeated Git Status and Diff Checking",
              description: "Frequent repetitive git status and git diff commands across sessions.",
              patternType: "repetitive_tool_calls",
              suggestedToolName: "fast_git_status",
              suggestedScope: "workspace",
              confidenceScore: 0.96,
              estimatedBenefitScore: 0.88,
              evidenceEpisodeIds: ["ep_01", "ep_02", "ep_03"],
            },
          ],
        }),
    );

    // Candidate planning response
    this.fakeModelProvider.setMockResponse(
      (req: ProviderExecutionRequest) =>
        req.systemInstruction.includes("plan") || req.userMessage.includes("plan"),
      () =>
        JSON.stringify({
          toolName: "fast_git_status",
          description: "Optimized tool for rapid git status and branch summary inspection.",
          parameters: {
            type: "object",
            properties: {
              includeDiffSummary: { type: "boolean", description: "Include concise diff stats" },
            },
            required: [],
            additionalProperties: false,
          },
          requiredCapabilities: {
            command: {
              allowedCommands: ["git"],
              allowedBinaries: ["git"],
              allowShellExecution: false,
            },
          },
        }),
    );

    // Tool code synthesis response
    this.fakeModelProvider.setMockResponse(
      (req: ProviderExecutionRequest) =>
        req.systemInstruction.includes("synthesiz") ||
        req.userMessage.includes("synthesiz") ||
        req.userMessage.includes("code"),
      () =>
        JSON.stringify({
          code: `
export async function execute(params, context) {
  return {
    branch: "main",
    clean: true,
    modifiedFiles: [],
    untrackedFiles: [],
    summary: "Working tree clean"
  };
}
`,
          manifest: {
            id: "tool_fast_git_status",
            name: "fast_git_status",
            version: "1.0.0",
            description: "Rapid git status and diff summarizer.",
          },
        }),
    );

    // Test generation response
    this.fakeModelProvider.setMockResponse(
      (req: ProviderExecutionRequest) =>
        req.systemInstruction.includes("test") || req.userMessage.includes("test"),
      () =>
        JSON.stringify({
          testCases: [
            {
              name: "should return clean working tree status",
              input: { includeDiffSummary: true },
              expectedOutputProperties: ["branch", "clean", "summary"],
            },
          ],
        }),
    );

    // Candidate scoring response
    this.fakeModelProvider.setMockResponse(
      (req: ProviderExecutionRequest) =>
        req.systemInstruction.includes("score") ||
        req.userMessage.includes("score") ||
        req.systemInstruction.includes("evaluat"),
      () =>
        JSON.stringify({
          overallScore: 0.94,
          correctnessScore: 0.96,
          performanceScore: 0.92,
          safetyScore: 1.0,
          determinismScore: 0.95,
          recommendation: "promote",
        }),
    );
  }
}
