import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../../../src/tenant.js";
import {
  createMockCandidate,
  createMockRevision,
  createTestLifecycleEnvironment,
} from "./helpers.js";

describe("authoritative lifecycle composition", () => {
  it("standalone worker uses the shared CloudService composition root", async () => {
    const source = await readFile(new URL("../../../src/bin/worker.ts", import.meta.url), "utf8");
    expect(source).toContain("createCloudService");
    expect(source).not.toContain("Processing observation for tenant");
    expect(source).not.toContain("Running evaluation for tenant");
  });

  it("public publication no longer accepts caller bundle source", async () => {
    const source = await readFile(new URL("../../../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("parsedObj.bundleCode");
    expect(source).toContain("candidateLifecycleOrchestrator.driveToCompletion");
  });

  it("should enforce immutable revision and pinned evidence for manifest tamper", async () => {
    const tenant: TenantContext = {
      accountId: "acc_pub_pin_test",
      workspaceId: "ws_pub_pin_test",
    };
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

    // 1. Repository immutability: same revision ID with altered manifest must be rejected
    await expect(
      env.candidateRepo.saveRevision(tenant, {
        ...activeRev,
        artifacts: {
          ...activeRev.artifacts,
          manifest: {
            ...activeRev.artifacts.manifest,
            name: "tampered_manifest_tool",
            description: "tampered description for digest mismatch",
          },
        },
      }),
    ).rejects.toThrow(/Immutable revision violation/i);

    // Also verify source tamper same-ID is rejected for coverage
    await expect(
      env.candidateRepo.saveRevision(tenant, {
        ...activeRev,
        artifacts: {
          ...activeRev.artifacts,
          sourceCode: "export const malicious = true;",
        },
      }),
    ).rejects.toThrow(/Immutable revision violation/i);

    // Original revision remains intact
    const persisted = await env.candidateRepo.getRevisionById(tenant, activeRev.revisionId);
    expect(persisted?.artifacts.manifest.name).toBe(activeRev.artifacts.manifest.name);

    // 2. Publication pinning: distinct revision with tampered manifest cannot be published with old evidence
    const tamperedRevisionId = `${activeRev.revisionId}_tampered_mnf_${randomUUID().replace(/-/g, "").slice(0, 6)}`;
    const tamperedRevision = {
      ...activeRev,
      revisionId: tamperedRevisionId,
      revisionNumber: (activeRev.revisionNumber ?? 1) + 1,
      parentRevisionId: activeRev.revisionId,
      artifacts: {
        ...activeRev.artifacts,
        manifest: {
          ...activeRev.artifacts.manifest,
          name: "tampered_manifest_tool",
          description: "tampered description for digest mismatch",
        },
      },
    };
    const savedTampered = await env.candidateRepo.saveRevision(tenant, tamperedRevision);
    expect(savedTampered.revisionId).toBe(tamperedRevisionId);

    const lifecycleRecord = await env.lifecycleRepo.getLifecycle(tenant, candidate.id);
    expect(lifecycleRecord).not.toBeNull();
    expect(lifecycleRecord?.activeRevisionId).toBe(activeRev.revisionId);

    const tamperedPinnedRecord = {
      ...lifecycleRecord!,
      activeRevisionId: savedTampered.revisionId,
    };
    await env.lifecycleRepo.saveLifecycleRecord(tenant, tamperedPinnedRecord);

    await expect(env.orchestrator.stepPublish(tenant, candidate.id)).rejects.toThrow(
      /digest mismatch/i,
    );
  });
});
