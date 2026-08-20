import { describe, expect, it } from "vitest";
import { CandidateLifecycleOrchestrator } from "../../../src/evolution/lifecycle/orchestrator.js";
import type { RepairOrchestrator } from "../../../src/evolution/generator/repair-orchestrator.js";
import type { CandidateValidationService } from "../../../src/evolution/testing/service.js";
import type { CandidateValidationResult } from "../../../src/evolution/testing/types.js";
import {
  createMockCandidate,
  createMockRevision,
  createTestLifecycleEnvironment,
} from "./helpers.js";

const TENANT = { accountId: "acct-l1", workspaceId: "ws-l1" };

function repairableFailResult(candidateId: string, revisionId?: string): CandidateValidationResult {
  return {
    candidateId,
    revisionId,
    status: "repairable_fail",
    passed: false,
    staticFindings: [
      {
        severity: "error",
        category: "static_flaw",
        message: "Result of cmd.exec is not checked for exitCode",
        fixHint: "Check result.exitCode before using stdout",
      },
    ],
    typecheckPassed: true,
    validatedAt: new Date().toISOString(),
    durationMs: 5,
  };
}

function passResult(candidateId: string, revisionId?: string): CandidateValidationResult {
  return {
    candidateId,
    revisionId,
    status: "pass",
    passed: true,
    staticFindings: [],
    typecheckPassed: true,
    validatedAt: new Date().toISOString(),
    durationMs: 5,
  };
}

function stubRepairOrchestrator(success: boolean): RepairOrchestrator {
  return {
    async orchestrateAsync(artifacts: { sourceCode: string }) {
      return {
        success,
        revisions: [],
        activeRevision: {
          revisionId: "rev_repair_stub",
          candidateId: "stub",
          revisionNumber: 2,
          artifacts: {
            ...artifacts,
            sourceCode: artifacts.sourceCode + "\n// repaired",
          },
          selfReview: { passed: true, issues: [], reviewedAt: new Date().toISOString() },
          repairHistory: [],
          createdAt: new Date().toISOString(),
        },
      };
    },
  } as unknown as RepairOrchestrator;
}

describe("L1: validation repairable_fail routes into bounded repair loop", () => {
  it("repairs a repairable_fail, creates a child revision, and re-validates to replaying", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(TENANT);
    const revision = createMockRevision(candidate, TENANT);
    await env.candidateRepo.saveCandidate(TENANT, candidate);
    await env.candidateRepo.saveRevision(TENANT, revision);

    const validationCalls: Array<{ revisionId?: string }> = [];
    const validationService = {
      async validateCandidate(target: { revisionId?: string }) {
        validationCalls.push({ revisionId: target.revisionId });
        // Fail repairable on the original revision, pass on the repaired child.
        return validationCalls.length === 1
          ? repairableFailResult(candidate.id, target.revisionId)
          : passResult(candidate.id, target.revisionId);
      },
    } as unknown as CandidateValidationService;

    const orchestrator = new CandidateLifecycleOrchestrator(env.pool, {
      validationService,
      replayService: env.replayService,
      evaluationService: env.evaluationService,
      artifactService: env.artifactService,
      catalogService: env.catalogService,
      candidateRepo: env.candidateRepo,
      lifecycleRepo: env.lifecycleRepo,
      repairOrchestrator: stubRepairOrchestrator(true),
    });

    await orchestrator.startLifecycle(TENANT, candidate, revision);
    const record = await orchestrator.stepValidate(TENANT, candidate.id);

    expect(record.currentState).toBe("replaying");
    expect(validationCalls).toHaveLength(2);
    expect(validationCalls[1]!.revisionId).not.toBe(validationCalls[0]!.revisionId);

    const revisions = await env.candidateRepo.listRevisions(TENANT, candidate.id);
    expect(revisions.length).toBe(2);
    const child = revisions.find((r) => r.revisionNumber === 2);
    expect(child).toBeDefined();
    expect(child!.parentRevisionId).toBe(revision.revisionId);
    expect(child!.artifacts.sourceCode).toContain("// repaired");
  });

  it("goes terminal failed when the repair loop cannot fix the findings", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(TENANT);
    const revision = createMockRevision(candidate, TENANT);
    await env.candidateRepo.saveCandidate(TENANT, candidate);
    await env.candidateRepo.saveRevision(TENANT, revision);

    const validationService = {
      async validateCandidate(target: { revisionId?: string }) {
        return repairableFailResult(candidate.id, target.revisionId);
      },
    } as unknown as CandidateValidationService;

    const orchestrator = new CandidateLifecycleOrchestrator(env.pool, {
      validationService,
      replayService: env.replayService,
      evaluationService: env.evaluationService,
      artifactService: env.artifactService,
      catalogService: env.catalogService,
      candidateRepo: env.candidateRepo,
      lifecycleRepo: env.lifecycleRepo,
      repairOrchestrator: stubRepairOrchestrator(false),
    });

    await orchestrator.startLifecycle(TENANT, candidate, revision);
    const record = await orchestrator.stepValidate(TENANT, candidate.id);

    expect(record.currentState).toBe("failed");
    expect(record.terminalReason?.code).toBe("VALIDATION_FAILED");
    const revisions = await env.candidateRepo.listRevisions(TENANT, candidate.id);
    expect(revisions.length).toBe(1);
  });

  it("bounds validation-driven repairs to at most 2 attempts", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(TENANT);
    const revision = createMockRevision(candidate, TENANT);
    await env.candidateRepo.saveCandidate(TENANT, candidate);
    await env.candidateRepo.saveRevision(TENANT, revision);

    let validateCalls = 0;
    const validationService = {
      async validateCandidate(target: { revisionId?: string }) {
        validateCalls++;
        return repairableFailResult(candidate.id, target.revisionId);
      },
    } as unknown as CandidateValidationService;

    const orchestrator = new CandidateLifecycleOrchestrator(env.pool, {
      validationService,
      replayService: env.replayService,
      evaluationService: env.evaluationService,
      artifactService: env.artifactService,
      catalogService: env.catalogService,
      candidateRepo: env.candidateRepo,
      lifecycleRepo: env.lifecycleRepo,
      repairOrchestrator: stubRepairOrchestrator(true),
    });

    await orchestrator.startLifecycle(TENANT, candidate, revision);
    const record = await orchestrator.stepValidate(TENANT, candidate.id);

    expect(record.currentState).toBe("failed");
    // 1 initial + 2 post-repair revalidations; attempt 3 exceeds the repair bound.
    expect(validateCalls).toBe(3);
    const revisions = await env.candidateRepo.listRevisions(TENANT, candidate.id);
    expect(revisions.length).toBe(3);
  });
});
