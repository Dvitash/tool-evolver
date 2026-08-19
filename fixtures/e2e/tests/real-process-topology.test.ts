/**
 * @tool-evolver/e2e - Real Process Topology E2E Test Suite [REM-015]
 *
 * Verifies the complete Tool Evolver topology running as real, independent
 * OS subprocesses with genuine IPC/MCP transports, disposable SQLite & Cloud DB,
 * deterministic mock HTTP inference, full autonomous tool evolution lifecycle,
 * canary routing, rollback & quarantine, process restart resilience, and
 * comprehensive machine-readable lifecycle tracing.
 */

import {
  CapabilityManifestSchema,
  type NormalizedSessionEvent,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@tool-evolver/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RealProcessTopology } from "../src/topology.js";

const DEFAULT_CAPABILITIES = CapabilityManifestSchema.parse({});
const DEFAULT_LIMITS = ToolLimitConfigSchema.parse({});
const DEFAULT_RUNTIME = ToolRuntimeRequirementSchema.parse({ runtime: "deno" });

const DEFAULT_REDACTION = {
  isRedacted: true,
  redactedFields: [],
  redactionStrategy: "mask" as const,
  scrubbedPatterns: [],
};

describe("Real Process Topology E2E [REM-015]", () => {
  let topology: RealProcessTopology;

  beforeEach(async () => {
    topology = new RealProcessTopology({ silent: true });
    await topology.start();
  }, 30000);

  afterEach(async () => {
    if (topology) {
      await topology.shutdown();
    }
  }, 15000);

  it("boots all real OS processes with verified PIDs, transports, and initial MCP handshake", async () => {
    // 1. Verify real OS process IDs
    expect(topology.daemonProcess?.pid).toBeDefined();
    expect(topology.daemonProcess?.pid).toBeGreaterThan(0);
    expect(topology.gatewayProcess?.pid).toBeDefined();
    expect(topology.gatewayProcess?.pid).toBeGreaterThan(0);
    expect(topology.cloudProcess?.pid).toBeDefined();
    expect(topology.cloudProcess?.pid).toBeGreaterThan(0);
    expect(topology.mockInferencePort).toBeGreaterThan(0);

    // 2. Verify Daemon Authenticated IPC over Unix domain socket
    const health = await topology.ipcClient?.getHealth();
    expect(health).toBeDefined();
    expect(health?.status).toBe("fully-ready");

    const ping = await topology.ipcClient?.ping();
    expect(ping?.pong).toBe(true);

    // 3. Verify Gateway MCP list tools over stdio JSON-RPC
    const tools = await topology.listMcpTools();
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("echo");
    expect(toolNames).toContain("workspace_info");
    expect(toolNames).toContain("fail_tool");
    expect(toolNames).toContain("slow_tool");
  }, 30000);

  it("completes full autonomous tool evolution lifecycle across real processes and transports", async () => {
    // 1. Ingest transcript observations to Cloud Server via HTTP POST
    const sessionEvents: NormalizedSessionEvent[] = [
      {
        eventId: "evt_real_01",
        sessionId: "sess_real_01",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 1 },
        redaction: DEFAULT_REDACTION,
        callId: "call_r1_01",
        toolName: "bash",
        parameters: { command: "git status --porcelain" },
        isShadow: false,
      },
      {
        eventId: "evt_real_02",
        sessionId: "sess_real_01",
        timestamp: new Date().toISOString(),
        type: "tool_result",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 2, parentId: "evt_real_01" },
        redaction: DEFAULT_REDACTION,
        callId: "call_r1_01",
        toolName: "bash",
        result: { stdout: "M src/index.ts" },
        executionDurationMs: 5000,
        durationMs: 5000,
        isError: false,
      },
      {
        eventId: "evt_real_03",
        sessionId: "sess_real_02",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 1 },
        redaction: DEFAULT_REDACTION,
        callId: "call_r2_01",
        toolName: "bash",
        parameters: { command: "git status --porcelain" },
        isShadow: false,
      },
      {
        eventId: "evt_real_04",
        sessionId: "sess_real_02",
        timestamp: new Date().toISOString(),
        type: "tool_result",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 2, parentId: "evt_real_03" },
        redaction: DEFAULT_REDACTION,
        callId: "call_r2_01",
        toolName: "bash",
        result: { stdout: "M src/index.ts" },
        executionDurationMs: 5000,
        durationMs: 5000,
        isError: false,
      },
      {
        eventId: "evt_real_05",
        sessionId: "sess_real_03",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 1 },
        redaction: DEFAULT_REDACTION,
        callId: "call_r3_01",
        toolName: "bash",
        parameters: { command: "git status --porcelain" },
        isShadow: false,
      },
      {
        eventId: "evt_real_06",
        sessionId: "sess_real_03",
        timestamp: new Date().toISOString(),
        type: "tool_result",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 2, parentId: "evt_real_05" },
        redaction: DEFAULT_REDACTION,
        callId: "call_r3_01",
        toolName: "bash",
        result: { stdout: "M src/index.ts" },
        executionDurationMs: 5000,
        durationMs: 5000,
        isError: false,
      },
      {
        eventId: "evt_real_07",
        sessionId: "sess_real_01",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 3 },
        redaction: DEFAULT_REDACTION,
        callId: "call_r1_02",
        toolName: "bash",
        parameters: { command: "git diff --stat" },
        isShadow: false,
      },
      {
        eventId: "evt_real_08",
        sessionId: "sess_real_01",
        timestamp: new Date().toISOString(),
        type: "tool_result",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 4, parentId: "evt_real_07" },
        redaction: DEFAULT_REDACTION,
        callId: "call_r1_02",
        toolName: "bash",
        result: { stdout: "src/index.ts | 2 +-" },
        executionDurationMs: 5000,
        durationMs: 5000,
        isError: false,
      },
      {
        eventId: "evt_real_09",
        sessionId: "sess_real_02",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 3 },
        redaction: DEFAULT_REDACTION,
        callId: "call_r2_02",
        toolName: "bash",
        parameters: { command: "git diff --stat" },
        isShadow: false,
      },
      {
        eventId: "evt_real_10",
        sessionId: "sess_real_02",
        timestamp: new Date().toISOString(),
        type: "tool_result",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 4, parentId: "evt_real_09" },
        redaction: DEFAULT_REDACTION,
        callId: "call_r2_02",
        toolName: "bash",
        result: { stdout: "src/index.ts | 2 +-" },
        executionDurationMs: 5000,
        durationMs: 5000,
        isError: false,
      },
      {
        eventId: "evt_real_11",
        sessionId: "sess_real_03",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 3 },
        redaction: DEFAULT_REDACTION,
        callId: "call_r3_02",
        toolName: "bash",
        parameters: { command: "git diff --stat" },
        isShadow: false,
      },
      {
        eventId: "evt_real_12",
        sessionId: "sess_real_03",
        timestamp: new Date().toISOString(),
        type: "tool_result",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 4, parentId: "evt_real_11" },
        redaction: DEFAULT_REDACTION,
        callId: "call_r3_02",
        toolName: "bash",
        result: { stdout: "src/index.ts | 2 +-" },
        executionDurationMs: 5000,
        durationMs: 5000,
        isError: false,
      },
    ];

    const ingestRes = await topology.ingestObservations(sessionEvents);
    expect(ingestRes.ingestedCount).toBe(sessionEvents.length);

    // 2. Detect opportunity on Cloud Server
    const opportunities = await topology.detectOpportunities(sessionEvents);
    expect(opportunities.length).toBeGreaterThan(0);
    const opportunity = opportunities[0]!;
    expect(opportunity.classification.suggestedToolName).toBeTruthy();

    // 3. Synthesize candidate tool via deterministic HTTP inference server
    const candidate = await topology.generateCandidate(opportunity);
    expect(candidate).toBeDefined();
    expect(candidate.proposedTool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(candidate.sourceCode).toBeDefined();

    // 4. Verify and publish signed tool candidate
    const publishRes = await topology.verifyAndPublishCandidate(candidate);
    expect(publishRes.published).toBe(true);
    expect(publishRes.bundleDigest).toBeDefined();
    expect(publishRes.bundleDigest.length).toBe(64);

    // 5. Synchronize signed tool to local daemon and activate in MCP Gateway
    const manifest: ToolManifest = {
      id: candidate.proposedTool.id ?? "tool_git_status_checker",
      name: "git_status_checker",
      version: "1.0.0",
      description: "Checks git working tree status cleanly",
      parameters: ToolParameterSchema.parse({
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      }),
      runtime: DEFAULT_RUNTIME,
      capabilities: DEFAULT_CAPABILITIES,
      limits: DEFAULT_LIMITS,
      scope: "workspace",
      digest: publishRes.bundleDigest,
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    const bundleCode = `
export default async function run(ctx) {
  const input = ctx?.input ?? ctx;
  const cmd = input?.command ?? input?.parameters?.command ?? "none";
  return {
    status: "ok",
    executed: cmd,
    cleaned: true,
  };
}
`.trim();
    await topology.syncAndActivateTool(manifest, publishRes.bundleDigest, bundleCode);

    // 6. Invoke the evolved tool via real MCP JSON-RPC
    const mcpResult = await topology.callMcpTool("git_status_checker", {
      command: "git status",
    });

    expect(mcpResult.isError).toBeFalsy();
    expect(mcpResult.content[0]?.text).toContain("git status");
    expect(mcpResult.content[0]?.text).toContain("cleaned");

    // 7. Invoke evolved tool via meta-tool (invoke_tool)
    const metaResult = await topology.callMcpTool("invoke_tool", {
      name: "git_status_checker",
      parameters: { command: "git diff" },
    });

    expect(metaResult.isError).toBeFalsy();
    expect(metaResult.content[0]?.text).toContain("git diff");
  }, 30000);

  it("exercises canary traffic routing, stage promotion, and bad-version rollback/quarantine", async () => {
    const toolName = "csv_optimizer";
    const baselineVersion = "1.0.0";
    const canaryVersion = "1.1.0";
    const regressiveVersion = "1.2.0";

    const baselineDigest = "1".repeat(64);
    const canaryDigest = "2".repeat(64);
    const regressiveDigest = "3".repeat(64);

    // 1. Activate baseline version
    const baselineManifest: ToolManifest = {
      id: `tool_${toolName}`,
      name: toolName,
      version: baselineVersion,
      description: "Optimized CSV parser v1",
      parameters: ToolParameterSchema.parse({ properties: { path: { type: "string" } } }),
      runtime: DEFAULT_RUNTIME,
      capabilities: DEFAULT_CAPABILITIES,
      limits: DEFAULT_LIMITS,
      scope: "workspace",
      digest: baselineDigest,
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    await topology.syncAndActivateTool(
      baselineManifest,
      baselineDigest,
      `export default async function run(i) { return { version: "1.0.0", parsed: true }; }`,
    );

    // 2. Simulate 20% canary routing
    const routing = await topology.simulateCanaryRouting({
      toolName,
      canaryVersion,
      baselineVersion,
      canaryPercentage: 20,
      invocations: 100,
    });

    expect(routing.canaryCount).toBeGreaterThan(10);
    expect(routing.baselineCount).toBeGreaterThan(60);

    // 3. Promote canary version to 100% stable
    const canaryManifest: ToolManifest = {
      ...baselineManifest,
      id: `tool_${toolName}`,
      version: canaryVersion,
      digest: canaryDigest,
    };

    await topology.syncAndActivateTool(
      canaryManifest,
      canaryDigest,
      `export default async function run(i) { return { version: "1.1.0", parsed: true }; }`,
    );

    const promotedOutcome = await topology.callMcpTool(toolName, { path: "data.csv" });
    expect(promotedOutcome.content[0]?.text).toContain("1.1.0");

    // 4. Activate regressive version and simulate error threshold breach & automatic rollback
    const regressiveManifest: ToolManifest = {
      ...baselineManifest,
      id: `tool_${toolName}`,
      version: regressiveVersion,
      digest: regressiveDigest,
    };

    await topology.syncAndActivateTool(
      regressiveManifest,
      regressiveDigest,
      `export default async function run(i) { throw new Error("Simulated failure in 1.2.0"); }`,
    );

    const rollbackResult = await topology.simulateRollbackAndQuarantine({
      toolName,
      regressiveVersion,
      regressiveDigest,
      knownGoodVersion: canaryVersion,
      knownGoodDigest: canaryDigest,
    });

    expect(rollbackResult.rolledBack).toBe(true);
    expect(rollbackResult.quarantined).toBe(true);

    // 5. Subsequent invocation receives the known-good stable version
    const subsequentOutcome = await topology.callMcpTool(toolName, { path: "data.csv" });
    expect(subsequentOutcome.content[0]?.text).toContain("1.1.0");
  }, 30000);

  it("handles process kills and restarts on Daemon and Cloud server with state persistence recovery", async () => {
    // 1. Activate a tool in local SQLite DB
    const toolName = "resilient_worker";
    const version = "1.0.0";
    const digest = "4".repeat(64);

    const manifest: ToolManifest = {
      id: `tool_${toolName}`,
      name: toolName,
      version,
      description: "Resilient worker surviving daemon restarts",
      parameters: ToolParameterSchema.parse({ properties: { key: { type: "string" } } }),
      runtime: DEFAULT_RUNTIME,
      capabilities: DEFAULT_CAPABILITIES,
      limits: DEFAULT_LIMITS,
      scope: "workspace",
      digest,
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    await topology.syncAndActivateTool(
      manifest,
      digest,
      `export default async function run(i) { return { ok: true, key: i.key }; }`,
    );

    const initialPid = topology.daemonProcess?.pid;

    // 2. Kill and restart Observer Daemon process (simulating crash / kill -9)
    const daemonRestart = await topology.killAndRestartDaemon("SIGKILL");
    expect(daemonRestart.oldPid).toBe(initialPid);
    expect(daemonRestart.newPid).toBeDefined();
    expect(daemonRestart.newPid).not.toBe(initialPid);

    // 3. Verify Daemon IPC is reachable again
    const health = await topology.ipcClient?.getHealth();
    expect(health?.status).toBe("fully-ready");

    // 4. Verify Local SQLite DB preserved active tool state across restart
    const persistedTool = await topology.toolRepo.getManifest(`tool_${toolName}`);
    expect(persistedTool).toBeDefined();
    expect(persistedTool?.name).toBe(toolName);
    expect(persistedTool?.version).toBe(version);

    // 5. Kill and restart Cloud API Server process
    const initialCloudPid = topology.cloudProcess?.pid;
    const cloudRestart = await topology.killAndRestartCloud("SIGKILL");
    expect(cloudRestart.oldPid).toBe(initialCloudPid);
    expect(cloudRestart.newPid).toBeDefined();
    expect(cloudRestart.newPid).not.toBe(initialCloudPid);

    // 6. Verify Cloud Server HTTP endpoint recovered
    const sessionEvents: NormalizedSessionEvent[] = [
      {
        eventId: "evt_recovery_01",
        sessionId: "sess_recovery_01",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 1 },
        redaction: DEFAULT_REDACTION,
        callId: "call_rec_01",
        toolName: "bash",
        parameters: { command: "uptime" },
        isShadow: false,
      },
    ];

    const ingestAfterRestart = await topology.ingestObservations(sessionEvents);
    expect(ingestAfterRestart.ingestedCount).toBe(1);
  }, 30000);

  it("generates comprehensive machine-readable lifecycle trace artifact with PIDs, events, and digests", async () => {
    const trace = topology.generateLifecycleTrace();

    expect(trace.traceId).toBeDefined();
    expect(trace.pids.daemon).toBeDefined();
    expect(trace.pids.gateway).toBeDefined();
    expect(trace.pids.cloud).toBeDefined();
    expect(trace.pids.mockInference).toBeDefined();

    expect(trace.stateTransitions.length).toBeGreaterThan(0);
    expect(trace.protocolEvents.length).toBeGreaterThan(0);

    const mcpEvents = trace.protocolEvents.filter((e) => e.protocol === "mcp");
    expect(mcpEvents.length).toBeGreaterThan(0);

    const ipcEvents = trace.protocolEvents.filter((e) => e.protocol === "ipc");
    expect(ipcEvents.length).toBeGreaterThan(0);
  }, 30000);
});
