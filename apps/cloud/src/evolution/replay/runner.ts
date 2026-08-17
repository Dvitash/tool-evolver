import type { CapabilityManifest, ToolManifest } from "@tool-evolver/contracts";
import { ValidationSandbox } from "../testing/validation-sandbox.js";
import { ReplayTraceComparator } from "./comparator.js";
import type {
  CandidateTarget,
  HistoricalReplayOptions,
  HistoricalReplayResult,
  ReplayExecutionTrace,
  ReplayScenario,
  ReplayScenarioExecutionResult,
} from "./types.js";
import { DeterministicRandom, VirtualToolBrokerClient } from "./virtual-broker.js";

/**
 * Executes candidate tools against historical replay scenarios in isolated sandboxes.
 */
export class HistoricalReplayRunner {
  private readonly sandbox: ValidationSandbox;
  private readonly comparator: ReplayTraceComparator;

  constructor(
    options: {
      sandbox?: ValidationSandbox;
      comparator?: ReplayTraceComparator;
    } = {},
  ) {
    this.sandbox = options.sandbox ?? new ValidationSandbox();
    this.comparator = options.comparator ?? new ReplayTraceComparator();
  }

  /**
   * Runs a single replay scenario against a candidate tool.
   */
  async runScenario(
    candidate: CandidateTarget,
    scenario: ReplayScenario,
    options: {
      seed?: number | string;
      timeoutMs?: number;
    } = {},
  ): Promise<ReplayScenarioExecutionResult> {
    const seed = options.seed ?? 42;
    const timeoutMs = options.timeoutMs ?? 5000;

    const sourceCode = this.extractSourceCode(candidate);
    const manifest = this.extractManifest(candidate);
    const capabilities = this.extractCapabilities(candidate);

    const brokerClient = new VirtualToolBrokerClient(scenario.virtualState);

    // Execute candidate code in isolated sandbox
    const runResult = await this.sandbox.executeCandidate(
      sourceCode,
      manifest,
      scenario.input,
      brokerClient,
      {
        timeoutMs,
        seed,
        capabilities,
      },
    );

    const outputTokens = runResult.output
      ? Math.ceil(JSON.stringify(runResult.output).length / 4)
      : 0;
    const tokensUsed = 20 + outputTokens;

    const trace: ReplayExecutionTrace = {
      scenarioId: scenario.id,
      seed,
      operations: brokerClient.trace,
      toolOutput: runResult.output,
      error: runResult.error ?? null,
      durationMs: runResult.durationMs,
      stepCount: 1,
      tokensUsed,
      logs: runResult.logs,
      stateSnapshot: brokerClient.getStateSnapshot(),
    };

    return this.comparator.compareTrace(scenario, trace, manifest);
  }

  /**
   * Runs an array of replay scenarios across candidate tool with bounded concurrency.
   */
  async runScenarios(
    candidate: CandidateTarget,
    scenarios: ReplayScenario[],
    options: HistoricalReplayOptions = {},
  ): Promise<HistoricalReplayResult> {
    const startTime = Date.now();
    const rng = new DeterministicRandom(options.seed ?? 42);
    const candidateId = this.extractCandidateId(candidate);
    const revisionId = this.extractRevisionId(candidate);
    const evidenceSetId = scenarios[0]?.sourceEpisodeId;

    const maxParallel = options.maxParallelScenarios ?? 4;
    const scenarioResults: ReplayScenarioExecutionResult[] = [];

    // Execute in bounded batches
    for (let i = 0; i < scenarios.length; i += maxParallel) {
      const chunk = scenarios.slice(i, i + maxParallel);
      const chunkPromises = chunk.map((scenario) => {
        const scenarioSeed = rng.nextUuid();
        return this.runScenario(candidate, scenario, {
          seed: scenarioSeed,
          timeoutMs: options.timeoutMs,
        });
      });

      const chunkResults = await Promise.all(chunkPromises);
      scenarioResults.push(...chunkResults);

      if (options.failFast) {
        const failed = chunkResults.find((r) => r.status === "terminal_divergence");
        if (failed) {
          break;
        }
      }
    }

    const overall = this.comparator.compareOverall(scenarioResults);
    const durationMs = Date.now() - startTime;

    const summary = `Replay completed with status '${overall.status}'. Passed ${overall.passedScenarioCount}/${overall.totalScenarioCount} scenarios with ${overall.overallMetrics.stepReductionPercent}% step reduction and ${overall.overallMetrics.tokenSavingsPercent}% token savings.`;

    return {
      candidateId,
      revisionId,
      evidenceSetId,
      status: overall.status,
      passed: overall.passed,
      scenarioResults,
      overallMetrics: overall.overallMetrics,
      divergenceFindings: overall.divergenceFindings,
      reproducibilitySeed: options.seed ?? 42,
      passedScenarioCount: overall.passedScenarioCount,
      totalScenarioCount: overall.totalScenarioCount,
      executedAt: new Date().toISOString(),
      durationMs,
      summary,
    };
  }

  private extractSourceCode(candidate: CandidateTarget): string {
    if ("sourceCode" in candidate && typeof candidate.sourceCode === "string") {
      return candidate.sourceCode;
    }
    throw new Error("Candidate does not contain sourceCode");
  }

  private extractManifest(candidate: CandidateTarget): ToolManifest | Partial<ToolManifest> {
    if ("manifest" in candidate && candidate.manifest) {
      return candidate.manifest;
    }
    if ("proposedTool" in candidate && candidate.proposedTool) {
      return candidate.proposedTool;
    }
    return { name: "candidate_tool" };
  }

  private extractCapabilities(candidate: CandidateTarget): CapabilityManifest | undefined {
    if ("requiredCapabilities" in candidate && candidate.requiredCapabilities) {
      return candidate.requiredCapabilities;
    }
    return undefined;
  }

  private extractCandidateId(candidate: CandidateTarget): string {
    if ("id" in candidate && typeof candidate.id === "string") {
      return candidate.id;
    }
    if ("candidateId" in candidate && typeof candidate.candidateId === "string") {
      return candidate.candidateId;
    }
    return "candidate-unknown";
  }

  private extractRevisionId(candidate: CandidateTarget): string | undefined {
    if ("revisionId" in candidate && typeof candidate.revisionId === "string") {
      return candidate.revisionId;
    }
    return undefined;
  }
}
