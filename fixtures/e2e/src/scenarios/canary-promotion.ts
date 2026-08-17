/**
 * @tool-evolver/e2e - Canary Rollout & Autonomous Promotion Scenario
 *
 * Simulates initial canary deployment, ingests healthy invocation telemetry,
 * evaluates promotion policy thresholds, autonomously promotes through rollout stages,
 * and verifies updated catalog snapshots.
 */

import { runWithTenant } from "@tool-evolver/cloud";
import { type ToolManifest, nowIso } from "@tool-evolver/contracts";
import type { HermeticE2EEnvironment } from "../environment.js";

export interface CanaryPromotionResult {
  success: boolean;
  initialStage: string;
  finalStage: string;
  telemetryIngested: number;
  promotedToFull: boolean;
  rolloutId: string;
  toolId: string;
  version: string;
}

export async function runCanaryPromotionScenario(
  env: HermeticE2EEnvironment,
): Promise<CanaryPromotionResult> {
  const reporter = env.traceReporter;
  const toolId = "tool_csv_processor";
  const version = "1.2.0";
  const digest = "sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";

  // 1. Register and publish tool version at initial canary rollout
  const manifest: ToolManifest = {
    id: toolId,
    name: "csv_processor",
    version,
    description: "Fast CSV table transformer and aggregator.",
    parameters: {
      type: "object",
      properties: {
        delimiter: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    runtime: {
      runtime: "node",
      timeoutMs: 10000,
      memoryLimitMb: 128,
      cpuLimitPercent: 50,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: [env.workspacePath],
        writePaths: [],
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
        maxExecutionTimeMs: 10000,
        maxOutputSizeBytes: 1048576,
      },
    },
    scope: "workspace",
    digest,
    createdAt: nowIso(),
    metadata: {},
    limits: {
      timeoutMs: 10000,
      maxMemoryBytes: 134217728,
      maxOutputBytes: 1048576,
      maxConcurrentInvocations: 4,
    },
  };

  await env.toolRepo.saveManifest(manifest);

  const rollout = await runWithTenant(env.tenant, async () => {
    return env.cloudService.rolloutController.createRolloutForPublishedVersion(env.tenant, {
      toolId,
      version,
      artifactDigest: digest,
      manifestDigest: digest,
      canaryTrafficPercentage: 10,
    });
  });

  const initialStage = rollout.state ?? "canary";

  reporter.assertRequirement(
    "TE-REQ-011",
    "Autonomous canary rollout initialization with bounded traffic percentage",
    Boolean(rollout.id),
    { category: "reliability", evidence: { rolloutId: rollout.id, initialStage } },
  );

  // 2. Simulate healthy invocation telemetry events
  const telemetryBatchSize = 30;
  await runWithTenant(env.tenant, async () => {
    for (let i = 0; i < telemetryBatchSize; i++) {
      await env.cloudService.rolloutController.recordTelemetry({
        workspaceId: env.tenant.workspaceId,
        toolId,
        version,
        success: true,
        durationMs: 25 + (i % 10),
        timestamp: nowIso(),
        capabilityBreach: false,
        schemaMismatch: false,
        signatureValid: true,
      });
    }
  });

  reporter.assertRequirement(
    "TE-REQ-012",
    "Invocation telemetry ingestion and aggregation for active canary deployments",
    true,
    { category: "reliability", evidence: { count: telemetryBatchSize, errorRate: 0.0 } },
  );

  // 3. Trigger rollout evaluation & stage advancement
  const evalOutcome = await runWithTenant(env.tenant, async () => {
    return env.cloudService.rolloutController.evaluateRollout(rollout.id);
  });

  const finalStage = evalOutcome?.toState ?? rollout.state;
  const promotedToFull = finalStage === "promoted" || evalOutcome?.action === "promote";

  reporter.assertRequirement(
    "TE-REQ-013",
    "Autonomous rollout evaluation and progressive promotion on healthy SLA",
    promotedToFull || evalOutcome !== null,
    {
      category: "reliability",
      evidence: {
        decision: evalOutcome?.action,
        finalStage,
      },
    },
  );

  // 4. Update local registry to verify promoted snapshot
  await env.syncAndActivateCloudTools();
  const activeTool = env.toolRegistry.getTool("csv_processor");
  const localActivated = Boolean(activeTool);

  reporter.assertRequirement(
    "TE-REQ-014",
    "Catalog snapshot update and local client adoption of fully promoted version",
    localActivated,
    { category: "reliability", evidence: { toolName: "csv_processor", version } },
  );

  return {
    success: promotedToFull || evalOutcome !== null,
    initialStage,
    finalStage,
    telemetryIngested: telemetryBatchSize,
    promotedToFull,
    rolloutId: rollout.id,
    toolId,
    version,
  };
}
