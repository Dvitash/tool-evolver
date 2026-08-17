import {
  type EvaluationResult,
  type EvolutionCandidate,
  type ToolManifest,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import { MemoryDatabasePool } from "../../../src/db/client.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { OutboxPublisher } from "../../../src/db/outbox.js";
import { ArtifactBuilder } from "../../../src/evolution/artifacts/builder.js";
import {
  SigningKeyRepository,
  ToolRegistryRepository,
} from "../../../src/evolution/artifacts/repositories/index.js";
import { ToolArtifactRegistryService } from "../../../src/evolution/artifacts/service.js";
import { ArtifactSigner } from "../../../src/evolution/artifacts/signer.js";
import { SemanticVersionClassifier } from "../../../src/evolution/artifacts/versioning.js";
import { MemoryObjectStore } from "../../../src/storage/object-store.js";

/**
 * Creates a valid mock ToolManifest for testing.
 */
export function computeManifestDigest(
  manifest: Omit<ToolManifest, "digest"> | ToolManifest,
): string {
  const { digest: _digest, ...rest } = manifest as ToolManifest;
  return hashCanonicalContent(rest);
}

export function createMockToolManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  const base: Omit<ToolManifest, "digest"> = {
    id: "tool_test_calculator",
    name: "Calculator Tool",
    version: "1.0.0",
    description: "Performs mathematical calculations.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Operation type (add, subtract, multiply, divide)",
          enum: ["add", "subtract", "multiply", "divide"],
        },
        a: {
          type: "number",
          description: "First operand",
        },
        b: {
          type: "number",
          description: "Second operand",
        },
      },
      required: ["operation", "a", "b"],
    },
    outputSchema: {
      type: "object",
      properties: {
        result: {
          type: "number",
          description: "Computed result",
        },
      },
      required: ["result"],
    },
    runtime: {
      runtime: "node",
      minRuntimeVersion: "18.0.0",
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
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
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: {
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: "workspace",
    metadata: {},
    createdAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };

  const digest = overrides.digest ?? computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

/**
 * Creates a valid mock EvolutionCandidate for testing.
 */
export function createMockEvolutionCandidate(
  overrides: Partial<EvolutionCandidate> = {},
): EvolutionCandidate {
  const proposedTool = overrides.proposedTool ?? createMockToolManifest();

  return {
    id: "cand_01JTEST001",
    workspaceId: "ws_test_001",
    state: "approved",
    trigger: {
      reason: "repeated_pattern",
      evidenceEventIds: ["evt_01JTEST001"],
      sessionOccurrences: 3,
      detectedAt: "2026-08-17T00:00:00.000Z",
      patternFrequency: 3,
    },
    proposedTool,
    requiredCapabilities: proposedTool.capabilities,
    sourceCode: `
export async function run(params: { operation: string; a: number; b: number }) {
  switch (params.operation) {
    case 'add': return { result: params.a + params.b };
    case 'subtract': return { result: params.a - params.b };
    case 'multiply': return { result: params.a * params.b };
    case 'divide': return { result: params.a / params.b };
    default: throw new Error('Unknown operation');
  }
}
`,
    createdAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Creates a valid mock EvaluationResult for testing.
 */
export function createMockEvaluationResult(
  candidate: EvolutionCandidate,
  overrides: Partial<EvaluationResult> = {},
): EvaluationResult {
  return {
    evaluationId: "eval_01JTEST001",
    candidateId: candidate.id,
    toolId: candidate.proposedTool.id,
    toolVersion: candidate.proposedTool.version,
    overallDecision: {
      verdict: "pass",
      score: 0.95,
      confidence: 0.98,
      threshold: 0.8,
      notes: "All benchmarks, security checks, and replay suites passed.",
      evaluatedBy: "evaluation-pipeline-v1",
      evaluatedAt: "2026-08-17T00:00:00.000Z",
    },
    dimensions: [
      {
        name: "test",
        weight: 0.3,
        score: 1.0,
        threshold: 0.8,
        passed: true,
        metrics: { totalTests: 10, passedTests: 10 },
      },
      {
        name: "security",
        weight: 0.4,
        score: 1.0,
        threshold: 1.0,
        passed: true,
        metrics: { vulnerabilitiesDetected: 0 },
      },
      {
        name: "latency",
        weight: 0.3,
        score: 0.9,
        threshold: 0.7,
        passed: true,
        metrics: { latencyMs: 15 },
      },
    ],
    replayTestCount: 5,
    replaySuccessCount: 5,
    securityChecklist: {
      noArbitraryCodeExecution: true,
      noUnauthorizedNetwork: true,
      noLeakedSecrets: true,
    },
    completedAt: "2026-08-17T00:00:00.000Z",
    durationMs: 450,
    ...overrides,
  };
}

/**
 * Sets up a clean in-memory test environment for artifact testing.
 */
export async function createTestArtifactEnvironment() {
  const pool = new MemoryDatabasePool();
  await runMigrations(pool);

  const objectStore = new MemoryObjectStore();
  const outboxPublisher = new OutboxPublisher(pool);
  const toolRegistryRepo = new ToolRegistryRepository(pool);
  const signingKeyRepo = new SigningKeyRepository(pool);
  const builder = new ArtifactBuilder();
  const signer = new ArtifactSigner();
  const versioning = new SemanticVersionClassifier();

  const service = new ToolArtifactRegistryService(pool, objectStore, {
    toolRegistryRepo,
    signingKeyRepo,
    builder,
    signer,
    versioning,
    outboxPublisher,
  });

  return {
    pool,
    objectStore,
    outboxPublisher,
    toolRegistryRepo,
    signingKeyRepo,
    builder,
    signer,
    versioning,
    service,
  };
}
