import { describe, expect, it } from "vitest";
import {
  CandidateDigestMismatchError,
  CandidateIneligibleError,
  SigningKeyRevokedError,
  ToolVersionNotFoundError,
  ToolVersionRevokedError,
} from "../../../src/evolution/artifacts/service.js";
import { TenantAccessDeniedError, runWithTenant } from "../../../src/tenant.js";
import {
  createMockEvaluationResult,
  createMockEvolutionCandidate,
  createMockToolManifest,
  createTestArtifactEnvironment,
} from "./helpers.js";

describe("ToolArtifactRegistryService - End-to-End Publication & Version Registry", () => {
  it("should publish an eligible candidate into an immutable, signed, content-addressed bundle and enqueue outbox event", async () => {
    const env = await createTestArtifactEnvironment();
    const manifest = createMockToolManifest({ version: "1.0.0" });
    const candidate = createMockEvolutionCandidate({ proposedTool: manifest });
    const evaluation = createMockEvaluationResult(candidate);

    const publishedVersion = await env.service.publishCandidate(candidate, evaluation);

    expect(publishedVersion).toBeDefined();
    expect(publishedVersion.toolId).toBe(candidate.proposedTool.id);
    expect(publishedVersion.version).toBe("1.0.0");
    expect(publishedVersion.status).toBe("draft");
    expect(publishedVersion.signature).toBeDefined();
    expect(publishedVersion.signature?.algorithm).toBe("ed25519");
    expect(publishedVersion.signature?.signature).toBeDefined();
    expect(publishedVersion.provenance).toBeDefined();
    expect(publishedVersion.provenance.sourceCandidateId).toBe(candidate.id);

    // Verify artifact stored in ObjectStore
    const storageKey = `artifacts/${candidate.workspaceId}/${candidate.proposedTool.id}/1.0.0/${publishedVersion.artifactDigest}.tar`;
    const objectExists = await env.objectStore.exists(storageKey);
    expect(objectExists).toBe(true);

    // Verify outbox event enqueued
    const outboxRes = await env.pool.query(
      `SELECT * FROM outbox WHERE aggregate_type = 'tool_version' AND event_type = 'tool.version.published'`,
    );
    expect(outboxRes.rows.length).toBeGreaterThanOrEqual(1);

    // Verify tool metadata and aliases
    const tool = await env.toolRegistryRepo.getTool(
      { workspaceId: candidate.workspaceId },
      candidate.proposedTool.id,
    );
    expect(tool?.activeVersion).toBeUndefined();

    const latestAlias = await env.toolRegistryRepo.getAlias(
      { workspaceId: candidate.workspaceId },
      candidate.proposedTool.id,
      "latest",
    );
    expect(latestAlias).toBe("1.0.0");
  });

  it("should reject publication of ineligible candidates (failed verdict, failed security gate, or invalid state)", async () => {
    const env = await createTestArtifactEnvironment();
    const candidate = createMockEvolutionCandidate();

    // 1. Failed evaluation verdict
    const failedEval = createMockEvaluationResult(candidate, {
      overallDecision: {
        verdict: "fail",
        score: 0.4,
        confidence: 0.9,
        threshold: 0.8,
        notes: "Failed benchmarks",
        evaluatedBy: "eval-v1",
        evaluatedAt: "2026-08-17T00:00:00.000Z",
      },
    });

    await expect(env.service.publishCandidate(candidate, failedEval)).rejects.toThrow(
      CandidateIneligibleError,
    );

    // 2. Failed security dimension gate
    const securityFailedEval = createMockEvaluationResult(candidate, {
      dimensions: [
        {
          name: "security",
          weight: 0.5,
          score: 0,
          threshold: 1.0,
          passed: false,
          details: "Potential shell injection vulnerability detected",
        },
      ],
    });

    await expect(env.service.publishCandidate(candidate, securityFailedEval)).rejects.toThrow(
      CandidateIneligibleError,
    );

    // 3. Rejected candidate state
    const rejectedCandidate = createMockEvolutionCandidate({ state: "rejected" });
    const normalEval = createMockEvaluationResult(rejectedCandidate);
    await expect(env.service.publishCandidate(rejectedCandidate, normalEval)).rejects.toThrow(
      CandidateIneligibleError,
    );
  });

  it("should reject publication on digest-mismatched candidate manifest", async () => {
    const env = await createTestArtifactEnvironment();
    const manifest = createMockToolManifest();
    const tamperedManifest = {
      ...manifest,
      digest: "sha256_fake_tampered_digest_00000000000000000000000000000000000000000",
    };
    const candidate = createMockEvolutionCandidate({ proposedTool: tamperedManifest });
    const evaluation = createMockEvaluationResult(candidate);

    await expect(env.service.publishCandidate(candidate, evaluation)).rejects.toThrow(
      CandidateDigestMismatchError,
    );
  });

  it("should automatically classify version increments across iterative publications", async () => {
    const env = await createTestArtifactEnvironment();

    // 1. Initial publication (1.0.0)
    const initialManifest = createMockToolManifest({ version: "1.0.0" });
    const initialCandidate = createMockEvolutionCandidate({
      id: "cand_v1",
      proposedTool: initialManifest,
    });
    const eval1 = createMockEvaluationResult(initialCandidate);
    const v1 = await env.service.publishCandidate(initialCandidate, eval1);
    expect(v1.version).toBe("1.0.0");

    // 2. Minor bump: adding optional parameter
    const minorManifest = createMockToolManifest({
      version: "1.0.0",
      parameters: {
        type: "object",
        properties: {
          ...initialManifest.parameters?.properties,
          roundResult: { type: "boolean", description: "Round result to nearest integer" },
        },
        required: ["operation", "a", "b"], // roundResult is optional
      },
    });
    const minorCandidate = createMockEvolutionCandidate({
      id: "cand_v2",
      proposedTool: minorManifest,
    });
    const eval2 = createMockEvaluationResult(minorCandidate);
    const v2 = await env.service.publishCandidate(minorCandidate, eval2);
    expect(v2.version).toBe("1.1.0");

    // 3. Major bump: removing existing parameter 'operation'
    const majorManifest = createMockToolManifest({
      version: "1.1.0",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
    });
    const majorCandidate = createMockEvolutionCandidate({
      id: "cand_v3",
      proposedTool: majorManifest,
    });
    const eval3 = createMockEvaluationResult(majorCandidate);
    const v3 = await env.service.publishCandidate(majorCandidate, eval3);
    expect(v3.version).toBe("2.0.0");
  });

  it("should reject publication if signing key is revoked", async () => {
    const env = await createTestArtifactEnvironment();
    const manifest = createMockToolManifest();
    const candidate = createMockEvolutionCandidate({ proposedTool: manifest });
    const evaluation = createMockEvaluationResult(candidate);

    // Register and revoke key
    const key = env.signer.generateKeyPair("ed25519");
    await env.signingKeyRepo.saveKey(key);
    await env.signingKeyRepo.revokeKey(key.keyId, "Security test");

    await expect(
      env.service.publishCandidate(candidate, evaluation, { keyId: key.keyId }),
    ).rejects.toThrow(SigningKeyRevokedError);
  });

  it("should support tenant-isolated artifact downloads and reject cross-tenant access", async () => {
    const env = await createTestArtifactEnvironment();
    const manifest = createMockToolManifest({ version: "1.0.0" });
    const candidate = createMockEvolutionCandidate({
      workspaceId: "ws_tenant_alpha",
      proposedTool: manifest,
    });
    const evaluation = createMockEvaluationResult(candidate);

    const published = await env.service.publishCandidate(candidate, evaluation);

    // Same workspace download succeeds
    const download = await env.service.downloadArtifact(
      published.toolId,
      "1.0.0",
      "ws_tenant_alpha",
      { accountId: "acc_tenant_alpha" },
    );
    expect(download).toBeDefined();
    expect(download.digest).toBe(published.artifactDigest);
    expect(download.sizeBytes).toBeGreaterThan(0);

    // Cross-tenant context check
    await expect(
      runWithTenant({ accountId: "acc_tenant_beta", workspaceId: "ws_tenant_beta" }, async () => {
        return env.service.downloadArtifact(published.toolId, "1.0.0", "ws_tenant_alpha", {
          accountId: "acc_tenant_alpha",
        });
      }),
    ).rejects.toThrow(TenantAccessDeniedError);

    // Non-existent version throws ToolVersionNotFoundError
    await expect(
      env.service.downloadArtifact("tool_calc", "9.9.9", "ws_tenant_alpha", {
        accountId: "acc_tenant_alpha",
      }),
    ).rejects.toThrow(ToolVersionNotFoundError);
  });

  it("should reject downloading revoked versions unless allowRevoked is explicitly set", async () => {
    const env = await createTestArtifactEnvironment();
    const manifest = createMockToolManifest({ version: "1.0.0" });
    const candidate = createMockEvolutionCandidate({
      workspaceId: "ws_test",
      proposedTool: manifest,
    });
    const evaluation = createMockEvaluationResult(candidate);

    const published = await env.service.publishCandidate(candidate, evaluation);

    // Revoke the version
    await env.toolRegistryRepo.setVersionStatus(
      { accountId: "acc_test", workspaceId: "ws_test" },
      published.toolId,
      published.version,
      "revoked",
    );

    // Attempt download without allowRevoked
    await expect(
      env.service.downloadArtifact(published.toolId, "1.0.0", "ws_test", { accountId: "acc_test" }),
    ).rejects.toThrow(ToolVersionRevokedError);

    // Download with allowRevoked succeeds
    const download = await env.service.downloadArtifact(published.toolId, "1.0.0", "ws_test", {
      accountId: "acc_test",
      allowRevoked: true,
    });
    expect(download.digest).toBe(published.artifactDigest);
  });

  it("should enumerate tenant-isolated rollback targets", async () => {
    const env = await createTestArtifactEnvironment();
    const toolId = "tool_rollback_flow";
    const workspaceId = "ws_flow";

    // Publish v1.0.0
    const cand1 = createMockEvolutionCandidate({
      workspaceId,
      proposedTool: createMockToolManifest({ id: toolId, version: "1.0.0" }),
    });
    await env.service.publishCandidate(cand1, createMockEvaluationResult(cand1));

    // Publish v1.1.0 (supersedes v1.0.0, deprecating v1.0.0)
    const cand2 = createMockEvolutionCandidate({
      workspaceId,
      proposedTool: createMockToolManifest({
        id: toolId,
        version: "1.0.0",
        parameters: {
          type: "object",
          properties: {
            ...cand1.proposedTool.parameters?.properties,
            extra: { type: "string" },
          },
          required: ["operation", "a", "b"],
        },
      }),
    });
    await env.service.publishCandidate(cand2, createMockEvaluationResult(cand2));

    const rollbackTargets = await env.service.getEligibleRollbackTargets(toolId, workspaceId);
    expect(rollbackTargets).toEqual([]);
  });
});
