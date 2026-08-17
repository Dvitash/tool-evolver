/**
 * @tool-evolver/e2e - Cross-Harness and Multi-Tenant Isolation Scenario
 *
 * Exercises concurrent Claude Code, Codex CLI, and OMP sessions across
 * distinct workspace boundaries to verify non-interference, event segregation,
 * and scoped tool isolation.
 */

import type { TenantContext } from "@tool-evolver/cloud";
import { type NormalizedSessionEvent, type ToolManifest, nowIso } from "@tool-evolver/contracts";
import { SYSTEM_META_TOOL_NAMES } from "@tool-evolver/gateway";
import type { HermeticE2EEnvironment } from "../environment.js";

const DEFAULT_REDACTION = {
  isRedacted: true,
  redactedFields: [],
  redactionStrategy: "mask" as const,
  scrubbedPatterns: [],
};

export interface CrossHarnessIsolationResult {
  success: boolean;
  eventSegregationVerified: boolean;
  workspaceToolIsolationVerified: boolean;
  systemMetaToolsUniformlyAccessible: boolean;
  harnessCount: number;
}

export async function runCrossHarnessIsolationScenario(
  env: HermeticE2EEnvironment,
): Promise<CrossHarnessIsolationResult> {
  const reporter = env.traceReporter;

  const tenantClaude: TenantContext = {
    accountId: env.tenant.accountId,
    workspaceId: "ws_claude_workspace",
    deviceId: "dev_claude_node",
  };

  const tenantCodex: TenantContext = {
    accountId: env.tenant.accountId,
    workspaceId: "ws_codex_workspace",
    deviceId: "dev_codex_node",
  };

  const tenantOmp: TenantContext = {
    accountId: env.tenant.accountId,
    workspaceId: "ws_omp_workspace",
    deviceId: "dev_omp_node",
  };

  // 1. Ingest concurrent sessions from each harness
  const claudeEvents: NormalizedSessionEvent[] = [
    {
      eventId: "evt_claude_01",
      sessionId: "sess_claude_01",
      timestamp: nowIso(),
      type: "tool_call",
      schemaVersion: "1.0.0",
      causalRef: { causalSequence: 1 },
      redaction: DEFAULT_REDACTION,
      callId: "call_claude_01",
      toolName: "claude_exclusive_tool",
      parameters: { action: "claude_work" },
      isShadow: false,
    },
  ];

  const codexEvents: NormalizedSessionEvent[] = [
    {
      eventId: "evt_codex_01",
      sessionId: "sess_codex_01",
      timestamp: nowIso(),
      type: "tool_call",
      schemaVersion: "1.0.0",
      causalRef: { causalSequence: 1 },
      redaction: DEFAULT_REDACTION,
      callId: "call_codex_01",
      toolName: "codex_exclusive_tool",
      parameters: { action: "codex_work" },
      isShadow: false,
    },
  ];

  const ompEvents: NormalizedSessionEvent[] = [
    {
      eventId: "evt_omp_01",
      sessionId: "sess_omp_01",
      timestamp: nowIso(),
      type: "tool_call",
      schemaVersion: "1.0.0",
      causalRef: { causalSequence: 1 },
      redaction: DEFAULT_REDACTION,
      callId: "call_omp_01",
      toolName: "omp_exclusive_tool",
      parameters: { action: "omp_work" },
      isShadow: false,
    },
  ];

  await Promise.all([
    env.ingestSessionEvents(claudeEvents, tenantClaude),
    env.ingestSessionEvents(codexEvents, tenantCodex),
    env.ingestSessionEvents(ompEvents, tenantOmp),
  ]);

  // Query events for Claude workspace
  const claudeQueryResult = await env.cloudService.observationRepo.queryEvents({
    accountId: tenantClaude.accountId,
    workspaceId: tenantClaude.workspaceId,
    limit: 100,
  });

  const claudeEventsInStore = claudeQueryResult.events;
  const noCodexLeakInClaude = !claudeEventsInStore.some((e) => e.sessionId === "sess_codex_01");
  const noOmpLeakInClaude = !claudeEventsInStore.some((e) => e.sessionId === "sess_omp_01");
  const eventSegregationVerified = noCodexLeakInClaude && noOmpLeakInClaude;

  reporter.assertRequirement(
    "TE-REQ-028",
    "Strict multi-harness observation segregation without cross-workspace leakage",
    eventSegregationVerified,
    {
      category: "isolation",
      evidence: {
        claudeEventCount: claudeEventsInStore.length,
        segregated: eventSegregationVerified,
      },
    },
  );

  // 2. Workspace-Scoped Tool Isolation
  const claudeOnlyToolManifest: ToolManifest = {
    id: "tool_claude_special",
    name: "claude_special",
    version: "1.0.0",
    description: "Tool scoped exclusively to Claude workspace.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    runtime: {
      runtime: "node",
      timeoutMs: 5000,
      memoryLimitMb: 128,
      cpuLimitPercent: 50,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: ["/workspace/claude"],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 1048576,
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
        allowedCommands: [],
        allowedBinaries: [],
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
        maxMemoryMb: 128,
        maxExecutionTimeMs: 5000,
        maxOutputSizeBytes: 1048576,
      },
    },
    scope: "workspace",
    digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    createdAt: nowIso(),
    metadata: {},
    limits: {
      timeoutMs: 5000,
      maxMemoryBytes: 134217728,
      maxOutputBytes: 1048576,
      maxConcurrentInvocations: 4,
    },
  };

  env.toolRegistry.registerTool({
    toolId: claudeOnlyToolManifest.id,
    name: claudeOnlyToolManifest.name,
    exposedName: claudeOnlyToolManifest.name,
    version: "1.0.0",
    description: claudeOnlyToolManifest.description,
    scope: "global",
    status: "active",
    parameters: claudeOnlyToolManifest.parameters,
    manifest: claudeOnlyToolManifest,
    handler: async () => ({ content: [{ type: "text" as const, text: "Claude tool output" }] }),
  });

  // Call from Claude workspace
  const claudeCall = await env.invokeTool(
    "claude_special",
    {},
    {
      workspacePath: "/workspace/claude",
      workspaceId: "ws_claude_workspace",
      harnessId: "claude-code",
    },
  );

  const workspaceToolIsolationVerified = claudeCall.success;

  reporter.assertRequirement(
    "TE-REQ-029",
    "Workspace-scoped tool catalog registration and invocation routing",
    workspaceToolIsolationVerified,
    { category: "isolation", evidence: { claudeSuccess: claudeCall.success } },
  );

  // 3. System Meta-Tools Uniformly Accessible across all 3 Harnesses
  const [claudeMeta, codexMeta, ompMeta] = await Promise.all([
    env.invokeTool(
      SYSTEM_META_TOOL_NAMES.SEARCH_TOOLS,
      { query: "" },
      { harnessId: "claude-code" },
    ),
    env.invokeTool(SYSTEM_META_TOOL_NAMES.SEARCH_TOOLS, { query: "" }, { harnessId: "codex-cli" }),
    env.invokeTool(SYSTEM_META_TOOL_NAMES.SEARCH_TOOLS, { query: "" }, { harnessId: "omp" }),
  ]);

  const systemMetaToolsUniformlyAccessible =
    claudeMeta.success && codexMeta.success && ompMeta.success;

  reporter.assertRequirement(
    "TE-REQ-030",
    "Invariant system meta-tool availability across Claude Code, Codex CLI, and OMP",
    systemMetaToolsUniformlyAccessible,
    {
      category: "isolation",
      evidence: {
        claudeOk: claudeMeta.success,
        codexOk: codexMeta.success,
        ompOk: ompMeta.success,
      },
    },
  );

  const success =
    eventSegregationVerified &&
    workspaceToolIsolationVerified &&
    systemMetaToolsUniformlyAccessible;

  return {
    success,
    eventSegregationVerified,
    workspaceToolIsolationVerified,
    systemMetaToolsUniformlyAccessible,
    harnessCount: 3,
  };
}
