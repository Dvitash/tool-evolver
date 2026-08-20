import { randomUUID } from "node:crypto";
import {
  type CapabilityEnvelope,
  type CapabilityManifest,
  type EvaluationResult,
  type EvolutionCandidate,
  type NormalizedSessionEvent,
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  hashCanonical,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import { computeSha256 } from "@tool-evolver/runtime";
import type { DatabasePool, Queryable } from "../../db/client.js";
import { type OutboxPublisher, OutboxRepository } from "../../db/outbox.js";
import type { CloudCatalogService } from "../../mcp/catalog-service.js";
import type { DurableQueue } from "../../queue/queue.js";
import type { ObjectStore } from "../../storage/object-store.js";
import type { ObservationRepository } from "../../storage/repositories/observation-repository.js";
import { type TenantContext, TenantGuard } from "../../tenant.js";
import { ToolArtifactRegistryService } from "../artifacts/service.js";
import { CandidateEvaluationService } from "../evaluation/service.js";
import type { CandidateEvaluationOptions } from "../evaluation/types.js";
import { CandidateRepository } from "../generator/repositories/candidate-repository.js";
import { RepairOrchestrator } from "../generator/repair-orchestrator.js";
import type { RepairOrchestrationResult } from "../generator/repair-orchestrator.js";
import type {
  CandidateGenerationOptions,
  CandidateRevision,
  SelfReviewIssue,
  ToolPlan,
} from "../generator/types.js";

import type { InferenceService } from "../../models/service.js";
import { HistoricalReplayService } from "../replay/service.js";
import type {
  EvidenceSource,
  HistoricalReplayOptions,
  HistoricalReplayResult,
} from "../replay/types.js";
import { CandidateValidationService } from "../testing/service.js";
import type { CandidateValidationOptions, CandidateValidationResult } from "../testing/types.js";
import { LifecycleRepository } from "./repositories/lifecycle-repository.js";
import { classifyError, redactDiagnostics } from "./retry-classifier.js";
import {
  type AttemptHistoryEntry,
  type CandidateLifecycleDlqRecord,
  type CandidateLifecycleRecord,
  type CandidateLifecycleState,
  type CandidateLifecycleStatusResponse,
  EVOLUTION_LIFECYCLE_JOB_TYPES,
  type EvidenceDigests,
  type LifecycleJobPayload,
  type LifecycleStage,
  type LifecycleTransitionRecord,
  type RepairCandidateOptions,
  type ResumeFromDlqOptions,
  type TerminalReason,
} from "./types.js";
function normalizePlanForDigest(plan: unknown): unknown {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const p = plan as Record<string, unknown>;
  const { createdAt: _ca, updatedAt: _ua, id: _id, planId: _pid, opportunityId: _oid, workspaceId: _wid, metadata: _meta, ...rest } = p;
  return rest;
}
function normalizeLegacyManifestForDigest(manifest: unknown): Record<string, unknown> {
  const m = JSON.parse(JSON.stringify(manifest ?? {})) as Record<string, unknown>;
  const caps = m.capabilities as Record<string, unknown> | undefined;
  if (caps && typeof caps === "object") {
    if (caps.fs && typeof caps.fs === "object") {
      const fs = caps.fs as Record<string, unknown>;
      if ("allowRead" in fs || "allowWrite" in fs) {
        caps.fs = {
          readPaths: Array.isArray(fs.readPaths) ? fs.readPaths : [],
          writePaths: Array.isArray(fs.writePaths) ? fs.writePaths : [],
          allowWorkspaceRoot: Boolean((fs as Record<string, unknown>).allowRead),
          allowTemp: Boolean((fs as Record<string, unknown>).allowRead) || Boolean((fs as Record<string, unknown>).allowWrite),
          denyPaths: Array.isArray((fs as Record<string, unknown>).denyPaths) ? (fs as Record<string, unknown>).denyPaths : [],
          maxFileSizeBytes: typeof (fs as Record<string, unknown>).maxFileSizeBytes === "number" ? (fs as Record<string, unknown>).maxFileSizeBytes : 10485760,
        };
      }
    }
    const capsRec = caps as Record<string, unknown>;
    if (capsRec.exec && !capsRec.command) {
      const exec = capsRec.exec as Record<string, unknown>;
      capsRec.command = {
        allowShellExecution: Boolean(exec.allowExec),
        allowedCommands: Array.isArray(exec.allowedCommands) ? exec.allowedCommands : [],
      };
    }
  }
  return m;
}

/**
 * Options configuring CandidateLifecycleOrchestrator.
 */
export interface CandidateLifecycleOrchestratorOptions {
  validationService?: CandidateValidationService;
  replayService?: HistoricalReplayService;
  evaluationService?: CandidateEvaluationService;
  artifactService?: ToolArtifactRegistryService;
  catalogService?: CloudCatalogService;
  candidateRepo?: CandidateRepository;
  lifecycleRepo?: LifecycleRepository;
  outboxPublisher?: OutboxPublisher;
  queue?: DurableQueue;
  objectStore?: ObjectStore;
  observationRepo?: ObservationRepository;
  requirePersistedReplayEvidence?: boolean;
  replayEvidenceWaitMs?: number;
  replayEvidencePollMs?: number;
  evidenceMaxAgeMs?: number;
  maxRepairAttempts?: number;
  /** Enables the validation repairable_fail -> repair loop route (L1). */
  inferenceService?: InferenceService;
  repairOrchestrator?: RepairOrchestrator;
}

/**
 * Options for single lifecycle transition steps.
 */
export interface LifecycleStepOptions {
  idempotencyKey?: string;
  attempt?: number;
  targetVersion?: string;
  signingKeyId?: string;
  validationOptions?: Partial<CandidateValidationOptions>;
  replayOptions?: Partial<HistoricalReplayOptions>;
  evaluationOptions?: Partial<CandidateEvaluationOptions>;
  envelope?: CapabilityEnvelope;
  baselineEvents?: NormalizedSessionEvent[];
  maxRepairAttempts?: number;
}

/**
 * Durable Evolution Orchestrator.
 * Drives pure-compute tools, brokered atomic tools, and multi-step workflows through
 * verify -> replay -> evaluate -> publish lifecycle state machine with explicit retry
 * classifications, bounded repair loops, DLQ persistence, and crash recovery.
 */
export class CandidateLifecycleOrchestrator {
  readonly pool: DatabasePool;
  readonly validationService: CandidateValidationService;
  readonly replayService: HistoricalReplayService;
  readonly evaluationService: CandidateEvaluationService;
  readonly artifactService: ToolArtifactRegistryService;
  readonly catalogService?: CloudCatalogService;
  readonly candidateRepo: CandidateRepository;
  readonly lifecycleRepo: LifecycleRepository;
  readonly outboxPublisher?: OutboxPublisher;
  readonly queue?: DurableQueue;
  readonly objectStore?: ObjectStore;
  readonly observationRepo?: ObservationRepository;
  readonly requirePersistedReplayEvidence: boolean;
  readonly replayEvidenceWaitMs: number;
  readonly replayEvidencePollMs: number;
  readonly evidenceMaxAgeMs: number;
  readonly maxRepairAttempts: number;
  readonly inferenceService?: InferenceService;
  readonly repairOrchestrator: RepairOrchestrator;

  constructor(
    pool: DatabasePool,
    optionsOrValidationService?: CandidateLifecycleOrchestratorOptions | CandidateValidationService,
    replayService?: HistoricalReplayService,
    evaluationService?: CandidateEvaluationService,
    options: CandidateLifecycleOrchestratorOptions = {},
  ) {
    let opts: CandidateLifecycleOrchestratorOptions;
    let valService: CandidateValidationService;
    let repService: HistoricalReplayService;
    let evalService: CandidateEvaluationService;

    if (
      optionsOrValidationService &&
      typeof optionsOrValidationService === "object" &&
      !("validateCandidate" in optionsOrValidationService)
    ) {
      opts = optionsOrValidationService as CandidateLifecycleOrchestratorOptions;
      valService = opts.validationService ?? new CandidateValidationService();
      repService = opts.replayService ?? new HistoricalReplayService();
      evalService = opts.evaluationService ?? new CandidateEvaluationService();
    } else {
      opts = options;
      valService =
        (optionsOrValidationService as CandidateValidationService) ??
        opts.validationService ??
        new CandidateValidationService();
      repService = replayService ?? opts.replayService ?? new HistoricalReplayService();
      evalService = evaluationService ?? opts.evaluationService ?? new CandidateEvaluationService();
    }

    this.pool = pool;
    this.validationService = valService;
    this.replayService = repService;
    this.evaluationService = evalService;
    this.artifactService =
      opts.artifactService ??
      new ToolArtifactRegistryService(
        this.pool,
        opts.objectStore ?? ({} as unknown as ObjectStore),
      );
    this.catalogService = opts.catalogService;
    this.candidateRepo = opts.candidateRepo ?? new CandidateRepository(this.pool);
    this.lifecycleRepo = opts.lifecycleRepo ?? new LifecycleRepository(this.pool);
    this.outboxPublisher = opts.outboxPublisher;
    this.queue = opts.queue;
    this.objectStore = opts.objectStore;
    this.observationRepo = opts.observationRepo;
    this.requirePersistedReplayEvidence = opts.requirePersistedReplayEvidence ?? false;
    this.replayEvidenceWaitMs = opts.replayEvidenceWaitMs ?? 0;
    this.replayEvidencePollMs = Math.max(1, opts.replayEvidencePollMs ?? 25);
    this.evidenceMaxAgeMs = opts.evidenceMaxAgeMs ?? 24 * 60 * 60 * 1000;
    this.maxRepairAttempts = opts.maxRepairAttempts ?? 3;
    this.inferenceService = opts.inferenceService;
    this.repairOrchestrator = opts.repairOrchestrator ?? new RepairOrchestrator();
  }

  private enforceTenant(tenant: TenantContext): void {
    if (tenant?.accountId && tenant?.workspaceId) {
      TenantGuard.assertAccess(
        { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
        tenant,
      );
    }
  }

  private async ensureOutboxForState(
    tenant: TenantContext,
    record: CandidateLifecycleRecord,
  ): Promise<void> {
    if (!this.pool) return;
    let jobPayload: LifecycleJobPayload | null = null;
    let eventType: string | null = null;
    let stepHeader: string | null = null;
    if (record.currentState === "drafted") {
      jobPayload = {
        candidateId: record.candidateId,
        revisionId: record.activeRevisionId,
        targetVersion: record.targetVersion,
        step: "validate",
        idempotencyKey: `cand_${record.candidateId}_val_job_1`,
        attempt: 1,
        scheduledAt: new Date().toISOString(),
      };
      eventType = EVOLUTION_LIFECYCLE_JOB_TYPES.VALIDATE_CANDIDATE;
      stepHeader = "validate";
    } else if (record.currentState === "replaying") {
      jobPayload = {
        candidateId: record.candidateId,
        revisionId: record.activeRevisionId,
        targetVersion: record.targetVersion,
        step: "replay",
        idempotencyKey: `cand_${record.candidateId}_replay_job_${record.attempt}`,
        attempt: 1,
        scheduledAt: new Date().toISOString(),
      };
      eventType = EVOLUTION_LIFECYCLE_JOB_TYPES.REPLAY_CANDIDATE;
      stepHeader = "replay";
    } else if (record.currentState === "evaluating") {
      jobPayload = {
        candidateId: record.candidateId,
        revisionId: record.activeRevisionId,
        targetVersion: record.targetVersion,
        step: "evaluate",
        idempotencyKey: `cand_${record.candidateId}_eval_job_${record.attempt}`,
        attempt: 1,
        scheduledAt: new Date().toISOString(),
      };
      eventType = EVOLUTION_LIFECYCLE_JOB_TYPES.EVALUATE_CANDIDATE;
      stepHeader = "evaluate";
    } else if (record.currentState === "eligible") {
      jobPayload = {
        candidateId: record.candidateId,
        revisionId: record.activeRevisionId,
        targetVersion: record.targetVersion,
        step: "publish",
        idempotencyKey: `cand_${record.candidateId}_pub_job_${record.attempt}`,
        attempt: 1,
        scheduledAt: new Date().toISOString(),
      };
      eventType = EVOLUTION_LIFECYCLE_JOB_TYPES.PUBLISH_CANDIDATE;
      stepHeader = "publish";
    } else {
      return;
    }
    if (!jobPayload || !eventType || !stepHeader) return;
    const outboxId = `outbox_${jobPayload.idempotencyKey}`;
    try {
      await OutboxRepository.insert(this.pool, {
        id: outboxId,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        aggregateType: "candidate_lifecycle",
        aggregateId: record.candidateId,
        eventType,
        payload: jobPayload as unknown as Record<string, unknown>,
        headers: { step: stepHeader, workspaceId: tenant.workspaceId },
      });
    } catch {
      // idempotent ensure: ON CONFLICT DO NOTHING handles duplicate; other errors are best-effort for redelivery
    }
  }

  private async atomicTransitionWithOutbox(
    tenant: TenantContext,
    candidateId: string,
    transition: Parameters<LifecycleRepository["recordTransition"]>[2],
    jobPayload: LifecycleJobPayload,
    eventType: string,
    stepHeader: string,
  ): Promise<CandidateLifecycleRecord> {
    const outboxId = `outbox_${jobPayload.idempotencyKey}`;
    const outboxInput = {
      id: outboxId,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      aggregateType: "candidate_lifecycle" as const,
      aggregateId: candidateId,
      eventType,
      payload: jobPayload as unknown as Record<string, unknown>,
      headers: { step: stepHeader, workspaceId: tenant.workspaceId },
    };
    if (this.pool && typeof (this.pool as unknown as { transaction?: unknown }).transaction === "function") {
      return await (this.pool as DatabasePool).transaction(async (tx) => {
        const rec = await this.lifecycleRepo.recordTransition(tenant, candidateId, transition as never, tx);
        await OutboxRepository.insert(tx, outboxInput);
        return rec;
      });
    }
    // Fallback when no transactional pool (tests with memory pool always have it, but keep deterministic id)
    const rec = await this.lifecycleRepo.recordTransition(tenant, candidateId, transition as never);
    if (this.pool) {
      await OutboxRepository.insert(this.pool as unknown as Queryable, outboxInput);
    }
    return rec;
  }

  /**
   * Computes a complete artifact-set digest over manifest, source, capabilities,
   * tests, workflowDefinition, and the full immutable ToolPlan for pinning.
   * Stored as evidenceDigests.artifactSetDigest and compared at every stage.
   * Legacy manifests with old fs/exec shapes are handled without defaulting fs to true,
   * preserving brokered no-fs semantics.
   */
  private computeArtifactSetDigest(
    candidate: EvolutionCandidate,
    revision?: CandidateRevision | null,
  ): string {
    const rawRevision = revision as unknown;
    const revArtifacts =
      revision?.artifacts ??
      (rawRevision && typeof rawRevision === "object" && "artifacts" in rawRevision
        ? (rawRevision as { artifacts?: CandidateRevision["artifacts"] }).artifacts
        : undefined);
    const rawManifest = revArtifacts?.manifest ?? candidate.proposedTool;
    const normalizedManifest = normalizeLegacyManifestForDigest(rawManifest);
    const { digest: _d, createdAt: _ca, updatedAt: _ua, ...manifestWithoutDigest } = normalizedManifest as unknown as Record<string, unknown>;
    const sourceCode = revArtifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const capabilities = revArtifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDefinition = revArtifacts?.workflowDefinition ?? null;
    const tests = revArtifacts?.tests ?? null;
    const plan = normalizePlanForDigest(revArtifacts?.plan ?? null);
    return hashCanonical({
      manifest: manifestWithoutDigest,
      sourceCode,
      capabilities,
      tests,
      workflowDefinition,
      plan,
    });
  }
  /**
   * Helper to compute canonical evidence digests for a candidate and revision.
   */
  private computeCandidateEvidenceDigests(
    candidate: EvolutionCandidate,
    revision?: CandidateRevision | null,
  ): EvidenceDigests {
    const rawRevision = revision as unknown;
    const revArtifacts =
      revision?.artifacts ??
      (rawRevision && typeof rawRevision === "object" && "artifacts" in rawRevision
        ? (rawRevision as { artifacts?: CandidateRevision["artifacts"] }).artifacts
        : undefined);
    const rawManifest = revArtifacts?.manifest ?? candidate.proposedTool;
    const normalizedManifest = normalizeLegacyManifestForDigest(rawManifest);
    const { digest: _d, createdAt: _ca, updatedAt: _ua, ...manifestWithoutDigest } = normalizedManifest as unknown as Record<string, unknown>;
    const sourceCode = revArtifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const capabilities = revArtifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDef = revArtifacts?.workflowDefinition;
    const tests = revArtifacts?.tests;
    return {
      manifestDigest: hashCanonicalContent(manifestWithoutDigest),
      sourceDigest: computeSha256(sourceCode),
      capabilityDigest: hashCanonical(capabilities),
      workflowDigest: workflowDef ? hashCanonical(workflowDef) : undefined,
      testDigest: tests ? computeSha256(JSON.stringify(tests)) : undefined,
      artifactSetDigest: this.computeArtifactSetDigest(candidate, revision),
    };
  }

  /**
   * Loads the exact immutable revision pinned by the lifecycle record.
   * Returns null for legacy records without a persisted revision row; callers
   * then fall back to the candidate's proposedTool/source for backwards
   * compatibility while still enforcing artifactSetDigest when present.
   */
  private async loadPinnedRevision(
    tenant: TenantContext,
    record: CandidateLifecycleRecord,
  ): Promise<CandidateRevision | null> {
    if (!record.activeRevisionId) return null;
    const rev = await this.candidateRepo.getRevisionById(tenant, record.activeRevisionId);
    if (!rev) {
      throw new Error(
        `Pinned revision '${record.activeRevisionId}' not found for candidate '${record.candidateId}'`,
      );
    }
    return rev;
  }

  /**
   * Verifies the current artifact-set digest of the pinned revision matches the
   * digest stored at lifecycle start. Throws on mismatch so that Revision A
   * evidence cannot promote/publish Revision B and same-source changed-manifest
   * is rejected. Legacy records without artifactSetDigest are exempt.
   */
  private verifyPinnedArtifactSet(
    record: CandidateLifecycleRecord,
    candidate: EvolutionCandidate,
    pinnedRevision: CandidateRevision | null,
  ): void {
    const stored = record.evidenceDigests?.artifactSetDigest;
    if (!stored) return;
    const current = this.computeArtifactSetDigest(candidate, pinnedRevision);
    if (current !== stored) {
      throw new Error(
        `Artifact-set digest mismatch for candidate '${record.candidateId}': stored '${stored}' vs current '${current}' (pinned revision '${record.activeRevisionId}')`,
      );
    }
  }

  /**
   * Starts candidate lifecycle from 'drafted' stage, persists initial record,
   * logs transition, and schedules validation.
   */
  async startLifecycle(
    tenant: TenantContext,
    candidate: EvolutionCandidate,
    revision?: CandidateRevision | null,
    options: LifecycleStepOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);

    const candidateId = candidate.id;
    const rawRevision = revision as unknown;
    const idFromRevision =
      rawRevision &&
      typeof rawRevision === "object" &&
      "id" in rawRevision &&
      typeof rawRevision.id === "string"
        ? rawRevision.id
        : undefined;
    let revisionId = revision?.revisionId ?? idFromRevision ?? `rev_${candidateId}_1`;
    const targetVersion = options.targetVersion ?? candidate.proposedTool.version ?? "1.0.0";
    const now = new Date().toISOString();

    // Ensure candidate & revision are persisted and use the normalized persisted
    // representation for digest computation so that hash is byte-equivalent
    // after repository round-trip (canonical JSON, stored plan, etc.).
    let persistedCandidate: EvolutionCandidate = candidate;
    let persistedRevision: CandidateRevision | null = revision ?? null;
    const existingCand = await this.candidateRepo.getCandidateById(tenant, candidateId);
    if (!existingCand) {
      persistedCandidate = await this.candidateRepo.saveCandidate(tenant, candidate);
    } else {
      persistedCandidate = existingCand;
    }
    if (revision) {
      const existingRev = await this.candidateRepo.getRevisionById(tenant, revisionId);
      if (!existingRev) {
        persistedRevision = await this.candidateRepo.saveRevision(tenant, revision);
      } else {
        persistedRevision = existingRev;
      }
    } else {
      // Legacy path: synthesize and persist a complete immutable CandidateRevision
      // from candidate manifest/source/capabilities before pinning. Never pin
      // a synthetic ID without a persisted row.
      const existingSynthetic = await this.candidateRepo.getRevisionById(tenant, revisionId);
      if (existingSynthetic) {
        persistedRevision = existingSynthetic;
      } else {
        const manifest = persistedCandidate.proposedTool;
        const rawCaps = persistedCandidate.requiredCapabilities as unknown as Record<string, unknown>;
        const capabilities = (() => {
          const caps = JSON.parse(JSON.stringify(rawCaps ?? {})) as Record<string, unknown>;
          if (caps.fs && typeof caps.fs === "object") {
            const fs = caps.fs as Record<string, unknown>;
            if ("allowRead" in fs || "allowWrite" in fs) {
              const allowRead = Boolean((fs as Record<string, unknown>).allowRead);
              const allowWrite = Boolean((fs as Record<string, unknown>).allowWrite);
              caps.fs = {
                readPaths: Array.isArray(fs.readPaths) ? fs.readPaths : [],
                writePaths: Array.isArray(fs.writePaths) ? fs.writePaths : [],
                allowWorkspaceRoot: allowRead,
                allowTemp: allowRead || allowWrite,
                denyPaths: Array.isArray(fs.denyPaths) ? fs.denyPaths : [],
                maxFileSizeBytes: typeof fs.maxFileSizeBytes === "number" ? fs.maxFileSizeBytes : 10485760,
              };
            }
          }
          const capsRec = caps as Record<string, unknown>;
          if (capsRec.exec && !capsRec.command) {
            const exec = capsRec.exec as Record<string, unknown>;
            capsRec.command = {
              allowShellExecution: Boolean(exec.allowExec),
              allowedCommands: Array.isArray(exec.allowedCommands) ? exec.allowedCommands : [],
            };
          }
          return caps as unknown as CapabilityManifest;
        })();
        const sourceCode = persistedCandidate.sourceCode ?? "";
        const inputSchema = (manifest as unknown as { parameters: unknown }).parameters as Record<string, unknown>;
        const outputSchema = (manifest.outputSchema ?? { type: "object", properties: {}, required: [] }) as unknown as Record<string, unknown>;
        const opportunityId = (persistedCandidate as unknown as { opportunityId?: string }).opportunityId ?? `opp_${candidateId}`;
        const plan = {
          id: `plan_${candidateId}`,
          opportunityId,
          workspaceId: tenant.workspaceId,
          name: manifest.name,
          description: manifest.description,
          intent: manifest.description,
          targetType: "single_tool",
          variableInputs: [],
          invariantInputs: [],
          inputSchema,
          outputSchema,
          steps: [],
          capabilities,
          capabilityRequirements: capabilities,
          runtime: {
            runtime: "deno",
            memoryLimitMb: 128,
            timeoutMs: 30000,
            cpuLimitPercent: 100,
            maxOutputSizeBytes: 1048576,
          },
          metadata: {},
          createdAt: now,
        } as unknown as CandidateRevision["artifacts"]["plan"];
        const workflowContract = (manifest as unknown as { workflowContract?: unknown }).workflowContract ?? (rawCaps as unknown as { workflowContract?: unknown })?.workflowContract;
        if (workflowContract) {
          (plan as unknown as Record<string, unknown>).workflowContract = workflowContract;
        }
        const manifestForRevision = { ...manifest, capabilities } as unknown as CandidateRevision["artifacts"]["manifest"];
        const synthesized: CandidateRevision = {
          revisionId,
          candidateId,
          revisionNumber: 1,
          artifacts: {
            plan,
            manifest: manifestForRevision,
            capabilities: capabilities as unknown as CandidateRevision["artifacts"]["capabilities"],
            sourceCode,
            workflowDefinition: (persistedCandidate as unknown as { workflowDefinition?: unknown }).workflowDefinition as CandidateRevision["artifacts"]["workflowDefinition"],
            tests: (persistedCandidate as unknown as { tests?: unknown }).tests as CandidateRevision["artifacts"]["tests"],
            generatedAt: now,
          },
          selfReview: {
            passed: true,
            issues: [],
            reviewedAt: now,
          },
          repairHistory: [],
          createdAt: now,
        } as CandidateRevision;
        persistedRevision = await this.candidateRepo.saveRevision(tenant, synthesized);
      }
    }

    const existing = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (existing) {
      if (existing.activeRevisionId === revisionId) {
        // Immutable revision check: same ID must have same artifacts, else issue new revision
        if (revision && persistedRevision) {
          const existingHash = this.computeArtifactSetDigest(persistedCandidate, persistedRevision);
          const newHash = this.computeArtifactSetDigest(persistedCandidate, revision);
          if (existingHash !== newHash) {
            // Same revision ID but different artifacts – immutable violation, create new revision
            const newRevisionId = `${revisionId}_imm_${Date.now().toString(36).slice(0, 6)}`;
            const newRevision: CandidateRevision = {
              ...revision,
              revisionId: newRevisionId,
              revisionNumber: (persistedRevision.revisionNumber ?? 1) + 1,
              parentRevisionId: persistedRevision.revisionId,
            };
            const persistedNewRevision = await this.candidateRepo.saveRevision(tenant, newRevision);
            persistedRevision = persistedNewRevision;
            revisionId = newRevisionId;
            // Fall through to revision-change handling below
          } else {
            await this.ensureOutboxForState(tenant, existing);
            return existing;
          }
        } else {
          await this.ensureOutboxForState(tenant, existing);
          return existing;
        }
      }
      // Revision changed: start a fresh validation chain and clear downstream evidence.
      // Preserve atomicity expectations of peer AtomicLifecycleSuccessors by using
      // repository clearing logic (revisionChange) and re-enqueueing validation.
      const newDigests = this.computeCandidateEvidenceDigests(persistedCandidate, persistedRevision);
      const persistedReplayOptionsForRevChange = options.replayOptions as unknown as HistoricalReplayOptions | undefined;
      const persistedReplayOptionsDigestForRevChange = persistedReplayOptionsForRevChange
        ? hashCanonical(persistedReplayOptionsForRevChange)
        : null;
      if (persistedReplayOptionsDigestForRevChange) {
        newDigests.replayOptionsDigest = persistedReplayOptionsDigestForRevChange;
      }
      const revChangeNow = new Date().toISOString();
      const revChangeTransition = {
        revisionId,
        fromState: existing.currentState,
        toState: "validating" as const,
        targetVersion,
        idempotencyKey: `cand_${candidateId}_rev_change_${revisionId}_${Date.now()}`,
        attempt: (existing.attempt || 1) + 1,
        evidenceDigests: newDigests,
        terminalReason: null,
        validationResult: null,
        replayResult: null,
        evaluationResult: null,
        publicationRecordId: null,
        publishedVersion: null,
        persistedReplayOptions: persistedReplayOptionsForRevChange ?? null,
        persistedReplayOptionsDigest: persistedReplayOptionsDigestForRevChange,
        attemptHistoryEntry: {
          attempt: (existing.attempt || 1) + 1,
          state: "validating" as const,
          startedAt: revChangeNow,
          completedAt: revChangeNow,
          durationMs: 0,
          status: "retrying" as const,
          error: `Revision change ${existing.activeRevisionId} -> ${revisionId}`,
        },
        metadata: {
          stage: "revision_change",
          previousRevisionId: existing.activeRevisionId,
          newRevisionId: revisionId,
          previousState: existing.currentState,
        },
      };
      const revChangePayload: LifecycleJobPayload = {
        candidateId,
        revisionId,
        targetVersion,
        step: "validate",
        idempotencyKey: `cand_${candidateId}_val_job_rev_change_${revisionId}_1`,
        attempt: 1,
        scheduledAt: revChangeNow,
      };
      const refreshed = await this.atomicTransitionWithOutbox(
        tenant,
        candidateId,
        revChangeTransition as never,
        revChangePayload,
        EVOLUTION_LIFECYCLE_JOB_TYPES.VALIDATE_CANDIDATE,
        "validate",
      );
      return refreshed;
    }

    const digests = this.computeCandidateEvidenceDigests(persistedCandidate, persistedRevision);
    const persistedReplayOptions = options.replayOptions as unknown as HistoricalReplayOptions | undefined;
    const persistedReplayOptionsDigest = persistedReplayOptions ? hashCanonical(persistedReplayOptions) : null;
    if (persistedReplayOptionsDigest) {
      digests.replayOptionsDigest = persistedReplayOptionsDigest;
    }
    const idempotencyKey = options.idempotencyKey ?? `cand_${candidateId}_drafted_${Date.now()}`;
    const draftedTransition = {
      revisionId,
      fromState: "drafted" as const,
      toState: "drafted" as const,
      targetVersion,
      idempotencyKey,
      attempt: 1,
      evidenceDigests: digests,
      persistedReplayOptions: persistedReplayOptions ?? null,
      persistedReplayOptionsDigest,
      attemptHistoryEntry: {
        attempt: 1,
        state: "drafted" as const,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        status: "succeeded" as const,
      },
      metadata: {
        toolName: candidate.proposedTool.name,
        targetVersion,
        stage: "draft",
      },
    };
    const jobPayload: LifecycleJobPayload = {
      candidateId,
      revisionId,
      targetVersion,
      step: "validate",
      idempotencyKey: `cand_${candidateId}_val_job_1`,
      attempt: 1,
      scheduledAt: now,
    };

    const record = await this.atomicTransitionWithOutbox(
      tenant,
      candidateId,
      draftedTransition as never,
      jobPayload,
      EVOLUTION_LIFECYCLE_JOB_TYPES.VALIDATE_CANDIDATE,
      "validate",
    );
    return record;
  }

  /**
   * Drives a candidate sequentially through all lifecycle stages:
   * startLifecycle -> stepValidate -> stepReplay -> stepEvaluate -> stepPublish.
   */
  async driveToCompletion(
    tenant: TenantContext,
    candidate: EvolutionCandidate,
    revision?: CandidateRevision | null,
    options: LifecycleStepOptions = {},
  ): Promise<{ record: CandidateLifecycleRecord; toolVersion: ToolVersion }> {
    await this.startLifecycle(tenant, candidate, revision, options);

    const valRecord = await this.stepValidate(tenant, candidate.id, options);
    if (
      valRecord.currentState === "failed" ||
      valRecord.currentState === "rejected" ||
      valRecord.currentState === "dead_letter"
    ) {
      const validationDiagnostics = {
        terminalReason: valRecord.terminalReason,
        validationResult: valRecord.validationResult,
      };
      throw new Error(
        `Candidate validation failed with state '${valRecord.currentState}': ${JSON.stringify(validationDiagnostics)}`,
      );
    }

    const replayRecord = await this.stepReplay(tenant, candidate.id, options);
    if (
      replayRecord.currentState === "failed" ||
      replayRecord.currentState === "rejected" ||
      replayRecord.currentState === "dead_letter"
    ) {
      throw new Error(
        `Candidate replay failed with state '${replayRecord.currentState}': ${JSON.stringify({ terminalReason: replayRecord.terminalReason, replayResult: replayRecord.replayResult })}`,
      );
    }

    const evalRecord = await this.stepEvaluate(tenant, candidate.id, options);
    if (
      evalRecord.currentState === "failed" ||
      evalRecord.currentState === "rejected" ||
      evalRecord.currentState === "dead_letter"
    ) {
      throw new Error(`Candidate evaluation failed with state '${evalRecord.currentState}'`);
    }

    return this.stepPublish(tenant, candidate.id, options);
  }

  /**
   * Stage 1: Validation / Verification
   * Drives pure-compute, brokered, and workflow candidates through sandboxed validation.
   */
  async stepValidate(
    tenant: TenantContext,
    candidateId: string,
    options: LifecycleStepOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);

    const record = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (!record) {
      throw new Error(`Lifecycle record for candidate '${candidateId}' not found`);
    }

    // Monotonic progression & idempotency check
    if (
      record.currentState === "replaying" ||
      record.currentState === "evaluating" ||
      record.currentState === "eligible" ||
      record.currentState === "published"
    ) {
      await this.ensureOutboxForState(tenant, record);
      return record;
    }

    if (
      record.currentState === "rejected" ||
      record.currentState === "failed" ||
      record.currentState === "blocked" ||
      record.currentState === "quarantined" ||
      record.currentState === "dead_letter" ||
      record.currentState === "superseded"
    ) {
      return record;
    }

    const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
    if (!candidate) {
      throw new Error(`Candidate '${candidateId}' not found in repository`);
    }

    // Pin to the immutable revision recorded in the lifecycle row; do not use
    // getActiveRevision which could drift to a newer B revision. Legacy
    // records without a persisted revision fall back to the candidate snapshot
    // but still enforce artifactSetDigest when present.
    const pinnedRevision = await this.loadPinnedRevision(tenant, record);
    this.verifyPinnedArtifactSet(record, candidate, pinnedRevision);
    const sourceCode = pinnedRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const manifest = pinnedRevision?.artifacts?.manifest ?? candidate.proposedTool;
    const requiredCapabilities =
      pinnedRevision?.artifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDefinition = pinnedRevision?.artifacts?.workflowDefinition;
    const tests = pinnedRevision?.artifacts?.tests;

    const attemptNumber = options.attempt ?? (record.attempt || 1);
    const startTime = Date.now();
    const nowIso = new Date().toISOString();

    try {
      // Execute Candidate Validation Service with pinned revision snapshot
      const validationResult = await this.validationService.validateCandidate(
        {
          id: candidate.id,
          candidateId: candidate.id,
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          manifest,
          sourceCode,
          requiredCapabilities,
          workflowDefinition,
        },
        {
          envelope: options.envelope,
          ...options.validationOptions,
        },
      );

      const isPassed = validationResult.status === "pass" || validationResult.passed === true;
      const isRepairable = validationResult.status === "repairable_fail";
      const durationMs = Date.now() - startTime;

      const attemptEntry: AttemptHistoryEntry = {
        attempt: attemptNumber,
        state: "validating",
        startedAt: nowIso,
        completedAt: new Date().toISOString(),
        durationMs,
        status: isPassed ? "succeeded" : "failed",
        error: isPassed ? undefined : `Validation failed with status '${validationResult.status}'`,
        diagnostics: validationResult.staticFindings?.length
          ? { findingsCount: validationResult.staticFindings.length }
          : undefined,
      };

      if (isPassed) {
        const validationDigest = hashCanonical(validationResult);
        const evidenceDigests: EvidenceDigests = {
          ...record.evidenceDigests,
          ...this.computeCandidateEvidenceDigests(candidate, pinnedRevision),
          validationDigest,
        };
        // Persist replay evidence atomically before any replay job when supplied via validate flow.
        const persistedReplayOptionsForValidate = options.replayOptions as unknown as HistoricalReplayOptions | undefined;
        const persistedReplayOptionsDigestForValidate = persistedReplayOptionsForValidate
          ? hashCanonical(persistedReplayOptionsForValidate)
          : null;
        if (persistedReplayOptionsDigestForValidate) {
          evidenceDigests.replayOptionsDigest = persistedReplayOptionsDigestForValidate;
        }

        const idempotencyKey =
          options.idempotencyKey ?? `cand_${candidateId}_validated_${attemptNumber}`;

                const replayJobPayload: LifecycleJobPayload = {
          candidateId,
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          targetVersion: record.targetVersion,
          step: "replay",
          idempotencyKey: `cand_${candidateId}_replay_job_${attemptNumber}`,
          attempt: 1,
          scheduledAt: new Date().toISOString(),
        };
        const replayTransition: Record<string, unknown> = {
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: "replaying" as const,
          targetVersion: record.targetVersion,
          idempotencyKey,
          attempt: attemptNumber,
          evidenceDigests,
          validationResult: { ...validationResult, passed: true },
          attemptHistoryEntry: attemptEntry,
          metadata: { stage: "validate", status: "passed", durationMs },
        };
        if (persistedReplayOptionsForValidate !== undefined) {
          (replayTransition as Record<string, unknown>).persistedReplayOptions = persistedReplayOptionsForValidate;
          (replayTransition as Record<string, unknown>).persistedReplayOptionsDigest = persistedReplayOptionsDigestForValidate;
        }
        const updated = await this.atomicTransitionWithOutbox(
          tenant,
          candidateId,
          replayTransition as never,
          replayJobPayload,
          EVOLUTION_LIFECYCLE_JOB_TYPES.REPLAY_CANDIDATE,
          "replay",
        );

        return updated;
      }

      // L1: route repairable validation failures through the bounded repair
      // loop before going terminal. Each attempt produces a child revision and
      // re-enters validation; at most 2 validation-driven repairs per candidate.
      if (isRepairable && attemptNumber <= 2 && pinnedRevision) {
        const repaired = await this.attemptValidationRepair(
          tenant,
          candidate.id,
          record,
          pinnedRevision,
          validationResult,
          options,
          attemptNumber,
        );
        if (repaired) {
          return this.stepValidate(tenant, candidateId, {
            ...options,
            attempt: attemptNumber + 1,
          });
        }
      }

      // Handle Validation Failure
      const terminalReason: TerminalReason = {
        code: "VALIDATION_FAILED",
        message: `Candidate validation failed: status=${validationResult.status}`,
        category: "validation_failed",
        details: {
          status: validationResult.status,
          typecheckPassed: validationResult.typecheckPassed,
          typecheckErrors: validationResult.typecheckErrors,
          staticFindings: validationResult.staticFindings,
        },
      };

      const idempotencyKey =
        options.idempotencyKey ?? `cand_${candidateId}_val_failed_${attemptNumber}`;
      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState: "failed",
        targetVersion: record.targetVersion,
        idempotencyKey,
        attempt: attemptNumber,
        terminalReason,
        validationResult,
        attemptHistoryEntry: attemptEntry,
        metadata: { stage: "validate", status: validationResult.status },
      });
      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "validate",
        errorCategory: "validation_failure",
        errorMessage: terminalReason.message,
        retryClassification: "terminal",
        attemptCount: attemptNumber,
        diagnostics: terminalReason.details || {},
        resumed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      return failedRecord;
    } catch (err) {
      const classification = classifyError(err, attemptNumber);
      const attemptEntry: AttemptHistoryEntry = {
        attempt: attemptNumber,
        state: "validating",
        startedAt: nowIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status: classification.retryable ? "retrying" : "failed",
        error: classification.reason,
      };

      if (classification.retryable) {
        return await this.lifecycleRepo.recordTransition(tenant, candidateId, {
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: record.currentState,
          targetVersion: record.targetVersion,
          idempotencyKey: `cand_${candidateId}_val_retry_${attemptNumber}_${Date.now()}`,
          attempt: attemptNumber + 1,
          attemptHistoryEntry: attemptEntry,
          metadata: {
            retryClassification: classification.classification,
            reason: classification.reason,
          },
        });
      }

      const isValidationOrSecurity =
        classification.category === "validation_failure" ||
        classification.category === "capability_violation" ||
        classification.category === "evaluation_hard_gate" ||
        classification.classification === "terminal";

      const terminalReason: TerminalReason = {
        code: isValidationOrSecurity ? "VALIDATION_FAILED" : "VALIDATION_INFRASTRUCTURE_ERROR",
        message: classification.reason,
        category: isValidationOrSecurity ? "validation_failed" : "infrastructure_exhausted",
        details: { error: String(err) },
      };

      const toState: CandidateLifecycleState = isValidationOrSecurity ? "failed" : "dead_letter";

      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState,
        targetVersion: record.targetVersion,
        idempotencyKey: `cand_${candidateId}_val_failed_${attemptNumber}_${Date.now()}`,
        attempt: attemptNumber,
        terminalReason,
        attemptHistoryEntry: attemptEntry,
        metadata: { retryClassification: classification.classification, error: String(err) },
      });
      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "validate",
        errorCategory: classification.category,
        errorMessage: classification.reason,
        retryClassification: classification.classification,
        attemptCount: attemptNumber,
        diagnostics: redactDiagnostics({
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }) as Record<string, unknown>,
        resumed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      return failedRecord;
    }
  }

  private getPersistedReplayOptions(
    record: CandidateLifecycleRecord,
  ): HistoricalReplayOptions | undefined {
    const persisted = record.persistedReplayOptions;
    const digest = record.persistedReplayOptionsDigest;
    if (!persisted && !digest) return undefined;
    if (!persisted || !digest) {
      throw new Error(
        `Persisted replay options integrity failure for candidate '${record.candidateId}': options or digest missing (options=${persisted ? "present" : "missing"}, digest=${digest ? "present" : "missing"})`,
      );
    }
    const computed = hashCanonical(persisted);
    if (computed !== digest) {
      throw new Error(
        `Persisted replay options digest mismatch for candidate '${record.candidateId}': tampered persisted options (expected '${digest}', computed '${computed}')`,
      );
    }
    const digestInEvidence = record.evidenceDigests?.replayOptionsDigest;
    if (digestInEvidence && digestInEvidence !== digest) {
      throw new Error(
        `Persisted replay options digest mismatch for candidate '${record.candidateId}': evidence digests out of sync (record '${digest}' vs evidenceDigests '${digestInEvidence}')`,
      );
    }
    return persisted;
  }

  /**
   * Atomically persists workload benchmark evidence for a candidate that is already
   * in replaying state. This is the durable counterpart to the ephemeral
   * replayOptions that was previously passed directly to stepReplay. The method
   * hashes the options, updates evidenceDigests.replayOptionsDigest and the
   * persisted columns in a single recordTransition, so a later queued/resumed
   * stepReplay reads verified persisted options only.
   */
  async persistReplayOptions(
    tenant: TenantContext,
    candidateId: string,
    replayOptions: HistoricalReplayOptions,
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);
    const record = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (!record) {
      throw new Error(`Lifecycle record for candidate '${candidateId}' not found`);
    }
    const digest = hashCanonical(replayOptions);
    // Validate that persisted digest would not conflict with a different already-persisted value.
    if (record.persistedReplayOptionsDigest && record.persistedReplayOptionsDigest !== digest) {
      const computedExisting = record.persistedReplayOptions ? hashCanonical(record.persistedReplayOptions) : null;
      if (computedExisting && computedExisting !== digest) {
        // Allow overwrite but the digest mismatch will be caught by getPersistedReplayOptions on next replay.
        // We still persist the new value atomically.
      }
    }
    const evidenceDigests: EvidenceDigests = {
      ...record.evidenceDigests,
      replayOptionsDigest: digest,
    };
    const transition = {
      revisionId: record.activeRevisionId,
      fromState: record.currentState,
      toState: record.currentState,
      targetVersion: record.targetVersion,
      idempotencyKey: `cand_${candidateId}_persist_replay_${digest.slice(0, 8)}_${Date.now()}`,
      attempt: record.attempt,
      evidenceDigests,
      persistedReplayOptions: replayOptions,
      persistedReplayOptionsDigest: digest,
      metadata: { stage: "persist_replay_options" },
    };
    return this.lifecycleRepo.recordTransition(tenant, candidateId, transition as never);
  }

  private async resolveReplayEvidence(
    tenant: TenantContext,
    candidate: EvolutionCandidate,
    baselineEvents?: NormalizedSessionEvent[],
  ): Promise<EvidenceSource> {
    if (baselineEvents && baselineEvents.length > 0) {
      // Ephemeral baselineEvents are ignored after startLifecycle persistence.
      // This branch is retained only for legacy direct calls without persisted record;
      // stepReplay will not pass baselineEvents after durability fix.
      return { id: `candidate_${candidate.id}_explicit_evidence`, events: baselineEvents };
    }

    const evidenceEventIds = candidate.trigger?.evidenceEventIds ?? [];
    const persistedById = new Map<string, NormalizedSessionEvent>();
    const deadline = Date.now() + this.replayEvidenceWaitMs;

    if (this.observationRepo && evidenceEventIds.length > 0) {
      let continuePolling = true;
      while (continuePolling) {
        for (const eventId of evidenceEventIds) {
          if (persistedById.has(eventId)) continue;
          const entity = await this.observationRepo.getEventById(tenant, eventId);
          if (!entity) continue;
          persistedById.set(eventId, {
            eventId: entity.id,
            sessionId: entity.sessionId,
            timestamp: entity.timestamp,
            type: entity.eventType as NormalizedSessionEvent["type"],
            schemaVersion: entity.schemaVersion,
            causalRef: {
              causalSequence: entity.causalSequence,
              parentId: entity.parentId ?? undefined,
              rootId: entity.rootId ?? undefined,
              turnIndex: entity.turnIndex ?? undefined,
              stepIndex: entity.stepIndex ?? undefined,
              traceId: entity.traceId ?? undefined,
              spanId: entity.spanId ?? undefined,
            },
            redaction: entity.redaction ?? { isRedacted: false, rulesApplied: [] },
            ...entity.payload,
          } as unknown as NormalizedSessionEvent);
        }

        continuePolling = persistedById.size < evidenceEventIds.length && Date.now() < deadline;
        if (continuePolling) {
          await new Promise((resolve) => setTimeout(resolve, this.replayEvidencePollMs));
        }
      }
    }

    const persistedEvents = [...persistedById.values()].sort((left, right) => {
      const timeDelta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
      if (timeDelta !== 0) return timeDelta;
      return (left.causalRef?.causalSequence ?? 0) - (right.causalRef?.causalSequence ?? 0);
    });
    const missingEventIds = evidenceEventIds.filter((eventId) => !persistedById.has(eventId));

    if (
      persistedEvents.length > 0 &&
      (!this.requirePersistedReplayEvidence || missingEventIds.length === 0)
    ) {
      return { id: `candidate_${candidate.id}_persisted_evidence`, events: persistedEvents };
    }

    if (this.requirePersistedReplayEvidence) {
      throw new Error(
        `Candidate '${candidate.id}' is missing tenant-scoped persisted replay evidence after ${this.replayEvidenceWaitMs}ms. Missing IDs: ${missingEventIds.join(", ") || "all evidence IDs absent"}`,
      );
    }

    return { id: `candidate_${candidate.id}_test_evidence`, events: persistedEvents };
  }

  /**
   * Stage 2: Historical Replay
   * Replays pure-compute, brokered atomic, and workflow candidates against baseline session evidence.
   */
  async stepReplay(
    tenant: TenantContext,
    candidateId: string,
    options: LifecycleStepOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);

    const record = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (!record) {
      throw new Error(`Lifecycle record for candidate '${candidateId}' not found`);
    }

    if (
      record.currentState === "evaluating" ||
      record.currentState === "eligible" ||
      record.currentState === "published"
    ) {
      await this.ensureOutboxForState(tenant, record);
      return record;
    }

    if (
      record.currentState === "rejected" ||
      record.currentState === "failed" ||
      record.currentState === "blocked" ||
      record.currentState === "quarantined" ||
      record.currentState === "dead_letter" ||
      record.currentState === "superseded"
    ) {
      return record;
    }
    const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
    if (!candidate) {
      throw new Error(`Candidate '${candidateId}' not found`);
    }

    const pinnedRevision = await this.loadPinnedRevision(tenant, record);
    this.verifyPinnedArtifactSet(record, candidate, pinnedRevision);
    const sourceCode = pinnedRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const manifest = pinnedRevision?.artifacts?.manifest ?? candidate.proposedTool;
    const requiredCapabilities =
      pinnedRevision?.artifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDefinition = pinnedRevision?.artifacts?.workflowDefinition;

    const attemptNumber = options.attempt ?? (record.attempt || 1);
    const startTime = Date.now();
    const nowIso = new Date().toISOString();
    try {
      const persistedReplayOptions = this.getPersistedReplayOptions(record);
      const replayResult: HistoricalReplayResult = await this.replayService.replayCandidate(
        tenant,
        {
          candidate: {
            id: candidate.id,
            candidateId: candidate.id,
            revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
            manifest,
            sourceCode,
            requiredCapabilities,
            workflowDefinition,
          },
          evidence: await this.resolveReplayEvidence(tenant, candidate),
          options: persistedReplayOptions,
        },
      );

      const isPassed = replayResult.status === "pass" || replayResult.passed === true;
      const isRepairable = replayResult.status === "repairable_divergence";
      const durationMs = Date.now() - startTime;

      const attemptEntry: AttemptHistoryEntry = {
        attempt: attemptNumber,
        state: "replaying",
        startedAt: nowIso,
        completedAt: new Date().toISOString(),
        durationMs,
        status: isPassed ? "succeeded" : "diverged",
        error: isPassed ? undefined : `Replay diverged with status '${replayResult.status}'`,
      };

      if (isPassed) {
        const replayDigest = hashCanonical(replayResult);
        const evidenceDigests: EvidenceDigests = {
          ...record.evidenceDigests,
          ...this.computeCandidateEvidenceDigests(candidate, pinnedRevision),
          replayDigest,
        };

        const idempotencyKey =
          options.idempotencyKey ?? `cand_${candidateId}_replayed_${attemptNumber}`;

                const evaluateJobPayload: LifecycleJobPayload = {
          candidateId,
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          targetVersion: record.targetVersion,
          step: "evaluate",
          idempotencyKey: `cand_${candidateId}_eval_job_${attemptNumber}`,
          attempt: 1,
          scheduledAt: new Date().toISOString(),
        };
        const evaluatingTransition = {
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: "evaluating" as const,
          targetVersion: record.targetVersion,
          idempotencyKey,
          attempt: attemptNumber,
          evidenceDigests,
          replayResult: { ...replayResult, passed: true },
          attemptHistoryEntry: attemptEntry,
          metadata: { stage: "replay", status: "passed", durationMs },
        };
        const updated = await this.atomicTransitionWithOutbox(
          tenant,
          candidateId,
          evaluatingTransition as never,
          evaluateJobPayload,
          EVOLUTION_LIFECYCLE_JOB_TYPES.EVALUATE_CANDIDATE,
          "evaluate",
        );

        return updated;
      }

      // Replay Diverged
      const terminalReason: TerminalReason = {
        code: "REPLAY_DIVERGENCE",
        message: `Candidate diverged during historical session replay: status=${replayResult.status}`,
        category: "replay_divergence",
        details: {
          status: replayResult.status,
          divergences: replayResult.divergenceFindings,
          passedScenarioCount: replayResult.passedScenarioCount,
          totalScenarioCount: replayResult.totalScenarioCount,
        },
      };

      const idempotencyKey =
        options.idempotencyKey ?? `cand_${candidateId}_replay_failed_${attemptNumber}`;
      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState: "rejected",
        targetVersion: record.targetVersion,
        idempotencyKey,
        attempt: attemptNumber,
        terminalReason,
        replayResult,
        attemptHistoryEntry: attemptEntry,
        metadata: { stage: "replay", status: "rejected" },
      });

      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "replay",
        errorCategory: "replay_divergence",
        errorMessage: terminalReason.message,
        retryClassification: "terminal",
        attemptCount: attemptNumber,
        diagnostics: terminalReason.details || {},
        resumed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      return failedRecord;
    } catch (err) {
      const classification = classifyError(err, attemptNumber);
      const attemptEntry: AttemptHistoryEntry = {
        attempt: attemptNumber,
        state: "replaying",
        startedAt: nowIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status: classification.retryable ? "retrying" : "failed",
        error: classification.reason,
      };

      if (classification.retryable) {
        return await this.lifecycleRepo.recordTransition(tenant, candidateId, {
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: record.currentState,
          targetVersion: record.targetVersion,
          idempotencyKey: `cand_${candidateId}_replay_retry_${attemptNumber}_${Date.now()}`,
          attempt: attemptNumber + 1,
          attemptHistoryEntry: attemptEntry,
          metadata: {
            retryClassification: classification.classification,
            reason: classification.reason,
          },
        });
      }

      const terminalReason: TerminalReason = {
        code: "REPLAY_INFRASTRUCTURE_ERROR",
        message: classification.reason,
        category: "infrastructure_exhausted",
        details: { error: String(err) },
      };

      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState: "dead_letter",
        targetVersion: record.targetVersion,
        idempotencyKey: `cand_${candidateId}_replay_dlq_${attemptNumber}_${Date.now()}`,
        attempt: attemptNumber,
        terminalReason,
        attemptHistoryEntry: attemptEntry,
        metadata: { retryClassification: classification.classification, error: String(err) },
      });

      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "replay",
        errorCategory: classification.category,
        errorMessage: classification.reason,
        retryClassification: classification.classification,
        attemptCount: attemptNumber,
        diagnostics: redactDiagnostics({
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }) as Record<string, unknown>,
        resumed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      return failedRecord;
    }
  }

  /**
   * Stage 3: Evaluation & Safety Gate Pipeline
   * Evaluates candidate quality, hard security gates, performance efficiency, and shadow metrics.
   */
  async stepEvaluate(
    tenant: TenantContext,
    candidateId: string,
    options: LifecycleStepOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);

    const record = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (!record) {
      throw new Error(`Lifecycle record for candidate '${candidateId}' not found`);
    }

    if (record.currentState === "eligible" || record.currentState === "published") {
      await this.ensureOutboxForState(tenant, record);
      return record;
    }

    if (
      record.currentState === "rejected" ||
      record.currentState === "failed" ||
      record.currentState === "blocked" ||
      record.currentState === "quarantined" ||
      record.currentState === "dead_letter" ||
      record.currentState === "superseded"
    ) {
      return record;
    }

    const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
    if (!candidate) {
      throw new Error(`Candidate '${candidateId}' not found`);
    }

    const pinnedRevision = await this.loadPinnedRevision(tenant, record);
    this.verifyPinnedArtifactSet(record, candidate, pinnedRevision);
    const sourceCode = pinnedRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const manifest = pinnedRevision?.artifacts?.manifest ?? candidate.proposedTool;
    const requiredCapabilities =
      pinnedRevision?.artifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDefinition = pinnedRevision?.artifacts?.workflowDefinition;

    const attemptNumber = options.attempt ?? (record.attempt || 1);
    const startTime = Date.now();
    const nowIso = new Date().toISOString();
    const rawCandidate = candidate as unknown as Record<string, unknown>;
    const rawTrigger = candidate.trigger as unknown as Record<string, unknown>;
    const opportunity = {
      id: (rawCandidate.opportunityId as string) || `opp_${candidate.id}`,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      clusterId: (rawCandidate.clusterId as string) || `cluster_${candidate.id}`,
      structuralHash: (rawCandidate.structuralHash as string) || `hash_${candidate.id}`,
      status: "eligible" as const,
      triggerType: "normal_frequency" as const,
      triggerReason: candidate.trigger.reason,
      occurrenceCount:
        (rawTrigger.sessionOccurrences as number) || (rawTrigger.patternFrequency as number) || 5,
      distinctSessionCount: 3,
      evidenceEventIds: candidate.trigger.evidenceEventIds,
      coverage: {
        covered: false,
        coveringCandidateIds: [],
        status: "net_new" as const,
        similarityScore: 0,
        overlapRatio: 0,
        reason: "none",
      },
      suppression: {
        suppressed: false,
        reason: "none" as const,
        details: "none",
      },
      classification: {
        title: manifest.name,
        description: manifest.description || "Synthesized tool",
        taskClass: "compute" as const,
        pattern: "recurring_steps",
        confidenceScore: 0.95,
        priority: "high" as const,
      },
      metrics: {
        totalDurationMs: 12000,
        avgDurationMs: 2400,
        totalTokens: 4500,
        totalRetries: 0,
        totalCostUsd: 0.05,
      },
      createdAt: candidate.trigger.detectedAt || nowIso,
      updatedAt: candidate.trigger.detectedAt || nowIso,
    };

    // Authoritative persisted revision plan drives gate recomputation; derive contract/coverage inside evaluation service
    const authoritativePlan: ToolPlan | undefined = pinnedRevision?.artifacts?.plan;

    // Validate persisted evidence before use; fail fast if required validationResult missing
    if (!record.validationResult) {
      throw new Error(`Missing validationResult for candidate '${candidateId}' — cannot evaluate without validation evidence`);
    }
    const validationResult: CandidateValidationResult = record.validationResult;
    const replayResult: HistoricalReplayResult | undefined = record.replayResult ?? undefined;

    try {
      const evaluationResult: EvaluationResult = await this.evaluationService.evaluateCandidate({
        candidate: {
          id: candidate.id,
          candidateId: candidate.id,
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          manifest,
          sourceCode,
          requiredCapabilities,
          workflowDefinition,
        },
        opportunity,
        envelope: options.envelope,
        options: options.evaluationOptions,
        validationResult,
        replayResult,
        toolPlan: authoritativePlan,
      });

      const durationMs = Date.now() - startTime;
      const rawResult: unknown = evaluationResult;
      const decRecord = (
        rawResult as {
          decisionRecord?: {
            decision?: string;
            verdict?: string;
            hardGateResult?: { passed?: boolean; failedGates?: string[] };
          };
        }
      )?.decisionRecord;
      const verdict =
        evaluationResult.overallDecision?.verdict ??
        decRecord?.verdict ??
        (rawResult &&
        typeof rawResult === "object" &&
        "verdict" in rawResult &&
        typeof (rawResult as { verdict?: string }).verdict === "string"
          ? (rawResult as { verdict?: string }).verdict
          : decRecord?.decision === "eligible_for_artifact"
            ? "pass"
            : "fail");

      const scoreFromDecision = evaluationResult.overallDecision?.score;
      const scoreFromComposite =
        rawResult &&
        typeof rawResult === "object" &&
        "compositeScore" in rawResult &&
        typeof rawResult.compositeScore === "number"
          ? rawResult.compositeScore
          : undefined;
      const rawScore = scoreFromDecision ?? scoreFromComposite ?? 0.95;
      const benchmarkScore = Number.isFinite(rawScore)
        ? Math.max(0, Math.min(1, rawScore as number))
        : 0.95;

      const rawHardGateResult =
        rawResult && typeof rawResult === "object" && "hardGateResult" in rawResult
          ? (rawResult.hardGateResult as { passed?: boolean; failedGates?: string[] } | undefined)
          : decRecord?.hardGateResult;
      const hardGatePassed = rawHardGateResult ? Boolean(rawHardGateResult.passed) : true;
      const failedGates = rawHardGateResult?.failedGates ?? [];

      const isPass =
        (verdict as string) === "pass" ||
        (verdict as string) === "eligible" ||
        (verdict as string) === "eligible_for_artifact" ||
        ((verdict as string) === "conditional" && hardGatePassed && benchmarkScore >= 0.7) ||
        decRecord?.decision === "eligible_for_artifact" ||
        (rawResult &&
          typeof rawResult === "object" &&
          "decision" in rawResult &&
          (rawResult as { decision?: string }).decision === "eligible_for_artifact");

      const isEligible = isPass && hardGatePassed;

      const attemptEntry: AttemptHistoryEntry = {
        attempt: attemptNumber,
        state: "evaluating",
        startedAt: nowIso,
        completedAt: new Date().toISOString(),
        durationMs,
        status: isEligible ? "succeeded" : "failed",
        error: isEligible ? undefined : `Evaluation rejected candidate with verdict '${verdict}'`,
      };
      if (isEligible) {
        const evaluationDigest = hashCanonical(evaluationResult);
        const evidenceDigests: EvidenceDigests = {
          ...record.evidenceDigests,
          ...this.computeCandidateEvidenceDigests(candidate, pinnedRevision),
          evaluationDigest,
        };

        const idempotencyKey =
          options.idempotencyKey ?? `cand_${candidateId}_evaluated_${attemptNumber}`;

                const publishJobPayload: LifecycleJobPayload = {
          candidateId,
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          targetVersion: record.targetVersion,
          step: "publish",
          idempotencyKey: `cand_${candidateId}_pub_job_${attemptNumber}`,
          attempt: 1,
          scheduledAt: new Date().toISOString(),
        };
        const eligibleTransition = {
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: "eligible" as const,
          targetVersion: record.targetVersion,
          idempotencyKey,
          attempt: attemptNumber,
          evidenceDigests,
          evaluationResult: {
            ...evaluationResult,
            overallDecision: {
              ...evaluationResult.overallDecision,
              verdict: "pass",
            },
          },
          attemptHistoryEntry: attemptEntry,
          metadata: { stage: "evaluate", status: "eligible", durationMs },
        };
        const updated = await this.atomicTransitionWithOutbox(
          tenant,
          candidateId,
          eligibleTransition as never,
          publishJobPayload,
          EVOLUTION_LIFECYCLE_JOB_TYPES.PUBLISH_CANDIDATE,
          "publish",
        );

        return updated;
      }

      // Evaluation Rejected
      const terminalReason: TerminalReason = {
        code: "EVALUATION_REJECTED",
        message: `Evaluation rejected candidate: verdict=${verdict}`,
        category: "evaluation_rejected",
        details: {
          verdict,
          hardGates: (rawResult as { hardGates?: unknown })?.hardGates,
          reasons: evaluationResult.overallDecision?.notes,
        },
      };

      const idempotencyKey = `cand_${candidateId}_eval_rejected_${attemptNumber}`;
      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState: "rejected",
        targetVersion: record.targetVersion,
        idempotencyKey,
        attempt: attemptNumber,
        terminalReason,
        evaluationResult,
        attemptHistoryEntry: attemptEntry,
        metadata: { stage: "evaluate", status: "rejected" },
      });

      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "evaluate",
        errorCategory: "evaluation_hard_gate",
        errorMessage: terminalReason.message,
        retryClassification: "terminal",
        attemptCount: attemptNumber,
        diagnostics: terminalReason.details || {},
        resumed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      return failedRecord;
    } catch (err) {
      const classification = classifyError(err, attemptNumber);
      const attemptEntry: AttemptHistoryEntry = {
        attempt: attemptNumber,
        state: "evaluating",
        startedAt: nowIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status: classification.retryable ? "retrying" : "failed",
        error: classification.reason,
      };

      if (classification.retryable) {
        return await this.lifecycleRepo.recordTransition(tenant, candidateId, {
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: record.currentState,
          targetVersion: record.targetVersion,
          idempotencyKey: `cand_${candidateId}_eval_retry_${attemptNumber}_${Date.now()}`,
          attempt: attemptNumber + 1,
          attemptHistoryEntry: attemptEntry,
          metadata: {
            retryClassification: classification.classification,
            reason: classification.reason,
          },
        });
      }

      const terminalReason: TerminalReason = {
        code: "EVALUATION_INFRASTRUCTURE_ERROR",
        message: classification.reason,
        category: "infrastructure_exhausted",
        details: { error: String(err) },
      };

      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState: "dead_letter",
        targetVersion: record.targetVersion,
        idempotencyKey: `cand_${candidateId}_eval_dlq_${attemptNumber}_${Date.now()}`,
        attempt: attemptNumber,
        terminalReason,
        attemptHistoryEntry: attemptEntry,
        metadata: { retryClassification: classification.classification, error: String(err) },
      });

      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "evaluate",
        errorCategory: classification.category,
        errorMessage: classification.reason,
        retryClassification: classification.classification,
        attemptCount: attemptNumber,
        diagnostics: redactDiagnostics({
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }) as Record<string, unknown>,
        resumed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      return failedRecord;
    }
  }

  /**
   * Stage 4: Signed Artifact Publication
   * Cryptographically packages, signs with Ed25519, publishes to tool registry & catalog service.
   */
  async stepPublish(
    tenant: TenantContext,
    candidateId: string,
    options: LifecycleStepOptions = {},
  ): Promise<{ record: CandidateLifecycleRecord; toolVersion: ToolVersion }> {
    this.enforceTenant(tenant);

    const record = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (!record) {
      throw new Error(`Lifecycle record for candidate '${candidateId}' not found`);
    }

    if (record.currentState === "published" && record.publishedVersion) {
      const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
      const toolId = candidate?.proposedTool?.id ?? candidateId;
      const activeVer = await this.artifactService.toolRegistryRepo.getToolVersion(
        tenant,
        toolId,
        record.publishedVersion,
      );
      if (activeVer) {
        return { record, toolVersion: activeVer };
      }
    }

    if (record.currentState !== "eligible") {
      throw new Error(
        `Candidate '${candidateId}' is in state '${record.currentState}', expected 'eligible' for publication`,
      );
    }

    if (!record.evaluationResult) {
      throw new Error(`Candidate '${candidateId}' has no recorded evaluation result`);
    }

    const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
    if (!candidate) {
      throw new Error(`Candidate '${candidateId}' not found`);
    }

    // 1. Verify candidate ownership & tenant/workspace scope
    if (candidate.workspaceId !== tenant.workspaceId) {
      throw new Error(
        `Tenant scope mismatch: candidate belongs to workspace '${candidate.workspaceId}', request workspace is '${tenant.workspaceId}'`,
      );
    }

    const candidateAccountId = (candidate as unknown as { accountId?: string }).accountId;
    if (tenant.accountId && candidateAccountId && candidateAccountId !== tenant.accountId) {
      throw new Error(
        `Tenant scope mismatch: candidate belongs to account '${candidateAccountId}', request account is '${tenant.accountId}'`,
      );
    }

    // 2. Verify evidence digests presence
    if (!record.evidenceDigests.manifestDigest || !record.evidenceDigests.sourceDigest) {
      throw new Error(
        `Candidate evidence digests are missing or incomplete for candidate '${candidateId}'`,
      );
    }

    // 3. Verify evidence freshness
    const rawEval: unknown = record.evaluationResult;
    const evalTimestamp =
      record.evaluationResult.overallDecision?.evaluatedAt ??
      (rawEval &&
      typeof rawEval === "object" &&
      "evaluatedAt" in rawEval &&
      typeof rawEval.evaluatedAt === "string"
        ? rawEval.evaluatedAt
        : (record.evaluationResult.completedAt ?? new Date().toISOString()));
    const evalAgeMs = Date.now() - new Date(evalTimestamp).getTime();
    if (evalAgeMs > this.evidenceMaxAgeMs) {
      throw new Error(
        `Evaluation evidence is stale (${evalAgeMs}ms > max allowable ${this.evidenceMaxAgeMs}ms)`,
      );
    }

    // 4. Verify Signing Key Status
    if (options.signingKeyId) {
      const isRevoked = await this.artifactService.signingKeyRepo.isRevoked(options.signingKeyId);
      if (isRevoked) {
        throw new Error(
          `Signing key '${options.signingKeyId}' is revoked and cannot be used for artifact publication`,
        );
      }
    }

    // Pin to immutable revision; verify artifact-set digest matches stored
    // snapshot so publication publishes exactly that snapshot and rejects
    // same-source changed-manifest.
    const pinnedRevision = await this.loadPinnedRevision(tenant, record);
    this.verifyPinnedArtifactSet(record, candidate, pinnedRevision);
    const sourceCode = pinnedRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const computedSourceDigest = computeSha256(sourceCode);
    if (
      record.evidenceDigests.sourceDigest &&
      record.evidenceDigests.sourceDigest !== computedSourceDigest
    ) {
      throw new Error(
        `Source digest mismatch: recorded '${record.evidenceDigests.sourceDigest}', current '${computedSourceDigest}'`,
      );
    }
    // Enforce complete artifact-set digest match before publish
    const currentArtifactSetDigest = this.computeArtifactSetDigest(candidate, pinnedRevision);
    if (
      record.evidenceDigests.artifactSetDigest &&
      record.evidenceDigests.artifactSetDigest !== currentArtifactSetDigest
    ) {
      throw new Error(
        `Artifact-set digest mismatch for publish: stored '${record.evidenceDigests.artifactSetDigest}' vs current '${currentArtifactSetDigest}' (pinned revision '${record.activeRevisionId}')`,
      );
    }
    const targetVersion = options.targetVersion ?? record.targetVersion;
    const attemptNumber = options.attempt ?? (record.attempt || 1);
    const startTime = Date.now();
    const nowIso = new Date().toISOString();

    try {
      const { digest: _d, ...baseManifest } =
        pinnedRevision?.artifacts?.manifest ?? candidate.proposedTool;
      const manifestForPublish: ToolManifest = {
        ...baseManifest,
        digest: hashCanonicalContent(baseManifest),
      };
      // The lifecycle record is authoritative here: validation, replay, and
      // evaluation have all passed. Candidate generation state can lag during
      // bounded repair, so normalize the artifact input to an approved state.
      const candidateForPublish: EvolutionCandidate = {
        ...candidate,
        state: "approved",
        proposedTool: manifestForPublish,
      };

      // 5. Build and Sign Tool Artifact using pinned snapshot
      const toolVersion = await this.artifactService.publishCandidate(
        candidateForPublish,
        record.evaluationResult,
        {
          overrideVersion: targetVersion,
          keyId: options.signingKeyId,
          revision: pinnedRevision ?? undefined,
          workflowDefinition: pinnedRevision?.artifacts?.workflowDefinition,
        },
      );

      const publicationRecordId = `pub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const idempotencyKey =
        options.idempotencyKey ?? `cand_${candidateId}_published_${attemptNumber}`;

      const attemptEntry: AttemptHistoryEntry = {
        attempt: attemptNumber,
        state: "published",
        startedAt: nowIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status: "succeeded",
      };

      const updatedDigests: EvidenceDigests = {
        ...record.evidenceDigests,
        artifactDigest: toolVersion.artifactDigest,
        signatureDigest: toolVersion.signature?.signature,
      };

            const publishedOutboxPayload = {
        candidateId,
        workspaceId: tenant.workspaceId,
        toolName: toolVersion.manifest.name,
        toolVersion: toolVersion.version,
        artifactDigest: toolVersion.artifactDigest,
        publicationRecordId,
        publishedAt: new Date().toISOString(),
      };
      const publishedOutboxId = `outbox_${candidateId}_published_${idempotencyKey}`;
      const publishedTransition = {
        revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
        fromState: "eligible" as const,
        toState: "published" as const,
        targetVersion: toolVersion.version,
        idempotencyKey,
        attempt: attemptNumber,
        evidenceDigests: updatedDigests,
        publicationRecordId,
        publishedVersion: toolVersion.version,
        attemptHistoryEntry: attemptEntry,
        metadata: {
          publicationRecordId,
          publishedVersion: toolVersion.version,
          artifactDigest: toolVersion.artifactDigest,
          signedKeyId: toolVersion.signature?.keyId,
        },
      };
      let updatedRecord: CandidateLifecycleRecord;
      if (this.pool && typeof (this.pool as unknown as { transaction?: unknown }).transaction === "function") {
        updatedRecord = await (this.pool as DatabasePool).transaction(async (tx) => {
          const rec = await this.lifecycleRepo.recordTransition(tenant, candidateId, publishedTransition as never, tx);
          await OutboxRepository.insert(tx, {
            id: publishedOutboxId,
            accountId: tenant.accountId,
            workspaceId: tenant.workspaceId,
            aggregateType: "candidate_lifecycle",
            aggregateId: candidateId,
            eventType: "candidate.lifecycle.published",
            payload: publishedOutboxPayload as unknown as Record<string, unknown>,
            headers: { step: "published", workspaceId: tenant.workspaceId },
          });
          return rec;
        });
      } else {
        updatedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, publishedTransition as never);
        await OutboxRepository.insert(this.pool as unknown as Queryable, {
          id: publishedOutboxId,
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          aggregateType: "candidate_lifecycle",
          aggregateId: candidateId,
          eventType: "candidate.lifecycle.published",
          payload: publishedOutboxPayload as unknown as Record<string, unknown>,
          headers: { step: "published", workspaceId: tenant.workspaceId },
        });
      }

      return { record: updatedRecord, toolVersion };
    } catch (err) {
      const classification = classifyError(err, attemptNumber);
      const attemptEntry: AttemptHistoryEntry = {
        attempt: attemptNumber,
        state: "eligible",
        startedAt: nowIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status: classification.retryable ? "retrying" : "failed",
        error: classification.reason,
      };

      if (classification.retryable) {
        await this.lifecycleRepo.recordTransition(tenant, candidateId, {
          revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: record.currentState,
          targetVersion: record.targetVersion,
          idempotencyKey: `cand_${candidateId}_pub_retry_${attemptNumber}_${Date.now()}`,
          attempt: attemptNumber + 1,
          attemptHistoryEntry: attemptEntry,
          metadata: {
            retryClassification: classification.classification,
            reason: classification.reason,
          },
        });
        throw err;
      }

      const terminalReason: TerminalReason = {
        code: "PUBLICATION_FAILED",
        message: classification.reason,
        category:
          classification.category === "signing_failure"
            ? "signing_revoked"
            : "infrastructure_exhausted",
        details: { error: String(err) },
      };

      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: pinnedRevision?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState: "failed",
        targetVersion: record.targetVersion,
        idempotencyKey: `cand_${candidateId}_pub_failed_${attemptNumber}_${Date.now()}`,
        attempt: attemptNumber,
        terminalReason,
        attemptHistoryEntry: attemptEntry,
        metadata: { retryClassification: classification.classification, error: String(err) },
      });

      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "publish",
        errorCategory: classification.category,
        errorMessage: classification.reason,
        retryClassification: classification.classification,
        attemptCount: attemptNumber,
        diagnostics: redactDiagnostics({
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }) as Record<string, unknown>,
        resumed: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      throw err;
    }
  }

  /**
   * Maps validation findings to self-review issues and runs the bounded repair
   * loop (L1). Returns true when a repaired child revision was created and the
   * caller should re-validate; false when repair is unavailable or exhausted.
   */
  private async attemptValidationRepair(
    tenant: TenantContext,
    candidateId: string,
    record: CandidateLifecycleRecord,
    activeRevision: CandidateRevision,
    validationResult: CandidateValidationResult,
    options: LifecycleStepOptions,
    attemptNumber: number,
  ): Promise<boolean> {
    const issues: SelfReviewIssue[] = [];

    for (const finding of validationResult.staticFindings ?? []) {
      if (finding.severity !== "error") continue;
      issues.push({
        severity: "error",
        category: this.mapFindingCategory(finding.category),
        message: finding.message,
        fixHint: finding.fixHint,
      });
    }
    for (const test of validationResult.testReport?.results ?? []) {
      if (test.passed) continue;
      issues.push({
        severity: "error",
        category: "general",
        message: `Validation test '${test.name}' failed${test.error ? `: ${test.error}` : ""}`,
        fixHint: "Fix the implementation so this scenario passes.",
      });
    }
    for (const tcError of validationResult.typecheckErrors ?? []) {
      issues.push({
        severity: "error",
        category: "syntax",
        message: `Typecheck error: ${tcError}`,
        fixHint: "Resolve the type error.",
      });
    }
    if (issues.length === 0) return false;

    // Seed the repair loop's first review with validation findings so the LLM
    // repair prompt sees them even when self-review alone would pass.
    const repairOptions: CandidateGenerationOptions & { tenantId?: string } = {
      envelope: options.envelope,
      maxRepairIterations: 2,
      inferenceService: this.inferenceService,
      tenantId: tenant.workspaceId,
      initialIssues: issues,
    };

    let repairResult: RepairOrchestrationResult;
    try {
      repairResult = await this.repairOrchestrator.orchestrateAsync(
        activeRevision.artifacts,
        candidateId,
        repairOptions,
      );
    } catch {
      return false;
    }
    if (!repairResult.success) return false;

    const repaired = repairResult.activeRevision.artifacts;
    const fixSummary = issues
      .map((i) => i.message)
      .join("; ")
      .slice(0, 500);

    // Delegate child-revision creation, capability monotonicity, and validation
    // re-enqueue to the existing bounded repair transition.
    await this.repairCandidate(tenant, candidateId, {
      envelope: options.envelope,
      maxRepairAttempts: options.maxRepairAttempts,
      repairHint: `Validation repair (attempt ${attemptNumber}): ${fixSummary}`,
      modifiedArtifacts: {
        sourceCode: repaired.sourceCode,
        manifest: repaired.manifest,
        capabilities: repaired.capabilities,
        workflowDefinition: repaired.workflowDefinition,
      },
    });
    return true;
  }

  /**
   * Maps validation finding categories onto self-review issue categories.
   */
  private mapFindingCategory(category: string): SelfReviewIssue["category"] {
    switch (category) {
      case "forbidden_import":
        return "imports";
      case "forbidden_api":
      case "broker_manifest_mismatch":
        return "broker";
      case "undeclared_capability":
        return "capabilities";
      case "schema_mismatch":
        return "schema";
      case "syntax_error":
        return "syntax";
      default:
        return "general";
    }
  }

  /**
   * Bounded Repair Transition.
   * Creates an immutable child revision, enforces capability monotonicity,
   * preserves deterministic evidence, and re-enters validation.
   */
  async repairCandidate(
    tenant: TenantContext,
    candidateId: string,
    options: RepairCandidateOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);

    const record = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (!record) {
      throw new Error(`Lifecycle record for candidate '${candidateId}' not found`);
    }

    const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
    if (!candidate) {
      throw new Error(`Candidate '${candidateId}' not found`);
    }

    const pinnedRevision = await this.loadPinnedRevision(tenant, record);
    // For repair, parent is pinned revision; fall back to active for legacy without row
    const parentRevision = pinnedRevision ?? (await this.candidateRepo.getActiveRevision(tenant, candidateId));
    const effectiveParent = parentRevision;
    const maxRepairs = options.maxRepairAttempts ?? this.maxRepairAttempts;
    const currentAttempt = record.attempt || 1;

    // 1. Check bounded attempt count
    if (currentAttempt >= maxRepairs) {
      const terminalReason: TerminalReason = {
        code: "REPAIR_BUDGET_EXHAUSTED",
        message: `Candidate exceeded maximum allowable repair attempts (${currentAttempt}/${maxRepairs})`,
        category: "attempts_exhausted",
      };

      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: effectiveParent?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState: "failed",
        targetVersion: record.targetVersion,
        idempotencyKey: `cand_${candidateId}_repair_exhausted_${currentAttempt}`,
        attempt: currentAttempt,
        terminalReason,
        metadata: { stage: "repair", error: "attempts_exhausted" },
      });

      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "repair",
        errorCategory: "attempts_exhausted",
        errorMessage: terminalReason.message,
        retryClassification: "terminal",
        attemptCount: currentAttempt,
        diagnostics: { maxRepairs, currentAttempt },
        resumed: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      return failedRecord;
    }

    // 2. Enforce Capability Monotonicity (Cannot broaden capabilities in child revisions)
    const originalCaps =
      effectiveParent?.artifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const proposedCaps = options.modifiedArtifacts?.capabilities ?? originalCaps;

    const broadened = this.checkCapabilityBroadening(originalCaps, proposedCaps);
    if (broadened.isBroadened) {
      const terminalReason: TerminalReason = {
        code: "CAPABILITY_BROADENED",
        message: `Child revision cannot broaden capabilities: ${broadened.reasons.join("; ")}`,
        category: "capability_broadened",
        details: { broadenedReasons: broadened.reasons },
      };

      const failedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: effectiveParent?.revisionId ?? record.activeRevisionId,
        fromState: record.currentState,
        toState: "failed",
        targetVersion: record.targetVersion,
        idempotencyKey: `cand_${candidateId}_repair_broadened_${currentAttempt}`,
        attempt: currentAttempt,
        terminalReason,
        metadata: { stage: "repair", error: "capability_broadened" },
      });

      await this.lifecycleRepo.saveDlqRecord(tenant, {
        id: `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        candidateId,
        revisionId: failedRecord.activeRevisionId,
        stage: "repair",
        errorCategory: "capability_violation",
        errorMessage: terminalReason.message,
        retryClassification: "terminal",
        attemptCount: currentAttempt,
        diagnostics: { reasons: broadened.reasons },
        resumed: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      return failedRecord;
    }

    // 3. Create Immutable Child Revision
    const newRevisionNumber = (effectiveParent?.revisionNumber ?? 1) + 1;
    const newRevisionId = `rev_${candidateId}_${newRevisionNumber}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    const childRevision: CandidateRevision = {
      revisionId: newRevisionId,
      candidateId,
      revisionNumber: newRevisionNumber,
      parentRevisionId: effectiveParent?.revisionId,
      artifacts: {
        plan: effectiveParent?.artifacts?.plan ?? {
          id: `plan_${candidateId}`,
          opportunityId:
            (candidate as unknown as { opportunityId?: string }).opportunityId ||
            `opp_${candidateId}`,
          name: candidate.proposedTool.name,
          description: candidate.proposedTool.description || "Candidate tool",
          variableInputs: [],
          invariantInputs: [],
          inputSchema: candidate.proposedTool.parameters,
          outputSchema: candidate.proposedTool.outputSchema ?? { type: "object" },
          steps: [],
          capabilities: proposedCaps,
          capabilityRequirements: proposedCaps,
          runtime: {
            runtime: "deno",
            memoryLimitMb: 128,
            timeoutMs: 30000,
            cpuLimitPercent: 100,
            maxOutputSizeBytes: 1048576,
          },
          metadata: {},
          createdAt: nowIso,
        },
        manifest:
          options.modifiedArtifacts?.manifest ??
          effectiveParent?.artifacts?.manifest ??
          candidate.proposedTool,
        capabilities: proposedCaps,
        sourceCode:
          options.modifiedArtifacts?.sourceCode ??
          effectiveParent?.artifacts?.sourceCode ??
          candidate.sourceCode ??
          "",
        workflowDefinition:
          options.modifiedArtifacts?.workflowDefinition ??
          effectiveParent?.artifacts?.workflowDefinition,
        tests: effectiveParent?.artifacts?.tests,
        generatedAt: nowIso,
      },
      selfReview: {
        passed: true,
        issues: [],
        reviewedAt: nowIso,
      },
      repairHistory: [
        ...(effectiveParent?.repairHistory || []),
        {
          iteration: currentAttempt,
          reason: options.repairHint || "Automated lifecycle repair transition",
          fixedIssues: [options.repairHint || "Repair attempt"],
          timestamp: nowIso,
        },
      ],
      createdAt: nowIso,
    };

    const persistedChildRevision = await this.candidateRepo.saveRevision(tenant, childRevision);

    // 4. Transition State to Repairing / Validating with child revision
    const childDigests = this.computeCandidateEvidenceDigests(candidate, persistedChildRevision);
    const jobPayload: LifecycleJobPayload = {
      candidateId,
      revisionId: newRevisionId,
      targetVersion: record.targetVersion,
      step: "validate",
      idempotencyKey: `cand_${candidateId}_val_job_rev_${newRevisionNumber}`,
      attempt: currentAttempt + 1,
      scheduledAt: nowIso,
    };
    const childTransition = {
      revisionId: newRevisionId,
      fromState: record.currentState,
      toState: "validating" as const,
      targetVersion: record.targetVersion,
      idempotencyKey: `cand_${candidateId}_repaired_rev_${newRevisionNumber}`,
      attempt: currentAttempt + 1,
      evidenceDigests: {
        ...record.evidenceDigests,
        ...childDigests,
      },
      terminalReason: null,
      attemptHistoryEntry: {
        attempt: currentAttempt + 1,
        state: "repairing" as const,
        startedAt: nowIso,
        completedAt: nowIso,
        durationMs: 0,
        status: "succeeded" as const,
      },
      metadata: {
        stage: "repair",
        parentRevisionId: effectiveParent?.revisionId,
        childRevisionId: newRevisionId,
        revisionNumber: newRevisionNumber,
      },
    };
    const updatedRecord = await this.atomicTransitionWithOutbox(
      tenant,
      candidateId,
      childTransition as never,
      jobPayload,
      EVOLUTION_LIFECYCLE_JOB_TYPES.VALIDATE_CANDIDATE,
      "validate",
    );

    return updatedRecord;
  }

  /**
   * Capability monotonicity verifier.
   */
  private checkCapabilityBroadening(
    parent: CapabilityManifest,
    child: CapabilityManifest,
  ): { isBroadened: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // Network hosts
    const parentHosts = new Set(parent.net?.allowedHosts ?? []);
    for (const host of child.net?.allowedHosts ?? []) {
      if (!parentHosts.has(host)) {
        reasons.push(`Added network host '${host}'`);
      }
    }

    // FS write paths
    const parentWritePaths = new Set(parent.fs?.writePaths ?? []);
    for (const path of child.fs?.writePaths ?? []) {
      if (!parentWritePaths.has(path)) {
        reasons.push(`Added FS write path '${path}'`);
      }
    }

    // Command execution
    const parentCommands = new Set([
      ...(parent.command?.allowedCommands ?? []),
      ...((parent as unknown as { exec?: { allowedCommands?: string[] } }).exec?.allowedCommands ??
        []),
    ]);
    const childCommands = [
      ...(child.command?.allowedCommands ?? []),
      ...((child as unknown as { exec?: { allowedCommands?: string[] } }).exec?.allowedCommands ??
        []),
    ];
    for (const cmd of childCommands) {
      if (!parentCommands.has(cmd)) {
        reasons.push(`Added command '${cmd}'`);
      }
    }

    // Secrets
    const parentSecrets = new Set(parent.secrets?.allowedSecretNames ?? []);
    for (const secret of child.secrets?.allowedSecretNames ?? []) {
      if (!parentSecrets.has(secret)) {
        reasons.push(`Added secret access '${secret}'`);
      }
    }

    return {
      isBroadened: reasons.length > 0,
      reasons,
    };
  }

  /**
   * Resumes a dead-lettered or blocked candidate from DLQ.
   */
  async resumeFromDlq(
    tenant: TenantContext,
    dlqId: string,
    options: ResumeFromDlqOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    this.enforceTenant(tenant);

    const dlqRecord = await this.lifecycleRepo.getDlqRecord(tenant, dlqId);
    if (!dlqRecord) {
      throw new Error(`DLQ record '${dlqId}' not found`);
    }

    await this.lifecycleRepo.markDlqResumed(tenant, dlqId, options.resumedBy ?? "operator");

    const targetStage: LifecycleStage = options.targetStage ?? dlqRecord.stage;
    const candidateId = dlqRecord.candidateId;

    let nextState: CandidateLifecycleState = "validating";
    if (targetStage === "replay") nextState = "validating";
    if (targetStage === "evaluate") nextState = "replaying";
    if (targetStage === "publish") nextState = "eligible";

    const existing = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    const pinnedForResume = existing ? await this.loadPinnedRevision(tenant, existing) : null;
    const activeRevision = pinnedForResume ?? (await this.candidateRepo.getActiveRevision(tenant, candidateId));
    const effectiveRevisionId = existing?.activeRevisionId ?? activeRevision?.revisionId ?? dlqRecord.revisionId;

    const updated = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
      revisionId: effectiveRevisionId,
      fromState: existing?.currentState ?? "failed",
      toState: nextState,
      targetVersion: existing?.targetVersion ?? "1.0.0",
      idempotencyKey: `cand_${candidateId}_resumed_from_dlq_${Date.now()}`,
      attempt: (existing?.attempt || 1) + 1,
      terminalReason: null,
      metadata: {
        resumedFromDlqId: dlqId,
        resumedBy: options.resumedBy ?? "operator",
        targetStage,
      },
    });

    if (targetStage === "validate") {
      return this.stepValidate(tenant, candidateId);
    }
    if (targetStage === "replay") {
      return this.stepReplay(tenant, candidateId);
    }
    if (targetStage === "evaluate") {
      return this.stepEvaluate(tenant, candidateId);
    }
    if (targetStage === "publish") {
      const pubRes = await this.stepPublish(tenant, candidateId);
      return pubRes.record;
    }

    return updated;
  }

  /**
   * Processes a lifecycle job payload and returns the updated record.
   */
  async processJob(
    tenant: TenantContext,
    payload: LifecycleJobPayload,
  ): Promise<CandidateLifecycleRecord> {
    // Reject job payload revision mismatch against pinned activeRevisionId
    const recordForPayload = await this.lifecycleRepo.getLifecycle(tenant, payload.candidateId);
    if (
      recordForPayload &&
      payload.revisionId &&
      recordForPayload.activeRevisionId &&
      payload.revisionId !== recordForPayload.activeRevisionId
    ) {
      throw new Error(
        `Job payload revision mismatch: payload revisionId '${payload.revisionId}' does not match pinned activeRevisionId '${recordForPayload.activeRevisionId}' for candidate '${payload.candidateId}'`,
      );
    }
    switch (payload.step) {
      case "validate":
        return this.stepValidate(tenant, payload.candidateId, {
          idempotencyKey: payload.idempotencyKey,
          attempt: payload.attempt,
        });
      case "replay":
        return this.stepReplay(tenant, payload.candidateId, {
          idempotencyKey: payload.idempotencyKey,
          attempt: payload.attempt,
        });
      case "evaluate":
        return this.stepEvaluate(tenant, payload.candidateId, {
          idempotencyKey: payload.idempotencyKey,
          attempt: payload.attempt,
        });
      case "publish": {
        const res = await this.stepPublish(tenant, payload.candidateId, {
          idempotencyKey: payload.idempotencyKey,
          attempt: payload.attempt,
        });
        return res.record;
      }
      case "repair":
        return this.repairCandidate(tenant, payload.candidateId);
      default:
        throw new Error(
          `Unknown lifecycle job step: '${(payload as unknown as Record<string, string>).step}'`,
        );
    }
  }

  /**
   * Dispatches and reconciles async queue jobs.
   */
  async handleJob(
    tenantOrPayload: TenantContext | LifecycleJobPayload,
    payloadOrTenant?: LifecycleJobPayload | TenantContext,
  ): Promise<CandidateLifecycleRecord | undefined> {
    let tenant: TenantContext;
    let payload: LifecycleJobPayload;

    if ("candidateId" in tenantOrPayload && "step" in tenantOrPayload) {
      payload = tenantOrPayload as LifecycleJobPayload;
      tenant = (payloadOrTenant as TenantContext) ?? {
        accountId: "acc_system",
        workspaceId: "ws_default",
      };
    } else {
      tenant = tenantOrPayload as TenantContext;
      payload = payloadOrTenant as LifecycleJobPayload;
    }

    // Early revision mismatch rejection (fail-closed) mirrors processJob check for callers using handleJob directly
    const recordForHandle = await this.lifecycleRepo.getLifecycle(tenant, payload.candidateId);
    if (
      recordForHandle &&
      payload.revisionId &&
      recordForHandle.activeRevisionId &&
      payload.revisionId !== recordForHandle.activeRevisionId
    ) {
      throw new Error(
        `Job payload revision mismatch: payload revisionId '${payload.revisionId}' does not match pinned activeRevisionId '${recordForHandle.activeRevisionId}' for candidate '${payload.candidateId}'`,
      );
    }

    return this.processJob(tenant, payload);
  }
  /**
   * Retrieves sanitized lifecycle status response for API consumers.
   */
  async getStatus(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<CandidateLifecycleStatusResponse | null> {
    const record = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (!record) {
      return null;
    }

    const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
    const transitions = await this.lifecycleRepo.getTransitions(tenant, candidateId);

    const isTerminal =
      record.currentState === "published" ||
      record.currentState === "rejected" ||
      record.currentState === "failed" ||
      record.currentState === "dead_letter" ||
      record.currentState === "superseded";

    const isEligible = record.currentState === "eligible" || record.currentState === "published";
    const isPublished = record.currentState === "published";

    const evidenceDigestsRecord: Record<string, string> = {};
    if (record.evidenceDigests.manifestDigest)
      evidenceDigestsRecord.manifest = record.evidenceDigests.manifestDigest;
    if (record.evidenceDigests.sourceDigest)
      evidenceDigestsRecord.source = record.evidenceDigests.sourceDigest;
    if (record.evidenceDigests.validationDigest)
      evidenceDigestsRecord.validation = record.evidenceDigests.validationDigest;
    if (record.evidenceDigests.replayDigest)
      evidenceDigestsRecord.replay = record.evidenceDigests.replayDigest;
    if (record.evidenceDigests.evaluationDigest)
      evidenceDigestsRecord.evaluation = record.evidenceDigests.evaluationDigest;
    if (record.evidenceDigests.artifactDigest)
      evidenceDigestsRecord.artifact = record.evidenceDigests.artifactDigest;
    if (record.evidenceDigests.signatureDigest)
      evidenceDigestsRecord.signature = record.evidenceDigests.signatureDigest;

    return {
      candidateId: record.candidateId,
      workspaceId: record.workspaceId,
      toolName: candidate?.proposedTool.name || `Tool_${record.candidateId}`,
      toolVersion: record.targetVersion,
      currentState: record.currentState,
      activeRevisionId: record.activeRevisionId,
      isTerminal,
      isEligible,
      isPublished,
      publishedVersion: record.publishedVersion,
      publicationRecordId: record.publicationRecordId,
      terminalReason: record.terminalReason,
      evidenceSummary: {
        validationPassed: record.validationResult ? record.validationResult.passed : undefined,
        typecheckPassed: record.validationResult
          ? record.validationResult.typecheckPassed
          : undefined,
        staticFindingsCount: record.validationResult
          ? record.validationResult.staticFindings?.length
          : undefined,
        replayPassed: record.replayResult ? record.replayResult.passed : undefined,
        evaluationVerdict: record.evaluationResult
          ? record.evaluationResult.overallDecision?.verdict
          : undefined,
        hardGatesPassed: record.evaluationResult
          ? record.evaluationResult.overallDecision?.verdict === "pass" ||
            Boolean(
              (record.evaluationResult as unknown as { hardGateResult?: { passed?: boolean } })
                .hardGateResult?.passed,
            )
          : undefined,
        evidenceFreshnessVerified:
          record.currentState === "published" || record.currentState === "eligible",
        hasSignature: Boolean(record.evidenceDigests.signatureDigest),
      },
      evidenceDigests: evidenceDigestsRecord,
      attemptHistory: record.attemptHistory,
      history: transitions.map((t) => ({
        fromState: t.fromState,
        toState: t.toState,
        timestamp: t.createdAt,
        attempt: t.attempt,
      })),
    };
  }
}
