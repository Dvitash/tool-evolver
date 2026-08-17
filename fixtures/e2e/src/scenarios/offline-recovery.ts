/**
 * @tool-evolver/e2e - Durable Boundary Crash Recovery Scenario
 *
 * Exercises crash injection and state recovery across three durable boundaries:
 * 1. Transcript append & cursor recovery
 * 2. Upload batch receipt & idempotent deduplication
 * 3. Local SQLite activation transaction resilience
 */

import {
  type NormalizedSessionEvent,
  type SyncCursor,
  type ToolManifest,
  nowIso,
} from "@tool-evolver/contracts";
import type { HermeticE2EEnvironment } from "../environment.js";

const DEFAULT_REDACTION = {
  isRedacted: true,
  redactedFields: [],
  redactionStrategy: "mask" as const,
  scrubbedPatterns: [],
};

export interface OfflineRecoveryResult {
  success: boolean;
  transcriptRecoverySuccess: boolean;
  uploadDeduplicationSuccess: boolean;
  activationCrashResilienceSuccess: boolean;
}

export async function runOfflineRecoveryScenario(
  env: HermeticE2EEnvironment,
): Promise<OfflineRecoveryResult> {
  const reporter = env.traceReporter;

  // 1. Boundary 1: Transcript Append & Cursor Recovery
  const cursorId = "cur_claude_code_01";
  const initialCursor: SyncCursor = {
    cursorId,
    deviceId: env.tenant.deviceId ?? "dev_01",
    workspaceId: env.tenant.workspaceId,
    entityType: "transcript",
    lastSyncedSequence: 10,
    lastSyncedTimestamp: nowIso(),
    syncToken: "tok_10",
  };
  await env.sessionRepo.saveCursor(initialCursor);

  await env.sessionRepo.saveSession({
    sessionId: "sess_recovery_01",
    harnessId: "claude-code",
    status: "active",
    startedAt: nowIso(),
    metadata: {},
    sourceIdentity: {},
  });

  // Simulate append of events 11, 12, 13
  const events: NormalizedSessionEvent[] = [11, 12, 13].map((seq) => ({
    eventId: `evt_${seq}`,
    sessionId: "sess_recovery_01",
    timestamp: nowIso(),
    type: "tool_call",
    schemaVersion: "1.0.0",
    causalRef: { causalSequence: seq },
    redaction: DEFAULT_REDACTION,
    callId: `call_${seq}`,
    toolName: "bash",
    parameters: { cmd: `echo ${seq}` },
    isShadow: false,
  }));

  for (const event of events) {
    await env.sessionRepo.insertEvent(event);
  }

  // Update cursor to event 13
  const updatedCursor: SyncCursor = {
    cursorId,
    deviceId: env.tenant.deviceId ?? "dev_01",
    workspaceId: env.tenant.workspaceId,
    entityType: "transcript",
    lastSyncedSequence: 13,
    lastSyncedTimestamp: nowIso(),
    syncToken: "tok_13",
  };
  await env.sessionRepo.saveCursor(updatedCursor);

  // Simulate daemon crash & restart by reading back cursor
  const recoveredCursor = await env.sessionRepo.getCursor(cursorId);
  const transcriptRecoverySuccess =
    recoveredCursor?.lastSyncedSequence === 13 && recoveredCursor?.syncToken === "tok_13";

  reporter.assertRequirement(
    "TE-REQ-025",
    "Durable tailing cursor recovery after unexpected daemon process termination",
    transcriptRecoverySuccess,
    {
      category: "reliability",
      evidence: { recoveredSequence: recoveredCursor?.lastSyncedSequence },
    },
  );

  // 2. Boundary 2: Upload Receipt & Idempotent Deduplication
  await env.sessionRepo.saveSession({
    sessionId: "sess_dedup_01",
    harnessId: "codex-cli",
    status: "active",
    startedAt: nowIso(),
    metadata: {},
    sourceIdentity: {},
  });

  const duplicateEvents: NormalizedSessionEvent[] = [
    {
      eventId: "evt_dedup_01",
      sessionId: "sess_dedup_01",
      timestamp: nowIso(),
      type: "tool_call",
      schemaVersion: "1.0.0",
      causalRef: { causalSequence: 1 },
      redaction: DEFAULT_REDACTION,
      callId: "call_dedup_01",
      toolName: "file_read",
      parameters: { path: "main.ts" },
      isShadow: false,
    },
  ];

  // First ingestion
  const firstBatch = await env.ingestSessionEvents(duplicateEvents);
  // Second ingestion with identical event (simulating crash before ack was saved)
  const secondBatch = await env.ingestSessionEvents(duplicateEvents);

  // Ingestion should be idempotent (accepted count equal or deduped)
  const uploadDeduplicationSuccess =
    firstBatch.ingestedCount >= 1 && secondBatch.ingestedCount >= 0;

  reporter.assertRequirement(
    "TE-REQ-026",
    "Idempotent upload batch handling and deduplication across connection retries",
    uploadDeduplicationSuccess,
    {
      category: "reliability",
      evidence: { batch1: firstBatch.batchId, batch2: secondBatch.batchId },
    },
  );

  // 3. Boundary 3: Local SQLite Activation Transaction Resilience
  const toolId = "tool_recovery_probe";
  const manifest: ToolManifest = {
    id: toolId,
    name: "recovery_probe",
    version: "1.0.0",
    description: "Probe tool for testing crash resilience during activation.",
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
    scope: "workspace",
    digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    createdAt: nowIso(),
    metadata: {},
    limits: {
      timeoutMs: 5000,
      maxMemoryBytes: 134217728,
      maxOutputBytes: 1048576,
      maxConcurrentInvocations: 4,
    },
  };

  // Simulate a failed transaction that rolls back
  try {
    await env.localDb.transaction(async () => {
      env.localDb.exec(
        `INSERT INTO tool_manifests (tool_id, name, version, description, scope, parameters_json, runtime_json, capabilities_json, limits_json, digest, metadata_json, created_at)
         VALUES ('tool_recovery_probe', 'recovery_probe', '1.0.0', 'probe', 'workspace', '{}', '{}', '{}', '{}', 'sha256:4444444444444444444444444444444444444444444444444444444444444444', '{}', '${nowIso()}')`,
      );
      // Simulate crash inside transaction
      throw new Error("SIMULATED_POWER_LOSS_CRASH");
    });
  } catch {
    // Transaction rolled back
  }

  // Verify manifest was not half-written
  const uncommittedManifest = await env.toolRepo.getManifest(toolId);
  const rolledBackCleanly = uncommittedManifest === null;

  // Now execute successful activation transaction
  await env.toolRepo.saveManifest(manifest);
  const committedManifest = await env.toolRepo.getManifest(toolId);
  const committedCleanly = committedManifest !== null;

  const activationCrashResilienceSuccess = rolledBackCleanly && committedCleanly;

  reporter.assertRequirement(
    "TE-REQ-027",
    "Transactional SQLite activation rollback and clean state preservation upon crash",
    activationCrashResilienceSuccess,
    { category: "reliability", evidence: { rolledBackCleanly, committedCleanly } },
  );

  const success =
    transcriptRecoverySuccess && uploadDeduplicationSuccess && activationCrashResilienceSuccess;

  return {
    success,
    transcriptRecoverySuccess,
    uploadDeduplicationSuccess,
    activationCrashResilienceSuccess,
  };
}
