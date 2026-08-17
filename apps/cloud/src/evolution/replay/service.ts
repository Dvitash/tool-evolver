import type { DatabasePool } from "../../db/client.js";
import { EvidenceRepository } from "../../storage/repositories/evidence-repository.js";
import type { TenantContext } from "../../tenant.js";
import { HistoricalReplayRunner } from "./runner.js";
import { ReplayScenarioBuilder } from "./scenario-builder.js";
import type {
  CandidateTarget,
  EvidenceSource,
  HistoricalReplayOptions,
  HistoricalReplayResult,
  ReplayScenario,
  ReplayScenarioExecutionResult,
} from "./types.js";

/**
 * Options for replaying a candidate against historical evidence.
 */
export interface ReplayCandidateOptions {
  candidate: CandidateTarget;
  evidence?: EvidenceSource;
  evidenceSetId?: string;
  options?: HistoricalReplayOptions;
}

/**
 * Configuration options for HistoricalReplayService.
 */
export interface HistoricalReplayServiceOptions {
  builder?: ReplayScenarioBuilder;
  runner?: HistoricalReplayRunner;
  evidenceRepo?: EvidenceRepository;
  dbPool?: DatabasePool;
  defaultTimeoutMs?: number;
  defaultSeed?: number | string;
}

/**
 * Service orchestrating historical session replay evaluation for candidate tools.
 */
export class HistoricalReplayService {
  private readonly builder: ReplayScenarioBuilder;
  private readonly runner: HistoricalReplayRunner;
  private readonly evidenceRepo?: EvidenceRepository;
  private readonly defaultTimeoutMs: number;
  private readonly defaultSeed: number | string;

  constructor(options: HistoricalReplayServiceOptions = {}) {
    this.builder = options.builder ?? new ReplayScenarioBuilder();
    this.runner = options.runner ?? new HistoricalReplayRunner();
    this.evidenceRepo =
      options.evidenceRepo ?? (options.dbPool ? new EvidenceRepository(options.dbPool) : undefined);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.defaultSeed = options.defaultSeed ?? 42;
  }

  /**
   * Replays a candidate tool against historical session evidence.
   */
  async replayCandidate(
    tenant: TenantContext,
    options: ReplayCandidateOptions,
  ): Promise<HistoricalReplayResult> {
    let evidenceSource = options.evidence;

    // Resolve evidence from repository if ID was specified
    if (!evidenceSource && options.evidenceSetId && this.evidenceRepo) {
      const resolved = await this.evidenceRepo.resolveEvidenceSet(tenant, options.evidenceSetId);
      if (resolved) {
        evidenceSource = resolved;
      }
    }

    if (!evidenceSource) {
      throw new Error(
        "No evidence source provided for historical replay. Supply either 'evidence' or valid 'evidenceSetId'.",
      );
    }

    const replayOpts: HistoricalReplayOptions = {
      seed: this.defaultSeed,
      timeoutMs: this.defaultTimeoutMs,
      ...options.options,
    };

    // 1. Build deterministic scenarios
    const scenarios = this.builder.buildScenarios(evidenceSource, options.candidate, replayOpts);

    // 2. Execute scenarios against candidate in isolated sandbox
    const result = await this.runner.runScenarios(options.candidate, scenarios, replayOpts);

    return result;
  }

  /**
   * Builds replay scenarios without executing them.
   */
  buildScenarios(
    evidence: EvidenceSource,
    candidate: CandidateTarget,
    options?: HistoricalReplayOptions,
  ): ReplayScenario[] {
    return this.builder.buildScenarios(evidence, candidate, options);
  }

  /**
   * Runs a single pre-built scenario against a candidate.
   */
  async executeSingleScenario(
    candidate: CandidateTarget,
    scenario: ReplayScenario,
    options?: { seed?: number | string; timeoutMs?: number },
  ): Promise<ReplayScenarioExecutionResult> {
    return this.runner.runScenario(candidate, scenario, options);
  }
}

/**
 * Factory function for creating a HistoricalReplayService instance.
 */
export function createHistoricalReplayService(
  options: HistoricalReplayServiceOptions = {},
): HistoricalReplayService {
  return new HistoricalReplayService(options);
}
