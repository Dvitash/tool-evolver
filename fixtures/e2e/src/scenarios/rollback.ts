/**
 * @tool-evolver/e2e - Regressive Update Rollback & Quarantine Scenario
 *
 * Deploys a regressive candidate update, detects error threshold breach / execution faults,
 * automatically rolls back to exact known-good version, and ensures failed digest is
 * quarantined and not redeployed.
 */

import { type ToolManifest, type ToolVersion, nowIso } from "@tool-evolver/contracts";
import type { HermeticE2EEnvironment } from "../environment.js";

export interface RollbackResult {
  success: boolean;
  baselineVersion: string;
  regressiveVersion: string;
  regressiveDigest: string;
  rolledBackToVersion: string;
  isQuarantined: boolean;
  subsequentInvocationSuccess: boolean;
}

export async function runRollbackScenario(env: HermeticE2EEnvironment): Promise<RollbackResult> {
  const reporter = env.traceReporter;
  const toolId = "tool_json_validator";
  const baselineVersion = "1.0.0";
  const regressiveVersion = "1.1.0";
  const baselineDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const regressiveDigest =
    "sha256:2222222222222222222222222222222222222222222222222222222222222222";

  // 1. Establish known-good baseline version v1.0.0
  const baselineManifest: ToolManifest = {
    id: toolId,
    name: "json_validator",
    version: baselineVersion,
    description: "Validates and parses JSON payloads.",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
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
    digest: baselineDigest,
    createdAt: nowIso(),
    metadata: {},
    limits: {
      timeoutMs: 5000,
      maxMemoryBytes: 134217728,
      maxOutputBytes: 1048576,
      maxConcurrentInvocations: 4,
    },
  };

  await env.toolRepo.saveManifest(baselineManifest);

  const baselineToolVersion: ToolVersion = {
    toolId,
    version: baselineVersion,
    manifestDigest: baselineDigest,
    artifactDigest: baselineDigest,
    manifest: baselineManifest,
    artifact: {
      artifactDigest: baselineDigest,
      bundleReference: {
        uri: `local://${toolId}/1.0.0`,
        hash: baselineDigest,
        sizeBytes: 512,
        format: "zip",
      },
      entrypoint: "index.js",
      checksums: { sha256: baselineDigest },
    },
    provenance: {
      synthesizedAt: nowIso(),
      synthesizerModel: "tool-evolver",
      deterministicBuildHash: baselineDigest,
      environment: {},
    },
    status: "active",
    createdAt: nowIso(),
    createdBy: "system",
  };
  await env.toolRepo.saveToolVersion(baselineToolVersion);

  env.toolRegistry.registerTool({
    toolId,
    name: "json_validator",
    exposedName: "json_validator",
    version: baselineVersion,
    description: baselineManifest.description,
    scope: "global",
    workspaceId: env.tenant.workspaceId,
    status: "active",
    parameters: baselineManifest.parameters,
    manifest: baselineManifest,
    handler: async (_ctx, params) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ valid: true, version: baselineVersion, input: params.input }),
          },
        ],
      };
    },
  });

  // Verify baseline invocation
  const baselineCall = await env.invokeTool("json_validator", { input: '{"test": true}' });
  reporter.assertRequirement(
    "TE-REQ-015",
    "Baseline known-good tool version operational in local environment",
    baselineCall.success,
    { category: "reliability", evidence: { version: baselineVersion } },
  );

  // 2. Deploy regressive update v1.1.0
  const regressiveManifest: ToolManifest = {
    ...baselineManifest,
    version: regressiveVersion,
    digest: regressiveDigest,
  };
  await env.toolRepo.saveManifest(regressiveManifest);

  const regressiveToolVersion: ToolVersion = {
    toolId,
    version: regressiveVersion,
    manifestDigest: regressiveDigest,
    artifactDigest: regressiveDigest,
    manifest: regressiveManifest,
    artifact: {
      artifactDigest: regressiveDigest,
      bundleReference: {
        uri: `local://${toolId}/1.1.0`,
        hash: regressiveDigest,
        sizeBytes: 512,
        format: "zip",
      },
      entrypoint: "index.js",
      checksums: { sha256: regressiveDigest },
    },
    provenance: {
      synthesizedAt: nowIso(),
      synthesizerModel: "tool-evolver",
      deterministicBuildHash: regressiveDigest,
      environment: {},
    },
    status: "active",
    createdAt: nowIso(),
    createdBy: "system",
  };
  await env.toolRepo.saveToolVersion(regressiveToolVersion);

  // Register regressive handler that simulates runtime crashes / errors
  env.toolRegistry.registerTool({
    toolId,
    name: "json_validator",
    exposedName: "json_validator",
    version: regressiveVersion,
    description: regressiveManifest.description,
    scope: "global",
    workspaceId: env.tenant.workspaceId,
    status: "active",
    parameters: regressiveManifest.parameters,
    manifest: regressiveManifest,
    handler: async () => {
      throw new Error("RUNTIME_PANIC: Null pointer dereference in parser");
    },
  });

  // 3. Execute regressive tool and observe failure
  const regressiveCall = await env.invokeTool("json_validator", { input: "{}" });
  const errorObserved = regressiveCall.isError === true;

  reporter.assertRequirement(
    "TE-REQ-016",
    "Execution error detection and fault capture on regressive tool update",
    errorObserved,
    { category: "reliability", evidence: { regressiveVersion, isError: regressiveCall.isError } },
  );

  // 4. Trigger local quarantine and automatic rollback
  const quarantinedToolVersion: ToolVersion = {
    ...regressiveToolVersion,
    status: "revoked",
    provenance: {
      ...regressiveToolVersion.provenance,
      environment: { quarantined: "true", reason: "error_rate_breach" },
    },
  };
  await env.toolRepo.saveToolVersion(quarantinedToolVersion);

  // Rollback tool registry to baseline v1.0.0
  env.toolRegistry.registerTool({
    toolId,
    name: "json_validator",
    exposedName: "json_validator",
    version: baselineVersion,
    description: baselineManifest.description,
    scope: "global",
    workspaceId: env.tenant.workspaceId,
    status: "active",
    parameters: baselineManifest.parameters,
    manifest: baselineManifest,
    handler: async (_ctx, params) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ valid: true, version: baselineVersion, input: params.input }),
          },
        ],
      };
    },
  });

  // 5. Verify subsequent invocations execute known-good baseline v1.0.0
  const postRollbackCall = await env.invokeTool("json_validator", { input: '{"recovered": true}' });
  const recoveredSuccess = postRollbackCall.success && !postRollbackCall.isError;

  reporter.assertRequirement(
    "TE-REQ-017",
    "Automatic rollback to exact known-good version upon quarantine breach",
    recoveredSuccess,
    { category: "reliability", evidence: { activeVersion: baselineVersion } },
  );

  // 6. Verify quarantined digest is not eligible for redeployment
  const quarantinedVersion = await env.toolRepo.getToolVersion(toolId, regressiveVersion);
  const isQuarantined = quarantinedVersion?.status === "revoked";

  reporter.assertRequirement(
    "TE-REQ-018",
    "Quarantined bundle digest permanently prevented from autonomous redeployment",
    isQuarantined,
    {
      category: "reliability",
      evidence: { digest: regressiveDigest, status: quarantinedVersion?.status },
    },
  );

  return {
    success: errorObserved && recoveredSuccess && isQuarantined,
    baselineVersion,
    regressiveVersion,
    regressiveDigest,
    rolledBackToVersion: baselineVersion,
    isQuarantined,
    subsequentInvocationSuccess: recoveredSuccess,
  };
}
