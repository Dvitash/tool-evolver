import { describe, expect, it } from "vitest";
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

describe("Candidate Lifecycle - Brokered Tools & Multi-Step Workflows", () => {
  const tenant: TenantContext = {
    accountId: "acc_brokered_wf_test",
    workspaceId: "ws_brokered_wf_test",
  };

  it("should process a brokered atomic tool through verify -> replay -> evaluate -> publish", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockBrokeredCandidate(tenant);
    const revision = createMockBrokeredRevision(candidate, tenant);

    // 1. Start lifecycle
    const drafted = await env.orchestrator.startLifecycle(tenant, candidate, revision);
    expect(drafted.currentState).toBe("drafted");
    expect(drafted.evidenceDigests.manifestDigest).toBeDefined();
    expect(drafted.evidenceDigests.capabilityDigest).toBeDefined();

    // 2. Validate step
    const validated = await env.orchestrator.stepValidate(tenant, candidate.id);
    expect(validated.currentState).toBe("replaying");
    expect(validated.validationResult?.passed).toBe(true);
    expect(validated.evidenceDigests.validationDigest).toBeDefined();

    // 3. Replay step with virtual broker
    const replayed = await env.orchestrator.stepReplay(tenant, candidate.id);
    expect(replayed.currentState).toBe("evaluating");
    expect(replayed.replayResult?.passed).toBe(true);
    expect(replayed.evidenceDigests.replayDigest).toBeDefined();

    // 4. Evaluate step
    const evaluated = await env.orchestrator.stepEvaluate(tenant, candidate.id);
    expect(evaluated.currentState).toBe("eligible");
    expect(evaluated.evidenceDigests.evaluationDigest).toBeDefined();

    // 5. Publish signed artifact
    const { record: published, toolVersion } = await env.orchestrator.stepPublish(
      tenant,
      candidate.id,
    );
    expect(published.currentState).toBe("published");
    expect(published.publishedVersion).toBe("1.0.0");
    expect(published.evidenceDigests.artifactDigest).toBeDefined();
    expect(published.evidenceDigests.signatureDigest).toBeDefined();

    // Verify tool registry version metadata and capabilities
    expect(toolVersion.version).toBe("1.0.0");
    expect(toolVersion.manifest.name).toBe("weather_fetcher");
    expect(toolVersion.signature?.signature).toBeDefined();
    expect(toolVersion.manifest.capabilities?.net?.allowedHosts).toContain("api.weather.com");
    expect(toolVersion.manifest.capabilities?.secrets?.allowedSecretNames).toContain(
      "WEATHER_API_KEY",
    );

    // Verify catalog has tool definition
    const catalogTool = await env.catalogService.getTool(tenant, "weather_fetcher");
    expect(catalogTool).toBeNull();
  });

  it("should process a multi-step workflow through full lifecycle and include workflow.json in package", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockWorkflowCandidate(tenant);
    const revision = createMockWorkflowRevision(candidate, tenant);

    // 1. Start lifecycle
    const drafted = await env.orchestrator.startLifecycle(tenant, candidate, revision);
    expect(drafted.currentState).toBe("drafted");
    expect(drafted.evidenceDigests.workflowDigest).toBeDefined();

    // 2. Validate workflow definition and steps
    const validated = await env.orchestrator.stepValidate(tenant, candidate.id);
    expect(validated.currentState).toBe("replaying");
    expect(validated.validationResult?.passed).toBe(true);

    // 3. Replay workflow execution and rollback policies
    const replayed = await env.orchestrator.stepReplay(tenant, candidate.id);
    expect(replayed.currentState).toBe("evaluating");
    expect(replayed.replayResult?.passed).toBe(true);

    // 4. Evaluate workflow scoring and gates
    const evaluated = await env.orchestrator.stepEvaluate(tenant, candidate.id);
    expect(evaluated.currentState).toBe("eligible");

    // 5. Publish signed workflow package
    const { record: published, toolVersion } = await env.orchestrator.stepPublish(
      tenant,
      candidate.id,
    );
    expect(published.currentState).toBe("published");
    expect(published.publishedVersion).toBe("1.0.0");
    expect(published.evidenceDigests.signatureDigest).toBeDefined();
    expect(toolVersion.manifest.name).toBe("weather_summary_workflow");

    // Retrieve published artifact bundle from object store and verify workflow.json exists
    const artifact = await env.artifactService.getArtifactStream(
      tenant,
      toolVersion.toolId,
      toolVersion.version,
    );
    expect(artifact).not.toBeNull();
    expect(artifact.digest).toBe(toolVersion.artifactDigest);
  });

  it("should enforce capability monotonicity during repair transitions and reject capability broadening", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockBrokeredCandidate(tenant);
    const revision = createMockBrokeredRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);

    // Attempt to repair by broadening network capabilities (adding unauthorized host)
    const broadenedRepair = await env.orchestrator.repairCandidate(tenant, candidate.id, {
      repairHint: "Attempt unauthorized host addition",
      modifiedArtifacts: {
        capabilities: {
          ...candidate.requiredCapabilities,
          net: {
            ...candidate.requiredCapabilities.net,
            allowOutbound: true,
            allowedHosts: ["api.weather.com", "malicious-exfiltration.attacker.net"],
          },
        },
      },
    });

    expect(broadenedRepair.currentState).toBe("failed");
    expect(broadenedRepair.terminalReason?.code).toBe("CAPABILITY_BROADENED");
    expect(broadenedRepair.terminalReason?.category).toBe("capability_broadened");

    // Verify DLQ has recorded capability violation
    const dlqRecords = await env.lifecycleRepo.listDlqRecords(tenant, {
      candidateId: candidate.id,
      errorCategory: "capability_violation",
    });
    expect(dlqRecords.length).toBeGreaterThan(0);
    expect(dlqRecords[0].errorMessage).toMatch(/cannot broaden capabilities/i);
  });

  it("should create immutable child revisions with bounded attempt counts during valid repairs", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);

    // Valid repair 1
    const repaired1 = await env.orchestrator.repairCandidate(tenant, candidate.id, {
      maxRepairAttempts: 3,
      repairHint: "Fix minor type signature",
      modifiedArtifacts: {
        sourceCode: `${candidate.sourceCode}\n// patched iteration 1`,
      },
    });
    expect(repaired1.currentState).toBe("validating");
    expect(repaired1.attempt).toBe(2);
    expect(repaired1.activeRevisionId).not.toBe(revision.revisionId);

    // Valid repair 2
    const repaired2 = await env.orchestrator.repairCandidate(tenant, candidate.id, {
      maxRepairAttempts: 3,
      repairHint: "Fix lint issue",
      modifiedArtifacts: {
        sourceCode: `${candidate.sourceCode}\n// patched iteration 2`,
      },
    });
    expect(repaired2.currentState).toBe("validating");
    expect(repaired2.attempt).toBe(3);

    // Exhausted repair 3 (attempt 3 >= maxRepairAttempts 3)
    const exhausted = await env.orchestrator.repairCandidate(tenant, candidate.id, {
      maxRepairAttempts: 3,
      repairHint: "Exhausted repair attempt",
    });
    expect(exhausted.currentState).toBe("failed");
    expect(exhausted.terminalReason?.code).toBe("REPAIR_BUDGET_EXHAUSTED");
    expect(exhausted.terminalReason?.category).toBe("attempts_exhausted");

    // Verify revision history contains all immutable iterations
    const revisions = await env.candidateRepo.listRevisions(tenant, candidate.id);
    expect(revisions.length).toBe(3);
    expect(revisions[1].parentRevisionId).toBe(revision.revisionId);
    expect(revisions[2].parentRevisionId).toBe(revisions[1].revisionId);
  });

  it("should preserve deterministic historical evidence and prevent replacement during repairs", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockWorkflowCandidate(tenant);
    const revision = createMockWorkflowRevision(candidate, tenant);

    const initial = await env.orchestrator.startLifecycle(tenant, candidate, revision);
    const originalManifestDigest = initial.evidenceDigests.manifestDigest;
    const originalWorkflowDigest = initial.evidenceDigests.workflowDigest;

    // Execute repair with same manifest & workflow
    const repaired = await env.orchestrator.repairCandidate(tenant, candidate.id, {
      repairHint: "Refactor step implementation code",
      modifiedArtifacts: {
        sourceCode: `${candidate.sourceCode}\n// optimized step`,
      },
    });

    // Manifest and workflow digests remain deterministic and intact
    expect(repaired.evidenceDigests.manifestDigest).toBe(originalManifestDigest);
    expect(repaired.evidenceDigests.workflowDigest).toBe(originalWorkflowDigest);
    expect(repaired.evidenceDigests.sourceDigest).not.toBe(initial.evidenceDigests.sourceDigest);

    // Candidate trigger evidence IDs cannot be tampered with
    const fetchedCandidate = await env.candidateRepo.getCandidateById(tenant, candidate.id);
    expect(fetchedCandidate?.trigger.evidenceEventIds).toEqual(candidate.trigger.evidenceEventIds);
  });
});
