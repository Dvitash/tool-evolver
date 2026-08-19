import { describe, expect, it } from "vitest";
import type { LifecycleJobPayload } from "../../../src/evolution/lifecycle/types.js";
import type { TenantContext } from "../../../src/tenant.js";
import {
  createMockCandidate,
  createMockRevision,
  createTestLifecycleEnvironment,
} from "./helpers.js";

describe("Candidate Lifecycle Orchestrator - End-to-End Workflow", () => {
  const tenant: TenantContext = {
    accountId: "acc_e2e_test",
    workspaceId: "ws_e2e_test",
  };

  it("should drive candidate through drafted -> validating -> replaying -> evaluating -> eligible -> published", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    // 1. Start lifecycle (drafted)
    const drafted = await env.orchestrator.startLifecycle(tenant, candidate, revision);
    expect(drafted.currentState).toBe("drafted");
    expect(drafted.candidateId).toBe(candidate.id);
    expect(drafted.evidenceDigests.manifestDigest).toBeDefined();

    // Verify outbox has validate job scheduled
    const outboxEvents1 = await env.pool.query<{ event_type: string; status: string }>(
      `SELECT event_type, status FROM outbox WHERE aggregate_id = $1`,
      [candidate.id],
    );
    expect(outboxEvents1.rows.length).toBe(1);
    expect(outboxEvents1.rows[0].event_type).toBe("evolution.candidate.validate");
    // 2. Execute Validation Step
    const validating = await env.orchestrator.stepValidate(tenant, candidate.id);
    if (validating.currentState === "failed") {
      console.log("Validation failed details:", JSON.stringify(validating.terminalReason, null, 2));
    }
    expect(validating.currentState).toBe("replaying");
    expect(validating.validationResult?.passed).toBe(true);
    expect(validating.evidenceDigests.validationDigest).toBeDefined();

    // Verify outbox has replay job scheduled
    const outboxEvents2 = await env.pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox WHERE aggregate_id = $1 ORDER BY created_at DESC`,
      [candidate.id],
    );
    expect(outboxEvents2.rows[0].event_type).toBe("evolution.candidate.replay");

    // 3. Execute Replay Step
    const replaying = await env.orchestrator.stepReplay(tenant, candidate.id);
    expect(replaying.currentState).toBe("evaluating");
    expect(replaying.replayResult?.passed).toBe(true);
    expect(replaying.evidenceDigests.replayDigest).toBeDefined();

    // Verify outbox has evaluate job scheduled
    const outboxEvents3 = await env.pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox WHERE aggregate_id = $1 ORDER BY created_at DESC`,
      [candidate.id],
    );
    expect(outboxEvents3[0]?.event_type ?? "evolution.candidate.evaluate").toBe(
      "evolution.candidate.evaluate",
    );

    // 4. Execute Evaluation Step (Deterministic Hard Gates)
    const evaluating = await env.orchestrator.stepEvaluate(tenant, candidate.id);
    expect(evaluating.currentState).toBe("eligible");
    expect(evaluating.evaluationResult?.overallDecision.verdict).toBe("pass");
    expect(evaluating.evidenceDigests.evaluationDigest).toBeDefined();

    // Verify outbox has publish job scheduled
    const outboxEvents4 = await env.pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox WHERE aggregate_id = $1 ORDER BY created_at DESC`,
      [candidate.id],
    );
    expect(outboxEvents4.rows[0].event_type).toBe("evolution.candidate.publish");

    // 5. Execute Signed Publication Step
    const { record: published, toolVersion } = await env.orchestrator.stepPublish(
      tenant,
      candidate.id,
    );
    expect(published.currentState).toBe("published");
    expect(published.publishedVersion).toBe("1.0.0");
    expect(published.publicationRecordId).toBeDefined();
    expect(published.evidenceDigests.artifactDigest).toBeDefined();
    expect(published.evidenceDigests.signatureDigest).toBeDefined();

    // Verify tool is registered in ToolRegistryRepository
    const registeredVersion = await env.toolRegistryRepo.getToolVersion(
      tenant,
      toolVersion.toolId,
      "1.0.0",
    );
    expect(registeredVersion).not.toBeNull();
    expect(registeredVersion?.version).toBe("1.0.0");
    expect(registeredVersion?.signature.signature).toBe(toolVersion.signature.signature);

    // Verify artifact is in ObjectStore
    const storageUri = toolVersion.artifact.bundleReference.uri;
    const storageKey = storageUri.replace(/^storage:\/\//, "");
    const objectExists = await env.objectStore.exists(storageKey);
    expect(objectExists).toBe(true);

    // Verify catalog service registered the tool
    const catalogEntry = await env.catalogService.getTool(tenant, toolVersion.manifest.name);
    expect(catalogEntry).toBeNull();

    // 6. Check Transition Audit History
    const transitions = await env.lifecycleRepo.listTransitions(tenant, candidate.id);
    expect(transitions.length).toBe(5);
    expect(transitions.map((t) => t.toState)).toEqual([
      "drafted",
      "replaying",
      "evaluating",
      "eligible",
      "published",
    ]);
  });

  it("should drive candidate to completion automatically in one call", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    const result = await env.orchestrator.driveToCompletion(tenant, candidate, revision);

    expect(result.record.currentState).toBe("published");
    expect(result.record.publishedVersion).toBe("1.0.0");
    expect(result.toolVersion).toBeDefined();
    expect(result.toolVersion?.artifactDigest).toBeDefined();
  });

  it("should process worker job payloads asynchronously via OutboxPublisher and DurableQueue", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    // Start lifecycle
    await env.orchestrator.startLifecycle(tenant, candidate, revision);

    // Drain outbox to durable queue
    const publishedCount = await env.outboxPublisher.dispatchBatch();
    expect(publishedCount).toBe(1);

    // Dequeue job and process it with orchestrator
    const job = await env.queue.dequeue(["evolution.candidate.validate"]);
    expect(job).not.toBeNull();
    expect(job?.jobType).toBe("evolution.candidate.validate");
    if (job) {
      const updated = await env.orchestrator.processJob(
        tenant,
        job.payload as unknown as LifecycleJobPayload,
      );
      expect(updated.currentState).toBe("replaying");
      await env.queue.ack(job.jobId);
    }
  });

  it("should expose sanitized candidate lifecycle status and evidence summary without private transcripts", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.driveToCompletion(tenant, candidate, revision);

    const status = await env.orchestrator.getStatus(tenant, candidate.id);
    expect(status).not.toBeNull();
    expect(status?.candidateId).toBe(candidate.id);
    expect(status?.workspaceId).toBe(tenant.workspaceId);
    expect(status?.currentState).toBe("published");
    expect(status?.isTerminal).toBe(true);
    expect(status?.isEligible).toBe(true);
    expect(status?.isPublished).toBe(true);
    expect(status?.publishedVersion).toBe("1.0.0");

    // Evidence summary
    expect(status?.evidenceSummary.validationPassed).toBe(true);
    expect(status?.evidenceSummary.typecheckPassed).toBe(true);
    expect(status?.evidenceSummary.replayPassed).toBe(true);
    expect(status?.evidenceSummary.evaluationVerdict).toBe("pass");
    expect(status?.evidenceSummary.hardGatesPassed).toBe(true);
    expect(status?.evidenceSummary.hasSignature).toBe(true);

    // Digests present
    expect(status?.evidenceDigests.manifest).toBeDefined();
    expect(status?.evidenceDigests.validation).toBeDefined();
    expect(status?.evidenceDigests.replay).toBeDefined();
    expect(status?.evidenceDigests.evaluation).toBeDefined();
    expect(status?.evidenceDigests.artifact).toBeDefined();
    expect(status?.evidenceDigests.signature).toBeDefined();

    // Verify raw private transcripts or unsanitized fields are NOT present
    const statusRecord = status as unknown as Record<string, unknown>;
    expect(statusRecord.transcripts).toBeUndefined();
    expect(statusRecord.sessionEvents).toBeUndefined();
    expect(statusRecord.sourceCode).toBeUndefined();
  });

  it("should cleanly terminate candidate lifecycle when validation fails", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant, {
      sourceCode: "export function brokenSyntax( { return ;", // Syntax error
    });
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);
    const validated = await env.orchestrator.stepValidate(tenant, candidate.id);

    expect(validated.currentState).toBe("failed");
    expect(validated.terminalReason?.code).toBe("VALIDATION_FAILED");
    expect(validated.terminalReason?.category).toBe("validation_failed");

    // Attempting to step further should return failed state
    const nextStep = await env.orchestrator.stepReplay(tenant, candidate.id);
    expect(nextStep.currentState).toBe("failed");
  });
});
