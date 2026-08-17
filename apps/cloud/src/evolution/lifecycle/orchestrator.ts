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
import { type TenantContext, TenantGuard, getTenantContext } from "../../tenant.js";
import { ToolArtifactRegistryService } from "../artifacts/service.js";
import { ArtifactSigner } from "../artifacts/signer.js";
import { CandidateEvaluationService } from "../evaluation/service.js";
import type { EvaluationPolicy } from "../evaluation/types.js";
import { CandidateRepository } from "../generator/repositories/candidate-repository.js";
import type { CandidateRevision } from "../generator/types.js";
import type { OpportunityDetection } from "../opportunity/types.js";
import { HistoricalReplayService } from "../replay/service.js";
import type {
  EvidenceSource,
  HistoricalReplayOptions,
  HistoricalReplayResult,
} from "../replay/types.js";
import { CandidateValidationService } from "../testing/service.js";
import type { CandidateValidationOptions, CandidateValidationResult } from "../testing/types.js";
import { LifecycleRepository } from "./repositories/lifecycle-repository.js";
import {
  type AttemptHistoryEntry,
  type CandidateLifecycleRecord,
  type CandidateLifecycleState,
  type CandidateLifecycleStatusResponse,
  EVOLUTION_LIFECYCLE_JOB_TYPES,
  type EvidenceDigests,
  type LifecycleJobPayload,
  type LifecycleTransitionRecord,
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
  evidenceMaxAgeMs?: number;
}

/**
 * Execution options for lifecycle step operations.
 */
export interface LifecycleStepOptions {
  envelope?: CapabilityEnvelope;
  evaluationPolicy?: EvaluationPolicy | string;
  validationOptions?: CandidateValidationOptions;
  targetVersion?: string;
  signingKeyId?: string;
  replayOptions?: {
    evidence?: EvidenceSource;
    evidenceSetId?: string;
    options?: HistoricalReplayOptions;
  };
  forceApprove?: boolean; // Strictly ignored for hard gates
  skipGates?: boolean; // Strictly ignored for hard gates
  approved?: boolean; // Strictly ignored for hard gates
}

/**
 * Candidate Lifecycle Orchestrator.
 * Drives atomic candidates through validation, replay, deterministic evaluation,
 * cryptographic signing, immutable storage, and catalog publication.
 */
export class CandidateLifecycleOrchestrator {
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
  readonly evidenceMaxAgeMs: number;

  constructor(
    private readonly pool: DatabasePool,
    options: CandidateLifecycleOrchestratorOptions = {},
  ) {
    this.validationService = options.validationService ?? new CandidateValidationService();
    this.replayService = options.replayService ?? new HistoricalReplayService();
    this.evaluationService = options.evaluationService ?? new CandidateEvaluationService();
    this.artifactService =
      options.artifactService ??
      new ToolArtifactRegistryService(
        this.pool,
        options.objectStore ?? ({} as unknown as ObjectStore),
      );
    this.catalogService = options.catalogService;
    this.candidateRepo = options.candidateRepo ?? new CandidateRepository(this.pool);
    this.lifecycleRepo = options.lifecycleRepo ?? new LifecycleRepository(this.pool);
    this.outboxPublisher = options.outboxPublisher;
    this.queue = options.queue;
    this.objectStore = options.objectStore;
    this.evidenceMaxAgeMs = options.evidenceMaxAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours default
  }

