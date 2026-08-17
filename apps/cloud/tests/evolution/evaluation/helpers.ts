import type {
  CapabilityEnvelope,
  CapabilityManifest,
  EvolutionCandidate,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { ActiveToolBaseline } from "../../../src/evolution/evaluation/types.js";
import type { CandidateRevision } from "../../../src/evolution/generator/types.js";
import type { OpportunityDetection } from "../../../src/evolution/opportunity/types.js";
import type {
  HistoricalReplayResult,
  ReplayScenarioExecutionResult,
} from "../../../src/evolution/replay/types.js";
import type {
  CandidateValidationResult,
  StaticAnalysisFinding,
} from "../../../src/evolution/testing/types.js";

/**
 * Creates a mock ToolManifest.
 */
export function createMockToolManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    id: overrides.id ?? "math_compute_tool",
    name: overrides.name ?? "math_compute_tool",
    version: overrides.version ?? "1.0.0",
    description: overrides.description ?? "Mathematical computation tool",
    parameters: overrides.parameters ?? {
      type: "object",
      properties: {
        x: { type: "number", description: "First operand" },
        y: { type: "number", description: "Second operand" },
        op: { type: "string", description: "Operator" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    output: overrides.output ?? {
      type: "object",
      properties: {
        result: { type: "number" },
      },
    },
    runtime: overrides.runtime ?? {
      runtime: "node",
      memoryLimitMb: 128,
      timeoutMs: 5000,
      cpuLimitPercent: 100,
    },
    capabilities: overrides.capabilities ?? {
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
        allowedPorts: [],
        allowInsecureHttp: false,
        denyDomains: [],
        denyPrivateRanges: true,
      },
      command: {
        allowedCommands: [],
        allowEnvInheritance: false,
        denyCommands: [],
        allowPipes: false,
        maxExecutionTimeMs: 10000,
      },
      secrets: {
        allowedSecretNames: [],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 2,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 5000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: overrides.limits ?? {
      maxExecutionTimeMs: 5000,
      maxMemoryMb: 128,
      maxOutputSizeBytes: 1048576,
    },
    scope: overrides.scope ?? "workspace",
    digest: overrides.digest ?? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Creates a mock CandidateRevision.
 */
export function createMockCandidateRevision(
  overrides: {
    candidateId?: string;
    revisionId?: string;
    manifest?: Partial<ToolManifest>;
    sourceCode?: string;
    capabilities?: Partial<CapabilityManifest>;
  } = {},
): CandidateRevision {
  const candidateId = overrides.candidateId ?? "cand-math-123";
  const manifest = createMockToolManifest(overrides.manifest);

  return {
    candidateId,
    revisionId: overrides.revisionId ?? "rev-1",
    revisionNumber: 1,
    artifacts: {
      plan: {
        planId: "plan-1",
        toolName: manifest.name,
        intent: "Math compute",
        summary: "Compute math operations",
        proposedParameters: manifest.parameters,
        outputSchema: manifest.output,
        requiredCapabilities: manifest.capabilities,
        plannedSteps: [],
        invariants: [],
      },
      manifest,
      capabilities: manifest.capabilities,
      sourceCode:
        overrides.sourceCode ??
        `import { defineTool } from "@tool-evolver/runtime";
export default defineTool({
  name: "${manifest.name}",
  async execute(input) {
    return { result: input.x + input.y };
  }
});`,
    },
    selfReview: {
      passed: true,
      issues: [],
      reviewedAt: "2026-01-01T00:00:00.000Z",
    },
    repairHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Creates a mock CandidateValidationResult.
 */
export function createMockValidationResult(
  overrides: Partial<CandidateValidationResult> = {},
): CandidateValidationResult {
  return {
    candidateId: overrides.candidateId ?? "cand-math-123",
    revisionId: overrides.revisionId ?? "rev-1",
    status: overrides.status ?? "pass",
    passed: overrides.passed ?? true,
    staticFindings: overrides.staticFindings ?? [],
    typecheckPassed: overrides.typecheckPassed ?? true,
    testReport: overrides.testReport ?? {
      suiteId: "suite-1",
      totalTests: 10,
      passed: 10,
      failed: 0,
      timeouts: 0,
      durationMs: 120,
      results: [
        {
          testId: "t-1",
          name: "happy_path_addition",
          testType: "happy_path",
          status: "pass",
          durationMs: 12,
          passed: true,
          assertionsPassed: 2,
        },
        {
          testId: "t-2",
          name: "edge_case_negative",
          testType: "edge_case",
          status: "pass",
          durationMs: 10,
          passed: true,
          assertionsPassed: 1,
        },
      ],
      coverage: {
        statementCount: 20,
        coveredStatements: 18,
        statementCoveragePercent: 90,
        branchCount: 6,
        coveredBranches: 5,
        branchCoveragePercent: 83.3,
        functionCount: 4,
        coveredFunctions: 4,
        functionCoveragePercent: 100,
      },
    },
    coverage: overrides.coverage ?? {
      statementCount: 20,
      coveredStatements: 18,
      statementCoveragePercent: 90,
      branchCount: 6,
      coveredBranches: 5,
      branchCoveragePercent: 83.3,
      functionCount: 4,
      coveredFunctions: 4,
      functionCoveragePercent: 100,
    },
    repairFeedback: overrides.repairFeedback,
    validatedAt: overrides.validatedAt ?? "2026-01-01T00:00:00.000Z",
    durationMs: overrides.durationMs ?? 250,
  };
}

/**
 * Creates a mock HistoricalReplayResult.
 */
export function createMockReplayResult(
  overrides: Partial<HistoricalReplayResult> = {},
): HistoricalReplayResult {
  const scenarioResults: ReplayScenarioExecutionResult[] = overrides.scenarioResults ?? [
    {
      scenarioId: "sc-1",
      scenarioName: "math_multi_turn_session_1",
      type: "identical_inputs",
      status: "pass",
      passed: true,
      executionTrace: {
        steps: [],
        totalDurationMs: 45,
        totalTokens: 120,
      },
      invariantEvaluations: [
        {
          invariantId: "inv-1",
          invariantName: "math_result_matches",
          type: "output_equivalence",
          passed: true,
          severity: "critical",
        },
      ],
      metricsComparison: {
        baselineStepCount: 4,
        candidateStepCount: 1,
        stepReductionCount: 3,
        baselineDurationMs: 300,
        candidateDurationMs: 45,
        latencyReductionMs: 255,
        baselineTokens: 1200,
        candidateTokens: 200,
        tokenReductionCount: 1000,
        baselineToolCalls: 4,
        candidateToolCalls: 1,
      },
      divergenceFindings: [],
      durationMs: 45,
      seed: "deterministic-seed-1",
    },
    {
      scenarioId: "sc-2",
      scenarioName: "math_multi_turn_session_2",
      type: "parameter_variations",
      status: "pass",
      passed: true,
      executionTrace: {
        steps: [],
        totalDurationMs: 50,
        totalTokens: 130,
      },
      invariantEvaluations: [
        {
          invariantId: "inv-2",
          invariantName: "state_unchanged",
          type: "state_immutability",
          passed: true,
          severity: "critical",
        },
      ],
      metricsComparison: {
        baselineStepCount: 3,
        candidateStepCount: 1,
        stepReductionCount: 2,
        baselineDurationMs: 280,
        candidateDurationMs: 50,
        latencyReductionMs: 230,
        baselineTokens: 900,
        candidateTokens: 180,
        tokenReductionCount: 720,
        baselineToolCalls: 3,
        candidateToolCalls: 1,
      },
      divergenceFindings: [],
      durationMs: 50,
      seed: "deterministic-seed-2",
    },
    {
      scenarioId: "sc-3",
      scenarioName: "math_multi_turn_session_3",
      type: "edge_case_replay",
      status: "pass",
      passed: true,
      executionTrace: {
        steps: [],
        totalDurationMs: 60,
        totalTokens: 140,
      },
      invariantEvaluations: [
        {
          invariantId: "inv-3",
          invariantName: "error_boundary_handled",
          type: "output_equivalence",
          passed: true,
          severity: "warning",
        },
      ],
      metricsComparison: {
        baselineStepCount: 5,
        candidateStepCount: 1,
        stepReductionCount: 4,
        baselineDurationMs: 400,
        candidateDurationMs: 60,
        latencyReductionMs: 340,
        baselineTokens: 1500,
        candidateTokens: 250,
        tokenReductionCount: 1250,
        baselineToolCalls: 5,
        candidateToolCalls: 1,
      },
      divergenceFindings: [],
      durationMs: 60,
      seed: "deterministic-seed-3",
    },
  ];

  return {
    candidateId: overrides.candidateId ?? "cand-math-123",
    revisionId: overrides.revisionId ?? "rev-1",
    status: overrides.status ?? "pass",
    passed: overrides.passed ?? true,
    scenarioResults,
    overallMetrics: overrides.overallMetrics ?? {
      baselineStepCount: 12,
      candidateStepCount: 3,
      stepReductionCount: 9,
      baselineDurationMs: 980,
      candidateDurationMs: 155,
      latencyReductionMs: 825,
      baselineTokens: 3600,
      candidateTokens: 630,
      tokenReductionCount: 2970,
      baselineToolCalls: 12,
      candidateToolCalls: 3,
    },
    divergenceFindings: overrides.divergenceFindings ?? [],
    reproducibilitySeed: overrides.reproducibilitySeed ?? "repro-seed-42",
    passedScenarioCount:
      overrides.passedScenarioCount ?? scenarioResults.filter((s) => s.passed).length,
    totalScenarioCount: overrides.totalScenarioCount ?? scenarioResults.length,
    executedAt: overrides.executedAt ?? "2026-01-01T00:00:00.000Z",
    durationMs: overrides.durationMs ?? 155,
    summary: overrides.summary ?? "Historical replay passed all invariants cleanly.",
  };
}

/**
 * Creates a mock OpportunityDetection.
 */
export function createMockOpportunity(
  overrides: Partial<OpportunityDetection> = {},
): OpportunityDetection {
  return {
    id: overrides.id ?? "opp-math-001",
    accountId: overrides.accountId ?? "acc-1",
    workspaceId: overrides.workspaceId ?? "ws-1",
    clusterId: overrides.clusterId ?? "cluster-math",
    structuralHash: overrides.structuralHash ?? "hash-math-123",
    status: overrides.status ?? "eligible",
    triggerType: overrides.triggerType ?? "normal_frequency",
    triggerReason: overrides.triggerReason ?? "repeated_pattern",
    occurrenceCount: overrides.occurrenceCount ?? 5,
    distinctSessionCount: overrides.distinctSessionCount ?? 3,
    evidenceEventIds: overrides.evidenceEventIds ?? ["ev-1", "ev-2", "ev-3"],
    coverage: overrides.coverage ?? {
      covered: false,
      coveringCandidateIds: [],
    },
    suppression: overrides.suppression ?? {
      suppressed: false,
      reason: "none",
      details: "No suppression active",
    },
    classification: overrides.classification ?? {
      title: "Math compute abstraction",
      description: "Opportunity to combine recurring math steps",
      taskClass: "file_read",
      pattern: "step1 -> step2 -> step3",
      confidenceScore: 0.92,
      priority: "medium",
    },
    metrics: overrides.metrics ?? {
      totalDurationMs: 12000,
      totalTokens: 4500,
      stepCount: 15,
      frequencyPerHour: 4.2,
      firstObservedAt: "2026-01-01T00:00:00.000Z",
      lastObservedAt: "2026-01-01T01:00:00.000Z",
    },
    createdAt: overrides.createdAt ?? "2026-01-01T01:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T01:00:00.000Z",
  };
}

/**
 * Creates a mock CapabilityEnvelope.
 */
export function createMockEnvelope(
  overrides: Partial<CapabilityEnvelope> = {},
): CapabilityEnvelope {
  return {
    envelopeId: overrides.envelopeId ?? "env-default",
    fs: overrides.fs ?? {
      readPaths: ["/workspace"],
      writePaths: ["/workspace/out"],
      allowWorkspaceRoot: true,
      allowTemp: true,
      denyPaths: ["/etc", "/root"],
      maxFileSizeBytes: 10485760,
    },
    net: overrides.net ?? {
      allowOutbound: true,
      allowedDomains: ["api.example.com"],
      allowedPorts: [443],
      allowInsecureHttp: false,
      denyDomains: ["internal.local"],
      denyPrivateRanges: true,
    },
    command: overrides.command ?? {
      allowedCommands: ["git", "ls", "npm"],
      allowEnvInheritance: false,
      denyCommands: ["rm -rf", "sudo"],
      allowPipes: false,
      maxExecutionTimeMs: 15000,
    },
    secrets: overrides.secrets ?? {
      allowedSecretNames: ["API_KEY"],
      allowedPrefixes: ["APP_"],
      denyDirectRead: true,
      injectAsEnv: true,
    },
    limits: overrides.limits ?? {
      maxConcurrentExecutions: 4,
      maxCpuUsagePercent: 100,
      maxMemoryMb: 512,
      maxExecutionTimeMs: 30000,
      maxOutputSizeBytes: 5242880,
    },
    isFrozen: overrides.isFrozen ?? false,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Creates a mock ActiveToolBaseline.
 */
export function createMockActiveBaseline(
  overrides: Partial<ActiveToolBaseline> = {},
): ActiveToolBaseline {
  const manifest = createMockToolManifest({
    version: "1.0.0",
    ...overrides.manifest,
  });

  return {
    toolId: overrides.toolId ?? manifest.id,
    toolVersion: overrides.toolVersion ?? "1.0.0",
    manifest,
    sourceCode: overrides.sourceCode ?? `export default function baseline() { return true; }`,
    capabilities: overrides.capabilities ?? manifest.capabilities,
    metrics: overrides.metrics ?? {
      latencyMs: 100,
      tokenUsage: 3,
      successRate: 1.0,
    },
    validationReport: overrides.validationReport,
    replayReport: overrides.replayReport,
  };
}
