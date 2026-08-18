import { describe, expect, it } from "vitest";
import { CandidateEvaluationService } from "../../../src/evolution/evaluation/service.js";
import { CandidateLifecycleOrchestrator } from "../../../src/evolution/lifecycle/orchestrator.js";
import type { HistoricalReplayService } from "../../../src/evolution/replay/service.js";
import type { CandidateValidationService } from "../../../src/evolution/testing/service.js";
import type { TenantContext } from "../../../src/tenant.js";
import {
  createMockBrokeredCandidate,
  createMockBrokeredRevision,
  createMockCandidate,
  createMockRevision,
  createMockWorkflowCandidate,
  createMockWorkflowRevision,
  createTestLifecycleEnvironment,
} from "./helpers.js";

describe("Candidate Lifecycle - DLQ State Persistence, Resume Controls & Fault Recovery", () => {
  const tenant: TenantContext = {
    accountId: "acc_dlq_fault_test",
    workspaceId: "ws_dlq_fault_test",
  };

  it("should persist terminal failures to PostgreSQL DLQ with redacted diagnostics and tenant isolation", async () => {
    const env = await createTestLifecycleEnvironment();
    // Candidate with malicious code that fails validation
    const candidate = createMockCandidate(tenant, {
      sourceCode: `
import child_process from "child_process";
const SECRET_KEY = "sk-1234567890abcdef1234567890abcdef";
export default function run() {
  child_process.execSync("cat /etc/passwd");
}
`,
    });
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);
    const failed = await env.orchestrator.stepValidate(tenant, candidate.id);

    expect(failed.currentState).toBe("failed");
    expect(failed.terminalReason?.code).toBe("VALIDATION_FAILED");

    // Verify DLQ entry exists
    const dlqRecords = await env.lifecycleRepo.listDlqRecords(tenant, {
      candidateId: candidate.id,
      stage: "validate",
    });
    expect(dlqRecords.length).toBe(1);
    const dlq = dlqRecords[0];
    expect(dlq.candidateId).toBe(candidate.id);
    expect(dlq.stage).toBe("validate");
    expect(dlq.errorCategory).toBe("validation_failure");
    expect(dlq.retryClassification).toBe("terminal");
    expect(dlq.resumed).toBe(false);

    // Verify diagnostics are scrubbed of sensitive secrets
    const diagStr = JSON.stringify(dlq.diagnostics);
    expect(diagStr).not.toContain("sk-1234567890abcdef");

    // Verify cross-tenant isolation: other workspace cannot view DLQ
    const otherTenant: TenantContext = {
      accountId: "acc_other",
      workspaceId: "ws_other",
    };
    const otherDlq = await env.lifecycleRepo.listDlqRecords(otherTenant, {
      candidateId: candidate.id,
    });
    expect(otherDlq.length).toBe(0);
  });

  it("should support operator resume controls from DLQ with state reset and stage re-execution", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);

    // Manually place a DLQ entry simulating a quarantined candidate
    const dlqEntry = await env.lifecycleRepo.saveDlqRecord(tenant, {
      id: `dlq_resume_test_${Date.now()}`,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      candidateId: candidate.id,
      revisionId: revision.revisionId,
      stage: "validate",
      errorCategory: "queue_delay",
      errorMessage: "Job execution timeout",
      retryClassification: "terminal",
      attemptCount: 1,
      diagnostics: { reason: "Worker stalled" },
      resumed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(dlqEntry.resumed).toBe(false);

    // Resume from DLQ via orchestrator control
    const resumedRecord = await env.orchestrator.resumeFromDlq(tenant, dlqEntry.id, {
      resumedBy: "secops_admin_42",
      targetStage: "validate",
    });

    // Verification step should have run and transitioned state to replaying
    expect(resumedRecord.currentState).toBe("replaying");
    expect(resumedRecord.validationResult?.passed).toBe(true);

    // Check DLQ record is marked resumed
    const updatedDlq = await env.lifecycleRepo.getDlqRecord(tenant, dlqEntry.id);
    expect(updatedDlq?.resumed).toBe(true);
    expect(updatedDlq?.resumedBy).toBe("secops_admin_42");
    expect(updatedDlq?.resumedAt).toBeDefined();
  });

  it("should survive simulated boundary crashes and resume from last persisted state across orchestrator instances", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockBrokeredCandidate(tenant);
    const revision = createMockBrokeredRevision(candidate, tenant);

    // Instance 1: start and validate
    await env.orchestrator.startLifecycle(tenant, candidate, revision);
    const validated = await env.orchestrator.stepValidate(tenant, candidate.id);
    expect(validated.currentState).toBe("replaying");

    // Simulate crash: kill Instance 1 and instantiate Instance 2 connected to same database and object store
    const orchestrator2 = new CandidateLifecycleOrchestrator(env.pool, {
      validationService: env.validationService,
      replayService: env.replayService,
      evaluationService: env.evaluationService,
      artifactService: env.artifactService,
      catalogService: env.catalogService,
      candidateRepo: env.candidateRepo,
      lifecycleRepo: env.lifecycleRepo,
      outboxPublisher: env.outboxPublisher,
      queue: env.queue,
      objectStore: env.objectStore,
    });

    // Instance 2: resumes from replaying step
    const replayed = await orchestrator2.stepReplay(tenant, candidate.id);
    expect(replayed.currentState).toBe("evaluating");

    // Instance 2: evaluate
    const evaluated = await orchestrator2.stepEvaluate(tenant, candidate.id);
    expect(evaluated.currentState).toBe("eligible");

    // Instance 2: publish
    const { record: published, toolVersion } = await orchestrator2.stepPublish(
      tenant,
      candidate.id,
    );
    expect(published.currentState).toBe("published");
    expect(toolVersion.version).toBe("1.0.0");
  });

  it("should complete a brokered tool candidate automatically after injected transient database failure", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockBrokeredCandidate(tenant);
    const revision = createMockBrokeredRevision(candidate, tenant);

    let failCount = 0;
    // Custom validation service that fails with a transient DB connection drop on first attempt
    const transientValidationService = {
      async validateCandidate(target: unknown, options?: unknown) {
        if (failCount === 0) {
          failCount++;
          const dbErr = new Error(
            "connection terminated due to administrator command (database restart)",
          );
          dbErr.name = "DatabaseConnectionError";
          throw dbErr;
        }
        return env.validationService.validateCandidate(target as never, options as never);
      },
    } as unknown as CandidateValidationService;

    const orchestrator = new CandidateLifecycleOrchestrator(env.pool, {
      validationService: transientValidationService,
      replayService: env.replayService,
      evaluationService: env.evaluationService,
      artifactService: env.artifactService,
      catalogService: env.catalogService,
      candidateRepo: env.candidateRepo,
      lifecycleRepo: env.lifecycleRepo,
    });

    await orchestrator.startLifecycle(tenant, candidate, revision);

    // Attempt 1: Encounters transient DB error and records retry attempt
    const retryAttempt = await orchestrator.stepValidate(tenant, candidate.id, { attempt: 1 });
    expect(retryAttempt.currentState).toBe("drafted");
    expect(retryAttempt.attempt).toBe(2);

    // Attempt 2: Recovers and succeeds
    const validated = await orchestrator.stepValidate(tenant, candidate.id, { attempt: 2 });
    expect(validated.currentState).toBe("replaying");
    expect(validated.validationResult?.passed).toBe(true);

    // Progress through to signed publication
    await orchestrator.stepReplay(tenant, candidate.id);
    await orchestrator.stepEvaluate(tenant, candidate.id);
    const { record: published, toolVersion } = await orchestrator.stepPublish(tenant, candidate.id);

    expect(published.currentState).toBe("published");
    expect(toolVersion.version).toBe("1.0.0");
    expect(toolVersion.manifest.name).toBe("weather_fetcher");
  });

  it("should complete a multi-step workflow candidate automatically after injected transient rate limit failure", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockWorkflowCandidate(tenant);
    const revision = createMockWorkflowRevision(candidate, tenant);

    let replayFailCount = 0;
    const transientReplayService = {
      async replayCandidate(t: unknown, options?: unknown) {
        if (replayFailCount === 0) {
          replayFailCount++;
          const rateErr = new Error(
            "429 Too Many Requests: RateLimitError: model inference quota exceeded",
          );
          rateErr.name = "RateLimitError";
          throw rateErr;
        }
        return env.replayService.replayCandidate(t as never, options as never);
      },
    } as unknown as HistoricalReplayService;

    const orchestrator = new CandidateLifecycleOrchestrator(env.pool, {
      validationService: env.validationService,
      replayService: transientReplayService,
      evaluationService: env.evaluationService,
      artifactService: env.artifactService,
      catalogService: env.catalogService,
      candidateRepo: env.candidateRepo,
      lifecycleRepo: env.lifecycleRepo,
    });

    await orchestrator.startLifecycle(tenant, candidate, revision);
    await orchestrator.stepValidate(tenant, candidate.id);

    // Replay Attempt 1: Encounters transient rate limit
    const retryRecord = await orchestrator.stepReplay(tenant, candidate.id, { attempt: 1 });
    expect(retryRecord.currentState).toBe("replaying");
    expect(retryRecord.attempt).toBe(2);

    // Replay Attempt 2: Recovers and passes
    const replayed = await orchestrator.stepReplay(tenant, candidate.id, { attempt: 2 });
    expect(replayed.currentState).toBe("evaluating");
    expect(replayed.replayResult?.passed).toBe(true);

    // Progress to publish
    await orchestrator.stepEvaluate(tenant, candidate.id);
    const { record: published, toolVersion } = await orchestrator.stepPublish(tenant, candidate.id);

    expect(published.currentState).toBe("published");
    expect(toolVersion.manifest.name).toBe("weather_summary_workflow");
  });
});