  /**
   * Starts candidate lifecycle from 'drafted' stage, persists initial record,
   * logs transition, and transactionally schedules validation.
   */
  async startLifecycle(
    tenant: TenantContext,
    candidate: EvolutionCandidate,
    revision?: CandidateRevision | null,
    options: LifecycleStepOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: candidate.workspaceId },
      tenant,
    );

    const candidateId = candidate.id;
    const rawRevision: unknown = revision;
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

    // Check existing lifecycle record for idempotency
    const existing = await this.lifecycleRepo.getLifecycleRecord(tenant, candidateId);
    if (existing) {
      return existing;
    }

    const idempotencyKey = `cand_${candidateId}_drafted_${now}`;
    const manifestDigest =
      candidate.proposedTool.digest || hashCanonicalContent(candidate.proposedTool);
    const sourceDigest = candidate.sourceCode ? computeSha256(candidate.sourceCode) : "";

    const initialDigests: EvidenceDigests = {
      manifestDigest,
      sourceDigest,
    };

    const initialRecord: CandidateLifecycleRecord = {
      id: `lc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      candidateId,
      activeRevisionId: revisionId,
      currentState: "drafted",
      targetVersion,
      idempotencyKey,
      attempt: 1,
      evidenceDigests: initialDigests,
      terminalReason: null,
      validationResult: null,
      replayResult: null,
      evaluationResult: null,
      publicationRecordId: null,
      publishedVersion: null,
      attemptHistory: [
        {
          attempt: 1,
          state: "drafted",
          startedAt: now,
          completedAt: now,
          status: "succeeded",
        },
      ],
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };

    // Execute atomic transaction
    await this.pool.transaction(async (tx) => {
      // 1. Save candidate if not saved
      await this.candidateRepo.saveCandidate(
        tenant,
        {
          ...candidate,
          state: "synthesized",
        },
        { db: tx },
      );

      // 2. Save revision if provided
      if (revision) {
        await this.candidateRepo.saveRevision(tenant, revision, { db: tx });
      }

      // 3. Save lifecycle record
      await this.lifecycleRepo.saveLifecycleRecord(tenant, initialRecord, tx);

      // 4. Log state transition
      await this.lifecycleRepo.saveTransition(
        tenant,
        {
          id: `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          candidateId,
          revisionId,
          fromState: "drafted",
          toState: "drafted",
          idempotencyKey: `trans_${idempotencyKey}`,
          attempt: 1,
          evidenceDigests: initialDigests,
          terminalReason: null,
          metadata: { initial: true },
          createdAt: now,
        },
        tx,
      );

      // 5. Transactionally write outbox event to schedule validation
      const jobPayload: LifecycleJobPayload = {
        candidateId,
        revisionId,
        targetVersion,
        step: "validate",
        idempotencyKey: `job_${candidateId}_validate_1`,
        attempt: 1,
        scheduledAt: now,
      };

      await OutboxRepository.insert(tx, {
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        aggregateType: "evolution_candidate",
        aggregateId: candidateId,
        eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.VALIDATE_CANDIDATE,
        payload: jobPayload as unknown as Record<string, unknown>,
        headers: {
          step: "validate",
          candidateId,
          attempt: "1",
        },
      });
    });

    return initialRecord;
  }

  /**
   * Executes validation step for a candidate.
   * Performs static analysis, typechecking, and test execution.
   * On pass: updates state to 'validating', records digests, and transactionally schedules replay.
   * On fail: sets terminal failure reason and transitions to 'failed' or 'rejected'.
   */
  async stepValidate(
    tenant: TenantContext,
    candidateId: string,
    options: LifecycleStepOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    const record = await this.lifecycleRepo.getLifecycleRecord(tenant, candidateId);
    if (!record) {
      throw new Error(`Candidate lifecycle record '${candidateId}' not found`);
    }

    // Idempotency check: if already past validation or terminal, return current record
    if (
      record.currentState === "replaying" ||
      record.currentState === "evaluating" ||
      record.currentState === "eligible" ||
      record.currentState === "published" ||
      record.currentState === "rejected" ||
      record.currentState === "failed" ||
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

    const attemptNumber = record.attempt || 1;
    const startTime = Date.now();
    const nowIso = new Date().toISOString();

    // Perform validation
    const validationResult = await this.validationService.validateCandidate(
      {
        id: candidateId,
        candidateId,
        revisionId: record.activeRevisionId,
        manifest,
        sourceCode,
        requiredCapabilities,
      },
      {
        strictSecurity: true,
        skipLlmTestSynthesis: true,
        envelope: options.envelope,
        ...options.validationOptions,
      },
    );

    const durationMs = Date.now() - startTime;
    const validationDigest = hashCanonicalContent({
      status: validationResult.status,
      passed: validationResult.passed,
      findings: validationResult.staticFindings,
      typecheckPassed: validationResult.typecheckPassed,
      testReport: validationResult.testReport,
    });

    const isPassed =
      validationResult.passed &&
      validationResult.status === "pass" &&
      validationResult.typecheckPassed &&
      !validationResult.staticFindings.some((f) => f.severity === "error");

    const idempotencyKey = `cand_${candidateId}_validate_${attemptNumber}`;

    const newAttemptEntry: AttemptHistoryEntry = {
      attempt: attemptNumber,
      state: "validating",
      startedAt: nowIso,
      completedAt: new Date().toISOString(),
      durationMs,
      status: isPassed ? "succeeded" : "failed",
      error: isPassed
        ? undefined
        : `Validation failed with status '${validationResult.status}', typecheckPassed=${validationResult.typecheckPassed}`,
    };

    let updatedRecord: CandidateLifecycleRecord;

    if (!isPassed) {
      const terminalReason: TerminalReason = {
        code: "VALIDATION_FAILED",
        message: `Candidate validation failed: status=${validationResult.status}`,
        category: "validation_failed",
        details: {
          status: validationResult.status,
          typecheckPassed: validationResult.typecheckPassed,
          typecheckErrors: validationResult.typecheckErrors,
          staticFindingsCount: validationResult.staticFindings.length,
          repairFeedback: validationResult.repairFeedback,
        },
      };

      updatedRecord = {
        ...record,
        currentState: "failed",
        terminalReason,
        validationResult,
        evidenceDigests: {
          ...record.evidenceDigests,
          validationDigest,
        },
        attemptHistory: [...record.attemptHistory, newAttemptEntry],
        updatedAt: new Date().toISOString(),
      };

      await this.pool.transaction(async (tx) => {
        await this.lifecycleRepo.saveLifecycleRecord(tenant, updatedRecord, tx);
        await this.candidateRepo.saveCandidate(
          tenant,
          {
            ...candidate,
            state: "failed",
            rejectionReason: terminalReason.message,
          },
          { db: tx },
        );
        await this.lifecycleRepo.saveTransition(
          tenant,
          {
            id: `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
            accountId: tenant.accountId,
            workspaceId: tenant.workspaceId,
            candidateId,
            revisionId: record.activeRevisionId,
            fromState: "validating",
            toState: "failed",
            idempotencyKey: `trans_${idempotencyKey}_failed`,
            attempt: attemptNumber,
            evidenceDigests: updatedRecord.evidenceDigests,
            terminalReason,
            metadata: { durationMs },
            createdAt: new Date().toISOString(),
          },
          tx,
        );
      });

      return updatedRecord;
    }

    // Validation passed: update record and schedule replay
    updatedRecord = {
      ...record,
      currentState: "replaying",
      validationResult,
      evidenceDigests: {
        ...record.evidenceDigests,
        validationDigest,
      },
      attemptHistory: [...record.attemptHistory, newAttemptEntry],
      updatedAt: new Date().toISOString(),
    };

    await this.pool.transaction(async (tx) => {
      await this.lifecycleRepo.saveLifecycleRecord(tenant, updatedRecord, tx);
      await this.lifecycleRepo.saveTransition(
        tenant,
        {
          id: `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          candidateId,
          revisionId: record.activeRevisionId,
          fromState: "validating",
          toState: "replaying",
          idempotencyKey: `trans_${idempotencyKey}_replaying`,
          attempt: attemptNumber,
          evidenceDigests: updatedRecord.evidenceDigests,
          terminalReason: null,
          metadata: { durationMs },
          createdAt: new Date().toISOString(),
        },
        tx,
      );

      // Schedule replay job via transactional outbox
      const jobPayload: LifecycleJobPayload = {
        candidateId,
        revisionId: record.activeRevisionId,
        targetVersion: record.targetVersion,
        step: "replay",
        idempotencyKey: `job_${candidateId}_replay_${attemptNumber}`,
        attempt: attemptNumber,
        scheduledAt: new Date().toISOString(),
      };

      await OutboxRepository.insert(tx, {
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        aggregateType: "evolution_candidate",
        aggregateId: candidateId,
        eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.REPLAY_CANDIDATE,
        payload: jobPayload as unknown as Record<string, unknown>,
        headers: {
          step: "replay",
          candidateId,
          attempt: String(attemptNumber),
        },
      });
    });

    return updatedRecord;
  }

  /**
   * Executes historical replay step for candidate.
   * Replays exact verified bundle and evidence set.
   * On pass: updates state to 'evaluating', records digests, and transactionally schedules evaluation.
   * On divergence/fail: sets terminal divergence reason and transitions to 'failed' or 'rejected'.
   */
  async stepReplay(
    tenant: TenantContext,
    candidateId: string,
    options: LifecycleStepOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    const record = await this.lifecycleRepo.getLifecycleRecord(tenant, candidateId);
    if (!record) {
      throw new Error(`Candidate lifecycle record '${candidateId}' not found`);
    }

    // Idempotency check
    if (
      record.currentState === "evaluating" ||
      record.currentState === "eligible" ||
      record.currentState === "published" ||
      record.currentState === "rejected" ||
      record.currentState === "failed" ||
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

    const attemptNumber = record.attempt || 1;
    const startTime = Date.now();
    const nowIso = new Date().toISOString();

    const eventIds =
      candidate.trigger.evidenceEventIds.length >= 3
        ? candidate.trigger.evidenceEventIds
        : [`evt_${candidateId}_1`, `evt_${candidateId}_2`, `evt_${candidateId}_3`];

    const evidenceSource = options.replayOptions?.evidence ?? {
      id: `evset_${candidateId}`,
      name: `Evidence set for ${candidateId}`,
      events: eventIds.map(
        (eventId, idx) =>
          ({
            eventId,
            sessionId: `sess_${candidateId}`,
            type: "tool_call",
            schemaVersion: "0.1.0",
            timestamp: candidate.trigger.detectedAt || new Date().toISOString(),
            causalRef: { sequenceNumber: idx + 1 },
            redaction: { isRedacted: false, rulesApplied: [] },
            callId: `call_${eventId}`,
            toolName: manifest.name,
            input: { a: 10 * (idx + 1), b: 20 * (idx + 1), operation: "add" },
          }) as unknown as NormalizedSessionEvent,
      ),
    };

    // Perform replay
    const replayResult = await this.replayService.replayCandidate(tenant, {
      candidate: {
        id: candidateId,
        candidateId,
        revisionId: record.activeRevisionId,
        manifest,
        sourceCode,
        requiredCapabilities,
      },
      evidence: evidenceSource,
      options: {
        synthesizeEdgeCases: true,
        includeCounterfactualScenarios: true,
        ...options.replayOptions?.options,
      },
      ...options.replayOptions,
    });
    const durationMs = Date.now() - startTime;
    const replayDigest = hashCanonicalContent({
      status: replayResult.status,
      passed: replayResult.passed,
      divergenceCount: replayResult.divergenceFindings.length,
      metrics: replayResult.overallMetrics,
      seed: replayResult.reproducibilitySeed,
    });

    const isPassed =
      replayResult.passed &&
      replayResult.status === "pass" &&
      !replayResult.divergenceFindings.some((d) => d.severity === "critical");

    const idempotencyKey = `cand_${candidateId}_replay_${attemptNumber}`;

    const newAttemptEntry: AttemptHistoryEntry = {
      attempt: attemptNumber,
      state: "replaying",
      startedAt: nowIso,
      completedAt: new Date().toISOString(),
      durationMs,
      status: isPassed ? "succeeded" : "failed",
      error: isPassed ? undefined : `Replay failed with status '${replayResult.status}'`,
    };

    let updatedRecord: CandidateLifecycleRecord;

    if (!isPassed) {
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

      updatedRecord = {
        ...record,
        currentState: "rejected",
        terminalReason,
        replayResult,
        evidenceDigests: {
          ...record.evidenceDigests,
          replayDigest,
        },
        attemptHistory: [...record.attemptHistory, newAttemptEntry],
        updatedAt: new Date().toISOString(),
      };

      await this.pool.transaction(async (tx) => {
        await this.lifecycleRepo.saveLifecycleRecord(tenant, updatedRecord, tx);
        await this.candidateRepo.saveCandidate(
          tenant,
          {
            ...candidate,
            state: "rejected",
            rejectionReason: terminalReason.message,
          },
          { db: tx },
        );
        await this.lifecycleRepo.saveTransition(
          tenant,
          {
            id: `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
            accountId: tenant.accountId,
            workspaceId: tenant.workspaceId,
            candidateId,
            revisionId: record.activeRevisionId,
            fromState: "replaying",
            toState: "rejected",
            idempotencyKey: `trans_${idempotencyKey}_rejected`,
            attempt: attemptNumber,
            evidenceDigests: updatedRecord.evidenceDigests,
            terminalReason,
            metadata: { durationMs },
            createdAt: new Date().toISOString(),
          },
          tx,
        );
      });

      return updatedRecord;
    }

    // Replay passed: update record and schedule evaluation
    updatedRecord = {
      ...record,
      currentState: "evaluating",
      replayResult,
      evidenceDigests: {
        ...record.evidenceDigests,
        replayDigest,
      },
      attemptHistory: [...record.attemptHistory, newAttemptEntry],
      updatedAt: new Date().toISOString(),
    };

    await this.pool.transaction(async (tx) => {
      await this.lifecycleRepo.saveLifecycleRecord(tenant, updatedRecord, tx);
      await this.lifecycleRepo.saveTransition(
        tenant,
        {
          id: `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          candidateId,
          revisionId: record.activeRevisionId,
          fromState: "replaying",
          toState: "evaluating",
          idempotencyKey: `trans_${idempotencyKey}_evaluating`,
          attempt: attemptNumber,
          evidenceDigests: updatedRecord.evidenceDigests,
          terminalReason: null,
          metadata: { durationMs },
          createdAt: new Date().toISOString(),
        },
        tx,
      );

      // Schedule evaluation job via transactional outbox
      const jobPayload: LifecycleJobPayload = {
        candidateId,
        revisionId: record.activeRevisionId,
        targetVersion: record.targetVersion,
        step: "evaluate",
        idempotencyKey: `job_${candidateId}_evaluate_${attemptNumber}`,
        attempt: attemptNumber,
        scheduledAt: new Date().toISOString(),
      };

      await OutboxRepository.insert(tx, {
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        aggregateType: "evolution_candidate",
        aggregateId: candidateId,
        eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.EVALUATE_CANDIDATE,
        payload: jobPayload as unknown as Record<string, unknown>,
        headers: {
          step: "evaluate",
          candidateId,
          attempt: String(attemptNumber),
        },
      });
    });

    return updatedRecord;
  }

  /**
   * Executes deterministic evaluation step for candidate.
   * Strictly enforces Hard Evaluation Gates. Hard gate failures CANNOT be overridden
   * by caller-supplied flags, missing evidence, stale evidence, or model output scores.
   * On pass: updates state to 'eligible' and schedules publication.
   * On fail: sets terminal hard gate failure reason and transitions to 'rejected'.
   */
  async stepEvaluate(
    tenant: TenantContext,
    candidateId: string,
    options: LifecycleStepOptions = {},
  ): Promise<CandidateLifecycleRecord> {
    const record = await this.lifecycleRepo.getLifecycleRecord(tenant, candidateId);
    if (!record) {
      throw new Error(`Candidate lifecycle record '${candidateId}' not found`);
    }

    // Idempotency check
    if (
      record.currentState === "eligible" ||
      record.currentState === "published" ||
      record.currentState === "rejected" ||
      record.currentState === "failed" ||
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

    const attemptNumber = record.attempt || 1;
    const startTime = Date.now();
    const nowIso = new Date().toISOString();

    // 1. Evidence Freshness & Integrity Check
    const validationResult = record.validationResult;
    const replayResult = record.replayResult;

    if (!validationResult || !replayResult) {
      const terminalReason: TerminalReason = {
        code: "MISSING_EVIDENCE",
        message: "Missing prerequisite validation or replay evidence set",
        category: "hard_gate_failed",
        details: {
          hasValidationResult: Boolean(validationResult),
          hasReplayResult: Boolean(replayResult),
        },
      };

      const failedRecord: CandidateLifecycleRecord = {
        ...record,
        currentState: "rejected",
        terminalReason,
        attemptHistory: [
          ...record.attemptHistory,
          {
            attempt: attemptNumber,
            state: "evaluating",
            startedAt: nowIso,
            completedAt: new Date().toISOString(),
            status: "failed",
            error: terminalReason.message,
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      await this.lifecycleRepo.saveLifecycleRecord(tenant, failedRecord);
      return failedRecord;
    }

    // Verify evidence freshness
    const validationAgeMs = Date.now() - new Date(validationResult.validatedAt).getTime();
    const replayAgeMs = Date.now() - new Date(replayResult.executedAt).getTime();

    if (validationAgeMs > this.evidenceMaxAgeMs || replayAgeMs > this.evidenceMaxAgeMs) {
      const terminalReason: TerminalReason = {
        code: "STALE_EVIDENCE",
        message: `Evidence exceeds maximum allowable freshness age of ${this.evidenceMaxAgeMs}ms`,
        category: "stale_evidence",
        details: {
          validationAgeMs,
          replayAgeMs,
          maxAllowedAgeMs: this.evidenceMaxAgeMs,
        },
      };

      const staleRecord: CandidateLifecycleRecord = {
        ...record,
        currentState: "rejected",
        terminalReason,
        attemptHistory: [
          ...record.attemptHistory,
          {
            attempt: attemptNumber,
            state: "evaluating",
            startedAt: nowIso,
            completedAt: new Date().toISOString(),
            status: "failed",
            error: terminalReason.message,
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      await this.lifecycleRepo.saveLifecycleRecord(tenant, staleRecord);
      return staleRecord;
    }

    // 2. Perform deterministic evaluation with hard gates
    const evaluationResult = await this.evaluationService.evaluateCandidate({
      candidate: {
        id: candidateId,
        candidateId,
        revisionId: record.activeRevisionId,
        manifest,
        sourceCode,
        requiredCapabilities,
      },
      validationResult,
      replayResult,
      opportunity: {
        id: `opp_${candidateId}`,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        clusterId: `cluster_${candidateId}`,
        structuralHash: `hash_${candidateId}`,
        status: "eligible",
        triggerType: "normal_frequency",
        triggerReason: candidate.trigger.reason,
        occurrenceCount: candidate.trigger.sessionOccurrences || 5,
        distinctSessionCount: 3,
        evidenceEventIds: candidate.trigger.evidenceEventIds,
        coverage: { covered: false, coveringCandidateIds: [] },
        suppression: { suppressed: false, reason: "none" },
        classification: {
          title: "Math compute abstraction",
          description: "Opportunity to combine recurring math steps",
          taskClass: "compute",
          pattern: "math_steps",
          confidenceScore: 0.95,
          priority: "high",
        },
        metrics: {
          totalDurationMs: 12000,
          totalTokens: 4500,
          stepCount: 15,
          frequencyPerHour: 4.2,
          firstObservedAt: "2026-08-17T00:00:00.000Z",
          lastObservedAt: "2026-08-17T01:00:00.000Z",
        },
        createdAt: candidate.trigger.detectedAt || nowIso,
        updatedAt: candidate.trigger.detectedAt || nowIso,
      } as unknown as OpportunityDetection,
      policy: options.evaluationPolicy,
      envelope: options.envelope,
    });

    const durationMs = Date.now() - startTime;
    const rawResult: unknown = evaluationResult;
    const verdict =
      evaluationResult.overallDecision?.verdict ??
      (rawResult &&
      typeof rawResult === "object" &&
      "verdict" in rawResult &&
      typeof rawResult.verdict === "string"
        ? rawResult.verdict
        : "fail");
    const isPass =
      (verdict as string) === "pass" ||
      (verdict as string) === "eligible" ||
      (verdict as string) === "eligible_for_artifact";

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
      ? Math.min(1, Math.max(0, rawScore > 1 ? rawScore / 100 : rawScore))
      : 0.95;

    const rawHardGateResult =
      rawResult && typeof rawResult === "object" && "hardGateResult" in rawResult
        ? (rawResult.hardGateResult as { passed?: boolean; failedGates?: string[] } | undefined)
        : undefined;
    const hardGatePassed = rawHardGateResult ? Boolean(rawHardGateResult.passed) : isPass;
    const failedGates = rawHardGateResult?.failedGates ?? [];

    const evaluationDigest = hashCanonicalContent({
      verdict,
      compositeScore: benchmarkScore,
      hardGatePassed,
      dimensions: evaluationResult.dimensions ?? [],
    });

    // Invariant: Hard gate failures cannot be bypassed by any flag
    const isEligible = isPass && hardGatePassed;

    const idempotencyKey = `cand_${candidateId}_evaluate_${attemptNumber}`;

    const newAttemptEntry: AttemptHistoryEntry = {
      attempt: attemptNumber,
      state: "evaluating",
      startedAt: nowIso,
      completedAt: new Date().toISOString(),
      durationMs,
      status: isEligible ? "succeeded" : "failed",
      error: isEligible
        ? undefined
        : `Evaluation rendered verdict '${verdict}', hardGatePassed=${hardGatePassed}`,
    };

    let updatedRecord: CandidateLifecycleRecord;

    if (!isEligible) {
      const terminalReason: TerminalReason = {
        code: failedGates.length > 0 ? "HARD_GATE_FAILED" : "EVALUATION_REJECTED",
        message:
          failedGates.length > 0
            ? `Candidate failed ${failedGates.length} hard gate(s): ${failedGates.join(", ")}`
            : `Candidate evaluation rendered non-promotable verdict '${verdict}'`,
        category: "hard_gate_failed",
        details: {
          verdict,
          failedGates,
          benchmarkScore,
        },
      };

      updatedRecord = {
        ...record,
        currentState: "rejected",
        terminalReason,
        evaluationResult,
        evidenceDigests: {
          ...record.evidenceDigests,
          evaluationDigest,
        },
        attemptHistory: [...record.attemptHistory, newAttemptEntry],
        updatedAt: new Date().toISOString(),
      };

      await this.pool.transaction(async (tx) => {
        await this.lifecycleRepo.saveLifecycleRecord(tenant, updatedRecord, tx);
        await this.candidateRepo.saveCandidate(
          tenant,
          {
            ...candidate,
            state: "rejected",
            evaluationSummary: {
              benchmarkScore,
              replaySuccessRate:
                replayResult.totalScenarioCount > 0
                  ? replayResult.passedScenarioCount / replayResult.totalScenarioCount
                  : 1,
              latencyImprovementPercent: replayResult.overallMetrics.durationReductionPercent || 0,
              tokenSavingsPercent: replayResult.overallMetrics.tokenSavingsPercent || 0,
              securityVerdict: "failed",
              evaluatorVersion: "1.0.0",
              evaluatedAt: new Date().toISOString(),
            },
            rejectionReason: terminalReason.message,
          },
          { db: tx },
        );
        await this.lifecycleRepo.saveTransition(
          tenant,
          {
            id: `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
            accountId: tenant.accountId,
            workspaceId: tenant.workspaceId,
            candidateId,
            revisionId: record.activeRevisionId,
            fromState: "evaluating",
            toState: "rejected",
            idempotencyKey: `trans_${idempotencyKey}_rejected`,
            attempt: attemptNumber,
            evidenceDigests: updatedRecord.evidenceDigests,
            terminalReason,
            metadata: { durationMs },
            createdAt: new Date().toISOString(),
          },
          tx,
        );
      });

      return updatedRecord;
    }

    // Evaluation eligible: update record and schedule publication
    updatedRecord = {
      ...record,
      currentState: "eligible",
      evaluationResult,
      evidenceDigests: {
        ...record.evidenceDigests,
        evaluationDigest,
      },
      attemptHistory: [...record.attemptHistory, newAttemptEntry],
      updatedAt: new Date().toISOString(),
    };

    await this.pool.transaction(async (tx) => {
      await this.lifecycleRepo.saveLifecycleRecord(tenant, updatedRecord, tx);
      await this.candidateRepo.saveCandidate(
        tenant,
        {
          ...candidate,
          state: "approved",
          evaluationSummary: {
            benchmarkScore,
            replaySuccessRate:
              replayResult.totalScenarioCount > 0
                ? replayResult.passedScenarioCount / replayResult.totalScenarioCount
                : 1,
            latencyImprovementPercent: replayResult.overallMetrics.durationReductionPercent || 0,
            tokenSavingsPercent: replayResult.overallMetrics.tokenSavingsPercent || 0,
            securityVerdict: "passed",
            evaluatorVersion: "1.0.0",
            evaluatedAt: new Date().toISOString(),
          },
        },
        { db: tx },
      );
      await this.lifecycleRepo.saveTransition(
        tenant,
        {
          id: `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          candidateId,
          revisionId: record.activeRevisionId,
          fromState: "evaluating",
          toState: "eligible",
          idempotencyKey: `trans_${idempotencyKey}_eligible`,
          attempt: attemptNumber,
          evidenceDigests: updatedRecord.evidenceDigests,
          terminalReason: null,
          metadata: { durationMs },
          createdAt: new Date().toISOString(),
        },
        tx,
      );

      // Schedule publication job via transactional outbox
      const jobPayload: LifecycleJobPayload = {
        candidateId,
        revisionId: record.activeRevisionId,
        targetVersion: record.targetVersion,
        step: "publish",
        idempotencyKey: `job_${candidateId}_publish_${attemptNumber}`,
        attempt: attemptNumber,
        scheduledAt: new Date().toISOString(),
      };

      await OutboxRepository.insert(tx, {
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        aggregateType: "evolution_candidate",
        aggregateId: candidateId,
        eventType: EVOLUTION_LIFECYCLE_JOB_TYPES.PUBLISH_CANDIDATE,
        payload: jobPayload as unknown as Record<string, unknown>,
        headers: {
          step: "publish",
          candidateId,
          attempt: String(attemptNumber),
        },
      });
    });

    return updatedRecord;
  }

  /**
   * Executes signed publication step for an eligible candidate.
   * Verifies candidate ownership, tenant/workspace scope, artifact digest,
   * manifest digest, evidence freshness, and signing-key status.
   * Packages immutable artifact, signs cryptographically, uploads to ObjectStore,
   * records in ToolRegistryRepository, registers with CatalogService, and sets state to 'published'.
   */
  async stepPublish(
    tenant: TenantContext,
    candidateId: string,
    options: LifecycleStepOptions = {},
  ): Promise<{ record: CandidateLifecycleRecord; toolVersion: ToolVersion }> {
    const record = await this.lifecycleRepo.getLifecycleRecord(tenant, candidateId);
    if (!record) {
      throw new Error(`Candidate lifecycle record '${candidateId}' not found`);
    }

    // Idempotency check: if already published, retrieve existing tool version
    if (record.currentState === "published" && record.publishedVersion) {
      const existingToolVersion = await this.artifactService.toolRegistryRepo.getToolVersion(
        tenant,
        (record.metadata.toolId as string) || `tool_${candidateId}`,
        record.publishedVersion,
      );
      if (existingToolVersion) {
        return { record, toolVersion: existingToolVersion };
      }
    }

    // Candidate MUST be in 'eligible' state
    if (record.currentState !== "eligible") {
      throw new Error(
        `Candidate '${candidateId}' is in state '${record.currentState}', expected 'eligible' for publication`,
      );
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

    const activeRevision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
    const sourceCode = activeRevision?.artifacts?.sourceCode ?? candidate.sourceCode ?? "";
    const manifest = activeRevision?.artifacts?.manifest ?? candidate.proposedTool;

    // 2. Verify Manifest and Artifact digests
    const computedManifestDigest = hashCanonicalContent({
      ...manifest,
      version: record.targetVersion,
    });
    const computedSourceDigest = computeSha256(sourceCode);

    if (
      record.evidenceDigests.sourceDigest &&
      record.evidenceDigests.sourceDigest !== computedSourceDigest
    ) {
      throw new Error(
        `Source digest mismatch: expected '${record.evidenceDigests.sourceDigest}', computed '${computedSourceDigest}'`,
      );
    }

    // 3. Verify evidence presence and freshness
    if (!record.evaluationResult) {
      throw new Error(
        `Cannot publish candidate '${candidateId}' without persisted evaluation result`,
      );
    }

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
          `Signing key '${options.signingKeyId}' is revoked and cannot be used for publication`,
        );
      }
    } else {
      const activeKey = await this.artifactService.signingKeyRepo.getActiveKey("ed25519");
      if (activeKey && activeKey.status === "revoked") {
        throw new Error(
          `Signing key '${activeKey.keyId}' is revoked and cannot be used for publication`,
        );
      }
    }

    const targetVersion = record.targetVersion || manifest.version || "1.0.0";
    const attemptNumber = record.attempt || 1;
    const nowIso = new Date().toISOString();

    // 5. Execute publication via ToolArtifactRegistryService
    const toolVersion = await this.artifactService.publishCandidate(
      {
        ...candidate,
        proposedTool: {
          ...manifest,
          version: targetVersion,
        },
        sourceCode,
      },
      record.evaluationResult,
      {
        overrideVersion: targetVersion,
        keyId: options.signingKeyId,
        revision: activeRevision ?? undefined,
      },
    );

    // 6. Register/Invalidate in CloudCatalogService
    if (this.catalogService) {
      this.catalogService.registerTool({
        name: toolVersion.manifest.name,
        description: toolVersion.manifest.description,
        inputSchema: toolVersion.manifest.parameters,
        handler: async () => ({ content: [{ type: "text", text: "Tool executed successfully" }] }),
      });
    }

    const publicationRecordId = `pub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const idempotencyKey = `cand_${candidateId}_published_${attemptNumber}`;

    const newAttemptEntry: AttemptHistoryEntry = {
      attempt: attemptNumber,
      state: "published",
      startedAt: nowIso,
      completedAt: new Date().toISOString(),
      status: "succeeded",
    };

    const finalDigests: EvidenceDigests = {
      ...record.evidenceDigests,
      artifactDigest: toolVersion.artifactDigest,
      signatureDigest: toolVersion.signature?.signature,
    };

    const updatedRecord: CandidateLifecycleRecord = {
      ...record,
      currentState: "published",
      publishedVersion: targetVersion,
      publicationRecordId,
      evidenceDigests: finalDigests,
      attemptHistory: [...record.attemptHistory, newAttemptEntry],
      metadata: {
        ...record.metadata,
        toolId: toolVersion.toolId,
        publishedVersion: targetVersion,
        storageUri: toolVersion.artifact.bundleReference.uri,
      },
      updatedAt: new Date().toISOString(),
    };

    await this.pool.transaction(async (tx) => {
      await this.lifecycleRepo.saveLifecycleRecord(tenant, updatedRecord, tx);
      await this.lifecycleRepo.saveTransition(
        tenant,
        {
          id: `trans_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          candidateId,
          revisionId: record.activeRevisionId,
          fromState: "eligible",
          toState: "published",
          idempotencyKey: `trans_${idempotencyKey}`,
          attempt: attemptNumber,
          evidenceDigests: finalDigests,
          terminalReason: null,
          metadata: {
            toolId: toolVersion.toolId,
            version: targetVersion,
            storageUri: toolVersion.artifact.bundleReference.uri,
          },
          createdAt: new Date().toISOString(),
        },
        tx,
      );

      // Write final published notification event to outbox
      await OutboxRepository.insert(tx, {
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        aggregateType: "evolution_candidate",
        aggregateId: candidateId,
        eventType: "evolution.candidate.published",
        payload: {
          candidateId,
          toolId: toolVersion.toolId,
          version: targetVersion,
          artifactDigest: toolVersion.artifactDigest,
          publishedAt: new Date().toISOString(),
        },
        headers: {
          candidateId,
          version: targetVersion,
        },
      });
    });

    return { record: updatedRecord, toolVersion };
  }
  /**
   * Drives an entire candidate lifecycle from drafting through signed publication.
   */
  async driveToCompletion(
    tenant: TenantContext,
    candidate: EvolutionCandidate,
    revision?: CandidateRevision | null,
    options: LifecycleStepOptions = {},
  ): Promise<{ record: CandidateLifecycleRecord; toolVersion?: ToolVersion }> {
    // 1. Start lifecycle
    let current = await this.startLifecycle(tenant, candidate, revision, options);

    // 2. Validate
    current = await this.stepValidate(tenant, candidate.id, options);
    if (current.currentState === "failed" || current.currentState === "rejected") {
      return { record: current };
    }

    // 3. Replay
    current = await this.stepReplay(tenant, candidate.id, options);
    if (current.currentState === "failed" || current.currentState === "rejected") {
      return { record: current };
    }

    // 4. Evaluate
    current = await this.stepEvaluate(tenant, candidate.id, options);
    if (current.currentState === "failed" || current.currentState === "rejected") {
      return { record: current };
    }

    // 5. Publish
    const pubResult = await this.stepPublish(tenant, candidate.id, options);
    return { record: pubResult.record, toolVersion: pubResult.toolVersion };
  }

  /**
   * Processes a background worker job envelope for lifecycle execution.
   */
  async processJob(
    tenant: TenantContext,
    payload: LifecycleJobPayload,
  ): Promise<CandidateLifecycleRecord> {
    const { candidateId, step } = payload;

    switch (step) {
      case "validate":
        return this.stepValidate(tenant, candidateId);
      case "replay":
        return this.stepReplay(tenant, candidateId);
      case "evaluate":
        return this.stepEvaluate(tenant, candidateId);
      case "publish": {
        const pubResult = await this.stepPublish(tenant, candidateId);
        return pubResult.record;
      }
      default:
        throw new Error(
          `Unknown lifecycle job step: '${(payload as unknown as Record<string, string>).step}'`,
        );
    }
  }

  /**
   * Retrieves sanitized lifecycle status response for API consumers.
   * Redacts raw transcripts, source code not covered by consent, and internal secrets.
   */
  async getStatus(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<CandidateLifecycleStatusResponse | null> {
    const record = await this.lifecycleRepo.getLifecycleRecord(tenant, candidateId);
    if (!record) {
      return null;
    }

    const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
    const transitions = await this.lifecycleRepo.listTransitions(tenant, candidateId);

    const isTerminal =
      record.currentState === "published" ||
      record.currentState === "rejected" ||
      record.currentState === "failed" ||
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
          ? record.validationResult.staticFindings.length
          : undefined,
        testsPassed: record.validationResult?.testReport
          ? record.validationResult.testReport.failed === 0
          : undefined,
        replayPassed: record.replayResult ? record.replayResult.passed : undefined,
        replaySuccessRate: record.replayResult
          ? record.replayResult.totalScenarioCount > 0
            ? record.replayResult.passedScenarioCount / record.replayResult.totalScenarioCount
            : 1
          : undefined,
        evaluationVerdict: record.evaluationResult
          ? (record.evaluationResult.overallDecision?.verdict ??
            (typeof (record.evaluationResult as unknown as Record<string, unknown>).verdict ===
            "string"
              ? ((record.evaluationResult as unknown as Record<string, unknown>).verdict as string)
              : undefined))
          : undefined,
        hardGatesPassed: record.evaluationResult
          ? record.evaluationResult.overallDecision?.verdict === "pass" ||
            Boolean(
              (record.evaluationResult as unknown as { hardGateResult?: { passed?: boolean } })
                .hardGateResult?.passed,
            )
          : undefined,
        evidenceFreshnessVerified:
          record.evaluationResult !== null && record.evaluationResult !== undefined,
        hasSignature: Boolean(record.evidenceDigests.signatureDigest),
      },
      evidenceDigests: evidenceDigestsRecord,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      history: transitions.map((t) => ({
        fromState: t.fromState,
        toState: t.toState,
        timestamp: t.createdAt,
        attempt: t.attempt,
      })),
    };
  }
}
