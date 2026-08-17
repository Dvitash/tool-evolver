import type { ToolVersion } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { createMockToolManifest, createTestArtifactEnvironment } from "./helpers.js";

describe("Artifact Repositories - Tool Registry & Signing Keys", () => {
  it("should manage logical tool records and active versions", async () => {
    const env = await createTestArtifactEnvironment();
    const tenant = { accountId: "acc_test", workspaceId: "ws_test" };

    const tool = await env.toolRegistryRepo.saveTool(tenant, {
      id: "tool_calc",
      name: "Calculator",
      description: "Basic calculator",
      activeVersion: "1.0.0",
    });

    expect(tool.id).toBe("tool_calc");
    expect(tool.activeVersion).toBe("1.0.0");

    const fetched = await env.toolRegistryRepo.getTool(tenant, "tool_calc");
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe("Calculator");

    await env.toolRegistryRepo.setActiveVersion(tenant, "tool_calc", "1.1.0");
    const updated = await env.toolRegistryRepo.getTool(tenant, "tool_calc");
    expect(updated?.activeVersion).toBe("1.1.0");

    const tools = await env.toolRegistryRepo.listTools(tenant);
    expect(tools.map((t) => t.id)).toContain("tool_calc");
  });

  it("should persist immutable tool versions and prevent mutation of existing versions with conflicting content", async () => {
    const env = await createTestArtifactEnvironment();
    const tenant = { accountId: "acc_test", workspaceId: "ws_test" };
    const manifest = createMockToolManifest({ version: "1.0.0" });

    const toolVersion: ToolVersion = {
      toolId: manifest.id,
      version: "1.0.0",
      manifestDigest: manifest.digest,
      artifactDigest: "sha256_initial_digest_000000000000000000000000000000000000000000000",
      manifest,
      artifact: {
        artifactDigest: "sha256_initial_digest_000000000000000000000000000000000000000000000",
        bundleReference: {
          uri: "storage://artifacts/bundle.tar",
          hash: "sha256_initial_digest_000000000000000000000000000000000000000000000",
          sizeBytes: 1024,
          format: "tar_gz",
        },
        entrypoint: "src/index.ts",
      },
      provenance: {
        synthesizedAt: "2026-08-17T00:00:00.000Z",
        synthesizerModel: "claude-3-7-sonnet",
        deterministicBuildHash: "hash_001",
        environment: {},
      },
      status: "active",
      createdAt: "2026-08-17T00:00:00.000Z",
      createdBy: "test",
    };

    await env.toolRegistryRepo.saveToolVersion(tenant, toolVersion);

    const retrieved = await env.toolRegistryRepo.getToolVersion(tenant, manifest.id, "1.0.0");
    expect(retrieved?.version).toBe("1.0.0");
    expect(retrieved?.artifactDigest).toBe(
      "sha256_initial_digest_000000000000000000000000000000000000000000000",
    );

    // Saving identical record is idempotent
    const sameRes = await env.toolRegistryRepo.saveToolVersion(tenant, toolVersion);
    expect(sameRes.artifactDigest).toBe(toolVersion.artifactDigest);

    // Attempting to overwrite existing version with different digest throws immutability error
    const conflictingVersion: ToolVersion = {
      ...toolVersion,
      artifactDigest: "sha256_tampered_different_digest_111111111111111111111111111111111",
    };

    await expect(env.toolRegistryRepo.saveToolVersion(tenant, conflictingVersion)).rejects.toThrow(
      /Immutable version conflict/,
    );
  });

  it("should handle version aliases and resolution", async () => {
    const env = await createTestArtifactEnvironment();
    const tenant = { accountId: "acc_test", workspaceId: "ws_test" };
    const manifest = createMockToolManifest({ version: "2.1.0" });

    const toolVersion: ToolVersion = {
      toolId: manifest.id,
      version: "2.1.0",
      manifestDigest: manifest.digest,
      artifactDigest: "sha256_digest_2_1_0",
      manifest,
      artifact: {
        artifactDigest: "sha256_digest_2_1_0",
        bundleReference: {
          uri: "storage://b.tar",
          hash: "sha256_digest_2_1_0",
          sizeBytes: 500,
          format: "tar_gz",
        },
        entrypoint: "src/index.ts",
      },
      provenance: {
        synthesizedAt: "2026-08-17T00:00:00.000Z",
        synthesizerModel: "model",
        deterministicBuildHash: "h",
        environment: {},
      },
      status: "active",
      createdAt: "2026-08-17T00:00:00.000Z",
      createdBy: "test",
    };

    await env.toolRegistryRepo.saveToolVersion(tenant, toolVersion);
    await env.toolRegistryRepo.setAlias(tenant, manifest.id, "stable", "2.1.0");

    const aliasVal = await env.toolRegistryRepo.getAlias(tenant, manifest.id, "stable");
    expect(aliasVal).toBe("2.1.0");

    const resolved = await env.toolRegistryRepo.resolveVersion(tenant, manifest.id, "stable");
    expect(resolved?.version).toBe("2.1.0");
  });

  it("should track publication records and lifecycle states", async () => {
    const env = await createTestArtifactEnvironment();
    const tenant = { accountId: "acc_test", workspaceId: "ws_test" };

    const record = await env.toolRegistryRepo.savePublicationRecord(tenant, {
      id: "pub_001",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      toolId: "tool_calc",
      version: "1.0.0",
      candidateId: "cand_001",
      state: "assembling",
      manifestDigest: "m_digest",
      artifactDigest: "a_digest",
      storageUri: "storage://artifacts/tool_calc/1.0.0/a_digest.tar",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    });

    expect(record.state).toBe("assembling");

    await env.toolRegistryRepo.updatePublicationState("pub_001", "published", {
      publishedAt: "2026-08-17T00:05:00.000Z",
    });

    const updated = await env.toolRegistryRepo.getPublicationRecord(tenant, "pub_001");
    expect(updated?.state).toBe("published");
    expect(updated?.publishedAt).toBe("2026-08-17T00:05:00.000Z");
  });

  it("should enumerate eligible rollback targets while filtering out revoked versions", async () => {
    const env = await createTestArtifactEnvironment();
    const tenant = { accountId: "acc_test", workspaceId: "ws_test" };
    const toolId = "tool_rollback_test";

    const createVersion = (
      version: string,
      status: "active" | "deprecated" | "revoked",
    ): ToolVersion => {
      const manifest = createMockToolManifest({ id: toolId, version });
      return {
        toolId,
        version,
        manifestDigest: manifest.digest,
        artifactDigest: `digest_${version}`,
        manifest,
        artifact: {
          artifactDigest: `digest_${version}`,
          bundleReference: {
            uri: `storage://${version}.tar`,
            hash: `digest_${version}`,
            sizeBytes: 100,
            format: "tar_gz",
          },
          entrypoint: "src/index.ts",
        },
        provenance: {
          synthesizedAt: "2026-08-17T00:00:00.000Z",
          synthesizerModel: "model",
          deterministicBuildHash: "h",
          environment: {},
        },
        status,
        createdAt: `2026-08-17T0${version.slice(0, 1)}:00:00.000Z`,
        createdBy: "test",
      };
    };

    await env.toolRegistryRepo.saveToolVersion(tenant, createVersion("1.0.0", "deprecated"));
    await env.toolRegistryRepo.saveToolVersion(tenant, createVersion("1.1.0", "deprecated"));
    await env.toolRegistryRepo.saveToolVersion(tenant, createVersion("1.2.0", "revoked")); // Should NOT be eligible
    await env.toolRegistryRepo.saveToolVersion(tenant, createVersion("1.3.0", "active"));

    const rollbackTargets = await env.toolRegistryRepo.getEligibleRollbackTargets(tenant, toolId);
    const versions = rollbackTargets.map((v) => v.version);

    expect(versions).toContain("1.3.0");
    expect(versions).toContain("1.1.0");
    expect(versions).toContain("1.0.0");
    expect(versions).not.toContain("1.2.0");
  });
});
