import { type CapabilityManifest, CapabilityManifestSchema } from "@tool-evolver/contracts";
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

type LooseCapabilityManifest = {
  manifestId?: string;
  fs?: Partial<CapabilityManifest["fs"]>;
  net?: Partial<CapabilityManifest["net"]>;
  command?: Partial<CapabilityManifest["command"]>;
  secrets?: Partial<CapabilityManifest["secrets"]>;
  limits?: Partial<CapabilityManifest["limits"]>;
  exec?: {
    allowExec?: boolean;
    allowedCommands?: string[];
  };
};

function normalizeLegacyPath(path: string): string {
  const normalized = path.trim().replace(/\/\.\*$/, "");
  return normalized || "/";
}

/**
 * Replays may receive persisted candidates created before capability manifests became
 * fully materialized. Normalize those legacy/partial manifests conservatively before
 * deriving replay authorization. Missing sections never imply permission.
 */
function normalizeCandidateCapabilities(candidate: CandidateTarget): CandidateTarget {
  if (!("requiredCapabilities" in candidate) || !candidate.requiredCapabilities) {
    return candidate;
  }

  const raw = candidate.requiredCapabilities as unknown as LooseCapabilityManifest;
  const normalized = CapabilityManifestSchema.parse({
    manifestId: raw.manifestId,
    fs: {
      readPaths: (raw.fs?.readPaths ?? []).map(normalizeLegacyPath),
      writePaths: (raw.fs?.writePaths ?? []).map(normalizeLegacyPath),
      allowWorkspaceRoot: raw.fs?.allowWorkspaceRoot ?? false,
      allowTemp: raw.fs?.allowTemp ?? false,
      denyPaths: (raw.fs?.denyPaths ?? []).map(normalizeLegacyPath),
      maxFileSizeBytes: raw.fs?.maxFileSizeBytes ?? 10_485_760,
    },
    net: {
      allowOutbound: raw.net?.allowOutbound ?? false,
      allowedDomains: raw.net?.allowedDomains ?? [],
      allowedHosts: raw.net?.allowedHosts ?? [],
      allowedPorts: raw.net?.allowedPorts ?? [],
      allowedProtocols: raw.net?.allowedProtocols ?? ["https"],
      allowLocalhost: raw.net?.allowLocalhost ?? false,
      denyPrivateRanges: raw.net?.denyPrivateRanges ?? true,
    },
    command: {
      allowShellExecution: raw.command?.allowShellExecution ?? raw.exec?.allowExec ?? false,
      allowedCommands: raw.command?.allowedCommands ?? raw.exec?.allowedCommands ?? [],
      allowedBinaries: raw.command?.allowedBinaries ?? [],
      forbiddenPatterns: raw.command?.forbiddenPatterns ?? [],
      allowEnvPassthrough: raw.command?.allowEnvPassthrough ?? [],
    },
    secrets: {
      allowedSecretNames: raw.secrets?.allowedSecretNames ?? [],
      allowedPrefixes: raw.secrets?.allowedPrefixes ?? [],
      denyDirectRead: raw.secrets?.denyDirectRead ?? true,
      injectAsEnv: raw.secrets?.injectAsEnv ?? true,
    },
    limits: {
      maxConcurrentExecutions: raw.limits?.maxConcurrentExecutions ?? 4,
      maxCpuUsagePercent: raw.limits?.maxCpuUsagePercent ?? 100,
      maxMemoryMb: raw.limits?.maxMemoryMb ?? 128,
      maxExecutionTimeMs: raw.limits?.maxExecutionTimeMs ?? 30_000,
      maxOutputSizeBytes: raw.limits?.maxOutputSizeBytes ?? 1_048_576,
    },
  });

  return {
    ...candidate,
    requiredCapabilities: normalized,
  } as CandidateTarget;
}

/**
 * Replays a candidate tool against historical session evidence.
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

  async replayCandidate(
    tenant: TenantContext,
    options: ReplayCandidateOptions,
  ): Promise<HistoricalReplayResult> {
    let evidenceSource = options.evidence;

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
    const candidate = normalizeCandidateCapabilities(options.candidate);
    const scenarios = this.builder.buildScenarios(evidenceSource, candidate, replayOpts);

    return this.runner.runScenarios(candidate, scenarios, replayOpts);
  }

  buildScenarios(
    evidence: EvidenceSource,
    candidate: CandidateTarget,
    options?: HistoricalReplayOptions,
  ): ReplayScenario[] {
    return this.builder.buildScenarios(
      evidence,
      normalizeCandidateCapabilities(candidate),
      options,
    );
  }

  async executeSingleScenario(
    candidate: CandidateTarget,
    scenario: ReplayScenario,
    options?: { seed?: number | string; timeoutMs?: number },
  ): Promise<ReplayScenarioExecutionResult> {
    return this.runner.runScenario(normalizeCandidateCapabilities(candidate), scenario, options);
  }
}

export function createHistoricalReplayService(
  options: HistoricalReplayServiceOptions = {},
): HistoricalReplayService {
  return new HistoricalReplayService(options);
}
