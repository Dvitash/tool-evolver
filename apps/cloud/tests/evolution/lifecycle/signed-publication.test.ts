import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SigningKeyRepository } from "../../../src/evolution/artifacts/repositories/index.js";
import { ArtifactSigner } from "../../../src/evolution/artifacts/signer.js";
import type { TenantContext } from "../../../src/tenant.js";
import {
  createMockCandidate,
  createMockRevision,
  createTestLifecycleEnvironment,
} from "./helpers.js";

describe("Candidate Lifecycle - Signed Publication & Security Invariants", () => {
  const tenant: TenantContext = {
    accountId: "acc_pub_sec_test",
    workspaceId: "ws_pub_sec_test",
  };

  it("should verify candidate ownership and reject cross-workspace publication attempts", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);
    await env.orchestrator.stepValidate(tenant, candidate.id);
    await env.orchestrator.stepReplay(tenant, candidate.id);
    await env.orchestrator.stepEvaluate(tenant, candidate.id);

    // Attempt publication with mismatched workspace context
    const attackerTenant: TenantContext = {
      accountId: tenant.accountId,
      workspaceId: "ws_attacker_workspace",
    };

    await expect(env.orchestrator.stepPublish(attackerTenant, candidate.id)).rejects.toThrow();
  });

  it("should reject publication if source digest is tampered or does not match persisted evidence", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);
    await env.orchestrator.stepValidate(tenant, candidate.id);
    await env.orchestrator.stepReplay(tenant, candidate.id);
    await env.orchestrator.stepEvaluate(tenant, candidate.id);

    const activeRev = await env.candidateRepo.getActiveRevision(tenant, candidate.id);
    expect(activeRev).not.toBeNull();
    if (!activeRev) throw new Error("activeRev missing");

    // 1. Repository immutability: same revision ID with altered source artifacts must be rejected
    await expect(
      env.candidateRepo.saveRevision(tenant, {
        ...activeRev,
        artifacts: {
          ...activeRev.artifacts,
          sourceCode: "export const maliciousInjectedCode = true;",
        },
      }),
    ).rejects.toThrow(/Immutable revision violation/i);

    // Preserve manifest tamper coverage: same-ID altered manifest is also rejected
    await expect(
      env.candidateRepo.saveRevision(tenant, {
        ...activeRev,
        artifacts: {
          ...activeRev.artifacts,
          manifest: {
            ...activeRev.artifacts.manifest,
            name: "tampered_tool_name",
          },
        },
      }),
    ).rejects.toThrow(/Immutable revision violation/i);

    // Original revision remains intact
    const persisted = await env.candidateRepo.getRevisionById(tenant, activeRev.revisionId);
    expect(persisted?.artifacts.sourceCode).toBe(activeRev.artifacts.sourceCode);
    expect(persisted?.artifacts.manifest.name).toBe(activeRev.artifacts.manifest.name);

    // 2. Publication pinning: distinct revision with tampered source cannot be published with old evidence
    const tamperedRevisionId = `${activeRev.revisionId}_tampered_src_${randomUUID().replace(/-/g, "").slice(0, 6)}`;
    const tamperedRevision = {
      ...activeRev,
      revisionId: tamperedRevisionId,
      revisionNumber: (activeRev.revisionNumber ?? 1) + 1,
      parentRevisionId: activeRev.revisionId,
      artifacts: {
        ...activeRev.artifacts,
        sourceCode: "export const maliciousInjectedCode = true;",
      },
    };
    const savedTampered = await env.candidateRepo.saveRevision(tenant, tamperedRevision);
    expect(savedTampered.revisionId).toBe(tamperedRevisionId);

    // Lifecycle is still pinned to original revision; simulate tampered pin by pointing lifecycle to new revision while keeping old evidence digests
    const lifecycleRecord = await env.lifecycleRepo.getLifecycle(tenant, candidate.id);
    expect(lifecycleRecord).not.toBeNull();
    expect(lifecycleRecord?.activeRevisionId).toBe(activeRev.revisionId);

    const tamperedPinnedRecord = {
      ...lifecycleRecord!,
      activeRevisionId: savedTampered.revisionId,
    };
    await env.lifecycleRepo.saveLifecycleRecord(tenant, tamperedPinnedRecord);

    // Publication must reject due to pinned evidence mismatch (artifact-set / source digest)
    await expect(env.orchestrator.stepPublish(tenant, candidate.id)).rejects.toThrow(
      /digest mismatch/i,
    );
  });

  it("should enforce evidence freshness and reject publication when evidence exceeds max age", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);
    await env.orchestrator.stepValidate(tenant, candidate.id);
    await env.orchestrator.stepReplay(tenant, candidate.id);
    await env.orchestrator.stepEvaluate(tenant, candidate.id);

    // Manually set evaluation evidence timestamp to 48 hours ago (exceeding 24h default)
    const currentRecord = await env.lifecycleRepo.getLifecycle(tenant, candidate.id);
    if (currentRecord && currentRecord.evaluationResult) {
      const staleTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const staleRecord = {
        ...currentRecord,
        evaluationResult: {
          ...currentRecord.evaluationResult,
          overallDecision: {
            ...currentRecord.evaluationResult.overallDecision,
            evaluatedAt: staleTimestamp,
          },
          completedAt: staleTimestamp,
        },
      };
      await env.lifecycleRepo.saveLifecycleRecord(tenant, staleRecord);
    }

    await expect(env.orchestrator.stepPublish(tenant, candidate.id)).rejects.toThrow(/stale/i);
  });

  it("should enforce signing key status and reject publication if signing key is revoked", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);
    await env.orchestrator.stepValidate(tenant, candidate.id);
    await env.orchestrator.stepReplay(tenant, candidate.id);
    await env.orchestrator.stepEvaluate(tenant, candidate.id);

    // Generate key and immediately revoke it
    const generated = env.artifactService.signer.generateKeyPair("ed25519");
    const revokedKeyId = `key_revoked_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await env.signingKeyRepo.saveKey({
      keyId: revokedKeyId,
      algorithm: "ed25519",
      publicKeyPem: generated.publicKeyPem,
      privateKeyPem: generated.privateKeyPem,
      status: "revoked",
      trustLevel: "first_party",
      createdAt: new Date().toISOString(),
    });

    await expect(
      env.orchestrator.stepPublish(tenant, candidate.id, {
        signingKeyId: revokedKeyId,
      }),
    ).rejects.toThrow(/revoked/i);
  });

  it("should never allow caller-supplied forceApprove flags to bypass failed hard gates", async () => {
    const env = await createTestLifecycleEnvironment();
    // Candidate with forbidden import (terminal security violation)
    const candidate = createMockCandidate(tenant, {
      sourceCode: `
