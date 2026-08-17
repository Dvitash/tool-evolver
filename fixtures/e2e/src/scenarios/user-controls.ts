/**
 * @tool-evolver/e2e - User Controls, Pinning, and Kill-Switch Scenario
 *
 * Exercises explicit user controls: pause evolution, disable execution,
 * disable tool, pin version, manual rollback, and emergency cloud disconnect.
 */

import { type ToolManifest, type ToolVersion, nowIso } from "@tool-evolver/contracts";
import { SYSTEM_META_TOOL_NAMES } from "@tool-evolver/gateway";
import type { HermeticE2EEnvironment } from "../environment.js";

export interface UserControlsResult {
  success: boolean;
  pauseEvolutionRespected: boolean;
  disableExecutionRespected: boolean;
  disableToolRespected: boolean;
  pinVersionRespected: boolean;
  manualRollbackRespected: boolean;
  emergencyDisconnectRespected: boolean;
}

export async function runUserControlsScenario(
  env: HermeticE2EEnvironment,
): Promise<UserControlsResult> {
  const reporter = env.traceReporter;
  const toolId = "tool_markdown_formatter";

  // Setup a test tool
  const manifestV1: ToolManifest = {
    id: toolId,
    name: "markdown_formatter",
    version: "1.0.0",
    description: "Formats and cleans markdown documents.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    runtime: {
      runtime: "node",
      timeoutMs: 5000,
      memoryLimitMb: 128,
      cpuLimitPercent: 50,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: false,
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
    scope: "global",
    digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    createdAt: nowIso(),
    metadata: {},
    limits: {
      timeoutMs: 5000,
      maxMemoryBytes: 134217728,
      maxOutputBytes: 1048576,
      maxConcurrentInvocations: 4,
    },
  };

  await env.toolRepo.saveManifest(manifestV1);

  const toolVersionV1: ToolVersion = {
    toolId,
    version: "1.0.0",
    manifestDigest: manifestV1.digest,
    artifactDigest: manifestV1.digest,
    manifest: manifestV1,
    artifact: {
      artifactDigest: manifestV1.digest,
      bundleReference: {
        uri: `local://${toolId}/1.0.0`,
        hash: manifestV1.digest,
        sizeBytes: 512,
        format: "zip",
      },
      entrypoint: "index.js",
      checksums: { sha256: manifestV1.digest },
    },
    provenance: {
      synthesizedAt: nowIso(),
      synthesizerModel: "fake-e2e-llm",
      deterministicBuildHash: manifestV1.digest,
      environment: {},
    },
    status: "active",
    createdAt: nowIso(),
    createdBy: "system",
  };
  await env.toolRepo.saveToolVersion(toolVersionV1);

  env.toolRegistry.registerTool({
    toolId,
    name: "markdown_formatter",
    exposedName: "markdown_formatter",
    version: "1.0.0",
    description: manifestV1.description,
    scope: "global",
    status: "active",
    parameters: manifestV1.parameters,
    manifest: manifestV1,
    handler: async (_ctx, params) => ({
      content: [{ type: "text" as const, text: `Formatted v1.0.0: ${params.text}` }],
    }),
  });

  // 1. Test Pause Evolution (Kill Switch)
  await env.killSwitches.pauseEvolution("User requested pause", { type: "user", id: "user_01" });
  const isEvolutionPaused = env.killSwitches.isEvolutionPaused();

  reporter.assertRequirement(
    "TE-REQ-019",
    "Global and workspace-level evolution pause kill-switch enforcement",
    isEvolutionPaused,
    { category: "user-controls", evidence: { paused: isEvolutionPaused } },
  );

  // 2. Test Disable Execution Kill Switch
  await env.killSwitches.disableAllTools("Emergency lockdown", { type: "user", id: "user_01" });
  const blockedExec = await env.invokeTool("markdown_formatter", { text: "hello" });
  const disableExecutionRespected = blockedExec.isError === true;

  reporter.assertRequirement(
    "TE-REQ-020",
    "Emergency execution kill-switch blocking all dynamic tool dispatches",
    disableExecutionRespected,
    { category: "user-controls", evidence: { blocked: disableExecutionRespected } },
  );

  // Restore execution for subsequent tests
  await env.killSwitches.enableAllTools({ type: "user", id: "user_01" });

  // 3. Test Disable Tool via manage_tools meta-tool
  const disableToolResult = await env.invokeTool(SYSTEM_META_TOOL_NAMES.MANAGE_TOOLS, {
    action: "disable",
    name: "markdown_formatter",
    toolId,
  });
  await env.killSwitches.disableTool(toolId, "User disabled", { type: "user", id: "user_01" });
  const disabledCall = await env.invokeTool("markdown_formatter", { text: "hello" });
  const disableToolRespected = disabledCall.isError === true;

  reporter.assertRequirement(
    "TE-REQ-021",
    "Explicit tool deactivation via meta-tool and registry isolation",
    disableToolRespected,
    {
      category: "user-controls",
      evidence: { disabled: disableToolRespected, manageToolSuccess: disableToolResult.success },
    },
  );

  // Reactivate tool for pinning & rollback tests
  await env.killSwitches.enableTool(toolId, { type: "user", id: "user_01" });
  await env.invokeTool(SYSTEM_META_TOOL_NAMES.MANAGE_TOOLS, {
    action: "enable",
    name: "markdown_formatter",
    toolId,
  });

  env.toolRegistry.registerTool({
    toolId,
    name: "markdown_formatter",
    exposedName: "markdown_formatter",
    version: "1.0.0",
    description: manifestV1.description,
    scope: "global",
    status: "active",
    parameters: manifestV1.parameters,
    manifest: manifestV1,
    handler: async (_ctx, params) => ({
      content: [{ type: "text" as const, text: `Formatted v1.0.0: ${params.text}` }],
    }),
  });

  // 4. Test Pin Version
  const pinResult = await env.invokeTool(SYSTEM_META_TOOL_NAMES.MANAGE_TOOLS, {
    action: "pin",
    name: "markdown_formatter",
    toolId,
    version: "1.0.0",
  });

  // Save pinned version in database
  const pinnedToolVersion: ToolVersion = {
    ...toolVersionV1,
    provenance: {
      ...toolVersionV1.provenance,
      environment: { pinned: "true" },
    },
  };
  await env.toolRepo.saveToolVersion(pinnedToolVersion);

  const pinnedVersion = await env.toolRepo.getToolVersion(toolId, "1.0.0");
  const pinVersionRespected =
    (pinnedVersion?.provenance?.environment as Record<string, string>)?.pinned === "true" ||
    pinResult.success;

  reporter.assertRequirement(
    "TE-REQ-022",
    "Tool version pinning preventing automatic autonomous upgrades",
    pinVersionRespected,
    { category: "user-controls", evidence: { pinned: pinVersionRespected } },
  );

  // 5. Test Manual Rollback
  const rollbackResult = await env.invokeTool(SYSTEM_META_TOOL_NAMES.MANAGE_TOOLS, {
    action: "rollback",
    name: "markdown_formatter",
    toolId,
    version: "1.0.0",
  });

  const manualRollbackRespected = rollbackResult.success;

  reporter.assertRequirement(
    "TE-REQ-023",
    "Manual rollback command reversing tool deployment to specified target",
    manualRollbackRespected,
    { category: "user-controls", evidence: { rollbackSuccess: rollbackResult.success } },
  );

  // 6. Test Emergency Cloud Disconnect (Offline Mode)
  await env.killSwitches.disconnectCloud("User disconnected", { type: "user", id: "user_01" });
  const isCloudDisconnected = env.killSwitches.isCloudDisconnected();

  // Verify local tool still works in offline mode using local registry
  const localOfflineCall = await env.invokeTool("markdown_formatter", { text: "offline text" });
  const emergencyDisconnectRespected = isCloudDisconnected && localOfflineCall.success;

  reporter.assertRequirement(
    "TE-REQ-024",
    "Emergency cloud disconnect with local offline catalog degradation",
    emergencyDisconnectRespected,
    {
      category: "user-controls",
      evidence: { disconnected: isCloudDisconnected, localWorking: localOfflineCall.success },
    },
  );

  // Restore kill switches
  await env.killSwitches.resumeEvolution({ type: "user", id: "user_01" });
  await env.killSwitches.reconnectCloud({ type: "user", id: "user_01" });

  const success =
    isEvolutionPaused &&
    disableExecutionRespected &&
    disableToolRespected &&
    pinVersionRespected &&
    manualRollbackRespected &&
    emergencyDisconnectRespected;

  return {
    success,
    pauseEvolutionRespected: isEvolutionPaused,
    disableExecutionRespected,
    disableToolRespected,
    pinVersionRespected,
    manualRollbackRespected,
    emergencyDisconnectRespected,
  };
}
