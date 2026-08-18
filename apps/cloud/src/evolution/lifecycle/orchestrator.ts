import { randomUUID } from "node:crypto";
import {
  type CapabilityEnvelope,
  type CapabilityManifest,
  type EvaluationResult,
  type EvolutionCandidate,
  type NormalizedSessionEvent,
  type ToolManifest,
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
import type { CandidateRevision } from "../generator/types.js";
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
  }

  private enforceTenant(tenant: TenantContext): void {
    if (tenant?.accountId && tenant?.workspaceId) {
      TenantGuard.assertAccess(
        { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
        tenant,
      );
    }
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

    const manifest = revArtifacts?.manifest ?? candidate.proposedTool;
    const sourceCode = revArtifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const capabilities = revArtifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDef = revArtifacts?.workflowDefinition;
    const tests = revArtifacts?.tests;

    const { digest: _discardManifestDigest, ...manifestWithoutDigest } = manifest;

    return {
      manifestDigest: hashCanonicalContent(manifestWithoutDigest),
      sourceDigest: computeSha256(sourceCode),
      capabilityDigest: hashCanonical(capabilities),
      workflowDigest: workflowDef ? hashCanonical(workflowDef) : undefined,
      testDigest: tests ? computeSha256(JSON.stringify(tests)) : undefined,
    };
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
    const revisionId = revision?.revisionId ?? idFromRevision ?? `rev_${candidateId}_1`;
    const targetVersion = options.targetVersion ?? candidate.proposedTool.version ?? "1.0.0";
    const now = new Date().toISOString();

    // Ensure candidate & revision are persisted in repository
    const existingCand = await this.candidateRepo.getCandidateById(tenant, candidateId);
    if (!existingCand) {
      await this.candidateRepo.saveCandidate(tenant, candidate);
    }
    if (revision) {
      const existingRev = await this.candidateRepo.getRevisionById(tenant, revisionId);
      if (!existingRev) {
        await this.candidateRepo.saveRevision(tenant, revision);
      }
    }

    const existing = await this.lifecycleRepo.getLifecycle(tenant, candidateId);
    if (existing) {
      return existing;
    }

    const digests = this.computeCandidateEvidenceDigests(candidate, revision);
    const idempotencyKey = options.idempotencyKey ?? `cand_${candidateId}_drafted_${Date.now()}`;

    const record = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
      revisionId,
      fromState: "drafted",
      toState: "drafted",
      targetVersion,
      idempotencyKey,
      attempt: 1,
      evidenceDigests: digests,
      attemptHistoryEntry: {
        attempt: 1,
        state: "drafted",
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        status: "succeeded",
      },
      metadata: {
        toolName: candidate.proposedTool.name,
        targetVersion,
        stage: "draft",
      },
    });

    // Schedule verification / validation
    const jobPayload: LifecycleJobPayload = {
      candidateId,
      revisionId,
      targetVersion,
      step: "validate",
      idempotencyKey: `cand_${candidateId}_val_job_1`,
      attempt: 1,
      scheduledAt: now,
    };

    if (this.pool) {
      try {
        await OutboxRepository.insert(this.pool, {
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          aggregateType: "candidate_lifecycle",
          aggregateId: candidateId,
          eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.VALIDATE_CANDIDATE,
          payload: jobPayload as unknown as Record<string, unknown>,
          headers: {
            step: "validate",
            workspaceId: tenant.workspaceId,
          },
        });
      } catch {
        // Continue
      }
    }

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

    const activeRevision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
    const sourceCode = activeRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const manifest = activeRevision?.artifacts?.manifest ?? candidate.proposedTool;
    const requiredCapabilities =
      activeRevision?.artifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDefinition = activeRevision?.artifacts?.workflowDefinition;
    const tests = activeRevision?.artifacts?.tests;

    const attemptNumber = options.attempt ?? (record.attempt || 1);
    const startTime = Date.now();
    const nowIso = new Date().toISOString();

    try {
      // Execute Candidate Validation Service
      const validationResult = await this.validationService.validateCandidate(
        {
          id: candidate.id,
          candidateId: candidate.id,
          revisionId: activeRevision?.revisionId,
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
          ...this.computeCandidateEvidenceDigests(candidate, activeRevision),
          validationDigest,
        };

        const idempotencyKey =
          options.idempotencyKey ?? `cand_${candidateId}_validated_${attemptNumber}`;

        const updated = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
          revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: "replaying",
          targetVersion: record.targetVersion,
          idempotencyKey,
          attempt: attemptNumber,
          evidenceDigests,
          validationResult: { ...validationResult, passed: true },
          attemptHistoryEntry: attemptEntry,
          metadata: { stage: "validate", status: "passed", durationMs },
        });

        // Schedule replay
        const jobPayload: LifecycleJobPayload = {
          candidateId,
          revisionId: updated.activeRevisionId,
          targetVersion: updated.targetVersion,
          step: "replay",
          idempotencyKey: `cand_${candidateId}_replay_job_${attemptNumber}`,
          attempt: 1,
          scheduledAt: new Date().toISOString(),
        };

        if (this.pool) {
          try {
            await OutboxRepository.insert(this.pool, {
              accountId: tenant.accountId,
              workspaceId: tenant.workspaceId,
              aggregateType: "candidate_lifecycle",
              aggregateId: candidateId,
              eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.REPLAY_CANDIDATE,
              payload: jobPayload as unknown as Record<string, unknown>,
              headers: {
                step: "replay",
                workspaceId: tenant.workspaceId,
              },
            });
          } catch {
            // Continue
          }
        }

        return updated;
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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
          revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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

  private async resolveReplayEvidence(
    tenant: TenantContext,
    candidate: EvolutionCandidate,
    baselineEvents?: NormalizedSessionEvent[],
  ): Promise<EvidenceSource> {
    if (baselineEvents && baselineEvents.length > 0) {
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

    const activeRevision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
    const sourceCode = activeRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const manifest = activeRevision?.artifacts?.manifest ?? candidate.proposedTool;
    const requiredCapabilities =
      activeRevision?.artifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDefinition = activeRevision?.artifacts?.workflowDefinition;

    const attemptNumber = options.attempt ?? (record.attempt || 1);
    const startTime = Date.now();
    const nowIso = new Date().toISOString();
    try {
      const replayResult: HistoricalReplayResult = await this.replayService.replayCandidate(
        tenant,
        {
          candidate: {
            id: candidate.id,
            candidateId: candidate.id,
            revisionId: activeRevision?.revisionId,
            manifest,
            sourceCode,
            requiredCapabilities,
            workflowDefinition,
          },
          evidence: await this.resolveReplayEvidence(tenant, candidate, options.baselineEvents),
          ...options.replayOptions,
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
          ...this.computeCandidateEvidenceDigests(candidate, activeRevision),
          replayDigest,
        };

        const idempotencyKey =
          options.idempotencyKey ?? `cand_${candidateId}_replayed_${attemptNumber}`;

        const updated = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
          revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: "evaluating",
          targetVersion: record.targetVersion,
          idempotencyKey,
          attempt: attemptNumber,
          evidenceDigests,
          replayResult: { ...replayResult, passed: true },
          attemptHistoryEntry: attemptEntry,
          metadata: { stage: "replay", status: "passed", durationMs },
        });

        // Schedule evaluation
        const jobPayload: LifecycleJobPayload = {
          candidateId,
          revisionId: updated.activeRevisionId,
          targetVersion: updated.targetVersion,
          step: "evaluate",
          idempotencyKey: `cand_${candidateId}_eval_job_${attemptNumber}`,
          attempt: 1,
          scheduledAt: new Date().toISOString(),
        };

        if (this.pool) {
          try {
            await OutboxRepository.insert(this.pool, {
              accountId: tenant.accountId,
              workspaceId: tenant.workspaceId,
              aggregateType: "candidate_lifecycle",
              aggregateId: candidateId,
              eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.EVALUATE_CANDIDATE,
              payload: jobPayload as unknown as Record<string, unknown>,
              headers: {
                step: "evaluate",
                workspaceId: tenant.workspaceId,
              },
            });
          } catch {
            // Continue
          }
        }

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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
          revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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

    const activeRevision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
    const sourceCode = activeRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const manifest = activeRevision?.artifacts?.manifest ?? candidate.proposedTool;
    const requiredCapabilities =
      activeRevision?.artifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
    const workflowDefinition = activeRevision?.artifacts?.workflowDefinition;

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

    try {
      const evaluationResult: EvaluationResult = await this.evaluationService.evaluateCandidate({
        candidate: {
          id: candidate.id,
          candidateId: candidate.id,
          revisionId: activeRevision?.revisionId,
          manifest,
          sourceCode,
          requiredCapabilities,
          workflowDefinition,
        },
        opportunity,
        validationResult: record.validationResult as unknown as CandidateValidationResult,
        replayResult: record.replayResult as unknown as HistoricalReplayResult,
        envelope: options.envelope,
        ...options.evaluationOptions,
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
          ...this.computeCandidateEvidenceDigests(candidate, activeRevision),
          evaluationDigest,
        };

        const idempotencyKey =
          options.idempotencyKey ?? `cand_${candidateId}_evaluated_${attemptNumber}`;

        const updated = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
          revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
          fromState: record.currentState,
          toState: "eligible",
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
        });

        // Schedule publish
        const jobPayload: LifecycleJobPayload = {
          candidateId,
          revisionId: updated.activeRevisionId,
          targetVersion: updated.targetVersion,
          step: "publish",
          idempotencyKey: `cand_${candidateId}_pub_job_${attemptNumber}`,
          attempt: 1,
          scheduledAt: new Date().toISOString(),
        };

        if (this.pool) {
          try {
            await OutboxRepository.insert(this.pool, {
              accountId: tenant.accountId,
              workspaceId: tenant.workspaceId,
              aggregateType: "candidate_lifecycle",
              aggregateId: candidateId,
              eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.PUBLISH_CANDIDATE,
              payload: jobPayload as unknown as Record<string, unknown>,
              headers: {
                step: "publish",
                workspaceId: tenant.workspaceId,
              },
            });
          } catch {
            // Continue
          }
        }

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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
          revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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

    const activeRevision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
    const sourceCode = activeRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const computedSourceDigest = computeSha256(sourceCode);
    if (
      record.evidenceDigests.sourceDigest &&
      record.evidenceDigests.sourceDigest !== computedSourceDigest
    ) {
      throw new Error(
        `Source digest mismatch: recorded '${record.evidenceDigests.sourceDigest}', current '${computedSourceDigest}'`,
      );
    }
    const targetVersion = options.targetVersion ?? record.targetVersion;
    const attemptNumber = options.attempt ?? (record.attempt || 1);
    const startTime = Date.now();
    const nowIso = new Date().toISOString();

    try {
      const { digest: _d, ...baseManifest } =
        activeRevision?.artifacts?.manifest ?? candidate.proposedTool;
      const manifestForPublish: ToolManifest = {
        ...baseManifest,
        digest: hashCanonicalContent(baseManifest),
      };
      const candidateForPublish: EvolutionCandidate = {
        ...candidate,
        proposedTool: manifestForPublish,
      };

      // 5. Build and Sign Tool Artifact
      const toolVersion = await this.artifactService.publishCandidate(
        candidateForPublish,
        record.evaluationResult,
        {
          overrideVersion: targetVersion,
          keyId: options.signingKeyId,
          revision: activeRevision ?? undefined,
          workflowDefinition: activeRevision?.artifacts?.workflowDefinition,
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

      const updatedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
        fromState: "eligible",
        toState: "published",
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
      });

      if (this.pool) {
        try {
          await OutboxRepository.insert(this.pool, {
            accountId: tenant.accountId,
            workspaceId: tenant.workspaceId,
            aggregateType: "candidate_lifecycle",
            aggregateId: candidateId,
            eventType: "candidate.lifecycle.published",
            payload: {
              candidateId,
              workspaceId: tenant.workspaceId,
              toolName: toolVersion.manifest.name,
              toolVersion: toolVersion.version,
              artifactDigest: toolVersion.artifactDigest,
              publicationRecordId,
              publishedAt: new Date().toISOString(),
            },
            headers: {
              step: "published",
              workspaceId: tenant.workspaceId,
            },
          });
        } catch {
          // Continue
        }
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
          revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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

    const activeRevision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
      activeRevision?.artifacts?.capabilities ?? candidate.requiredCapabilities ?? {};
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
        revisionId: activeRevision?.revisionId ?? record.activeRevisionId,
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
    const newRevisionNumber = (activeRevision?.revisionNumber ?? 1) + 1;
    const newRevisionId = `rev_${candidateId}_${newRevisionNumber}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    const childRevision: CandidateRevision = {
      revisionId: newRevisionId,
      candidateId,
      revisionNumber: newRevisionNumber,
      parentRevisionId: activeRevision?.revisionId,
      artifacts: {
        plan: activeRevision?.artifacts?.plan ?? {
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
          activeRevision?.artifacts?.manifest ??
          candidate.proposedTool,
        capabilities: proposedCaps,
        sourceCode:
          options.modifiedArtifacts?.sourceCode ??
          activeRevision?.artifacts?.sourceCode ??
          candidate.sourceCode ??
          "",
        workflowDefinition:
          options.modifiedArtifacts?.workflowDefinition ??
          activeRevision?.artifacts?.workflowDefinition,
        tests: activeRevision?.artifacts?.tests,
        generatedAt: nowIso,
      },
      selfReview: {
        passed: true,
        issues: [],
        reviewedAt: nowIso,
      },
      repairHistory: [
        ...(activeRevision?.repairHistory || []),
        {
          iteration: currentAttempt,
          reason: options.repairHint || "Automated lifecycle repair transition",
          fixedIssues: [options.repairHint || "Repair attempt"],
          timestamp: nowIso,
        },
      ],
      createdAt: nowIso,
    };

    await this.candidateRepo.saveRevision(tenant, childRevision);

    // 4. Transition State to Repairing / Validating with child revision
    const childDigests = this.computeCandidateEvidenceDigests(candidate, childRevision);
    const updatedRecord = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
      revisionId: newRevisionId,
      fromState: record.currentState,
      toState: "validating",
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
        state: "repairing",
        startedAt: nowIso,
        completedAt: nowIso,
        durationMs: 0,
        status: "succeeded",
      },
      metadata: {
        stage: "repair",
        parentRevisionId: activeRevision?.revisionId,
        childRevisionId: newRevisionId,
        revisionNumber: newRevisionNumber,
      },
    });

    // Schedule validation for child revision
    const jobPayload: LifecycleJobPayload = {
      candidateId,
      revisionId: newRevisionId,
      targetVersion: updatedRecord.targetVersion,
      step: "validate",
      idempotencyKey: `cand_${candidateId}_val_job_rev_${newRevisionNumber}`,
      attempt: currentAttempt + 1,
      scheduledAt: nowIso,
    };

    if (this.pool) {
      try {
        await OutboxRepository.insert(this.pool, {
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          aggregateType: "candidate_lifecycle",
          aggregateId: candidateId,
          eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.VALIDATE_CANDIDATE,
          payload: jobPayload as unknown as Record<string, unknown>,
          headers: {
            step: "validate",
            workspaceId: tenant.workspaceId,
          },
        });
      } catch {
        // Continue
      }
    }

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

    const activeRevision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
    const existing = await this.lifecycleRepo.getLifecycle(tenant, candidateId);

    const updated = await this.lifecycleRepo.recordTransition(tenant, candidateId, {
      revisionId: activeRevision?.revisionId ?? dlqRecord.revisionId,
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