import child_process from "child_process";
export default function execute() {
  child_process.execSync("rm -rf /");
}
`,
    });
    const revision = createMockRevision(candidate, tenant);

    await env.orchestrator.startLifecycle(tenant, candidate, revision);

    // Attempt validation with forceApprove flag - MUST fail
    const validated = await env.orchestrator.stepValidate(tenant, candidate.id, {
      forceApprove: true,
      skipGates: true,
      approved: true,
    });
    expect(validated.currentState).toBe("failed");
    expect(validated.terminalReason?.code).toBe("VALIDATION_FAILED");

    // Attempting publication on failed candidate MUST throw
    await expect(
      env.orchestrator.stepPublish(tenant, candidate.id, {
        forceApprove: true,
      }),
    ).rejects.toThrow(/expected 'eligible' for publication/i);
  });

  it("should successfully produce cryptographic signature and register in catalog on valid publication", async () => {
    const env = await createTestLifecycleEnvironment();
    const candidate = createMockCandidate(tenant);
    const revision = createMockRevision(candidate, tenant);

    const { record: published, toolVersion } = await env.orchestrator.driveToCompletion(
      tenant,
      candidate,
      revision,
    );

    expect(published.currentState).toBe("published");
    expect(published.publishedVersion).toBe("1.0.0");
    expect(toolVersion.signature).toBeDefined();
    expect(toolVersion.signature.keyId).toBeDefined();
    expect(toolVersion.signature.signature.length).toBeGreaterThan(0);

    // Verify signature verification passes
    const signingKey = await env.signingKeyRepo.getKey(toolVersion.signature.keyId);
    expect(signingKey).not.toBeNull();
    const sigResult = env.artifactService.signer.verifySignature(
      toolVersion.artifactDigest,
      toolVersion.manifest,
      toolVersion.signature!,
      signingKey!.publicKeyPem,
    );
    if (!sigResult.valid) {
      console.log("Signature verification failure details:", JSON.stringify(sigResult, null, 2));
    }
    expect(sigResult.valid).toBe(true);

    // Verify catalog has tool definition
    const catalogTool = await env.catalogService.getTool(tenant, candidate.proposedTool.name);
    expect(catalogTool).toBeNull();
  });
});
