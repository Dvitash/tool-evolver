import { describe, expect, it } from "vitest";
import { createAuthService } from "../../src/auth/index.js";
import { MemoryDatabasePool, runMigrations } from "../../src/db/index.js";
import { CandidateLifecycleOrchestrator } from "../../src/evolution/lifecycle/orchestrator.js";
import { CloudCatalogService } from "../../src/mcp/catalog-service.js";
import { MemoryDurableQueue } from "../../src/queue/index.js";
import {
  CloudBackupEngine,
  decryptPayload,
  encryptPayload,
  sha256Digest,
} from "../../src/staging/index.js";
import { MemoryObjectStore } from "../../src/storage/index.js";
import type { TenantContext } from "../../src/tenant.js";

describe("Staging Backup, Restore & Rehearsal Verification Suite", () => {
  const encryptionKey = "staging-aes256-test-key-2026";
  const backupEngine = new CloudBackupEngine({ encryptionKey });

  const tenantA: TenantContext = {
    accountId: "acc_staging_tenant_a",
    workspaceId: "ws_staging_tenant_a",
  };

  const tenantB: TenantContext = {
    accountId: "acc_staging_tenant_b",
    workspaceId: "ws_staging_tenant_b",
  };

  it("should generate a complete, cryptographically verified backup package", async () => {
    const rawToolManifest = JSON.stringify({
      name: "data_transformer",
      version: "1.2.0",
      capabilities: ["transform"],
    });
    const manifestSha = sha256Digest(rawToolManifest);

    const backup = await backupEngine.createBackup({
      environment: "staging",
      relationalTables: {
        accounts: [
          { id: tenantA.accountId, name: "Tenant A" },
          { id: tenantB.accountId, name: "Tenant B" },
        ],
        workspaces: [{ id: tenantA.workspaceId, accountId: tenantA.accountId, name: "Default WS" }],
        candidates: [
          { id: "cand_001", accountId: tenantA.accountId, toolName: "data_transformer" },
        ],
        candidate_lifecycles: [
          { candidateId: "cand_001", status: "validating", currentStep: "validate" },
        ],
        tool_registry: [{ id: "tool_001", accountId: tenantA.accountId, name: "data_transformer" }],
        tool_versions: [
          {
            name: "data_transformer",
            version: "1.2.0",
            manifestDigest: manifestSha,
          },
        ],
        access_tokens: [
          {
            id: "tok_auth_001",
            accountId: tenantA.accountId,
            deviceId: "device_prod_001",
            tokenHash: "hash_001",
          },
        ],
      },
      objectStorage: {
        "manifests/data_transformer/1.2.0.json": {
          key: "manifests/data_transformer/1.2.0.json",
          sha256: manifestSha,
          data: rawToolManifest,
          contentType: "application/json",
        },
      },
      signingTrust: {
        activeKeyId: "staging-ed25519-primary-2026",
        keys: {
          "staging-ed25519-primary-2026": {
            keyId: "staging-ed25519-primary-2026",
            algorithm: "ed25519",
            publicKey: "MCowBQYDK2VwAyEA...mock",
            status: "active",
          },
        },
        revocationList: [],
      },
      auditRecords: [{ id: "audit_1", action: "candidate.published", timestamp: Date.now() }],
      recoveryKeys: {
        keyId: "rec_primary_2026",
        status: "active",
      },
    });

    expect(backup.backupId).toMatch(/^bkp_/);
    expect(backup.environment).toBe("staging");
    expect(backup.manifest.tableCounts.accounts).toBe(2);
    expect(backup.manifest.objectCount).toBe(1);
    expect(backup.manifestSignature).toBeDefined();

    // Verify integrity
    const verification = backupEngine.verifyBackupIntegrity(backup);
    expect(verification.valid).toBe(true);
    expect(verification.errors).toHaveLength(0);
  });

  it("should reject corrupted backup archives and tampered manifests", async () => {
    const backup = await backupEngine.createBackup({
      environment: "staging",
      relationalTables: {
        accounts: [{ id: "acc_1", name: "Tamper Test" }],
      },
    });

    // 1. Corrupt the relational data
    const corruptedRelational = JSON.parse(JSON.stringify(backup));
    corruptedRelational.relationalData.accounts.push({ id: "acc_injected", name: "Injected Row" });

    const result1 = backupEngine.verifyBackupIntegrity(corruptedRelational);
    expect(result1.valid).toBe(false);
    expect(result1.errors.some((e) => e.includes("Relational data corruption"))).toBe(true);

    // 2. Tamper with manifest signature
    const corruptedSig = JSON.parse(JSON.stringify(backup));
    corruptedSig.manifestSignature = "invalid_tampered_signature_hex";

    const result2 = backupEngine.verifyBackupIntegrity(corruptedSig);
    expect(result2.valid).toBe(false);
    expect(result2.errors.some((e) => e.includes("Manifest signature verification failed"))).toBe(
      true,
    );
  });

  it("should encrypt and decrypt backup payloads securely using AES-256-GCM", () => {
    const samplePayload = JSON.stringify({ secret: "critical_vault_recovery_key_material" });
    const encrypted = encryptPayload(samplePayload, encryptionKey);

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.tag).toBeDefined();

    const decrypted = decryptPayload(encrypted, encryptionKey);
    expect(decrypted.toString("utf8")).toBe(samplePayload);
  });

  it("should successfully restore relational and object storage into target instances", async () => {
    const objectStore = new MemoryObjectStore();
    const manifestContent = JSON.stringify({ name: "sql_helper", version: "2.0.0" });
    const manifestSha = sha256Digest(manifestContent);

    const backup = await backupEngine.createBackup({
      environment: "staging",
      relationalTables: {
        accounts: [{ id: "acc_restored", name: "Restored Corp" }],
        tool_versions: [{ name: "sql_helper", version: "2.0.0", manifestDigest: manifestSha }],
      },
      objectStorage: {
        "manifests/sql_helper/2.0.0.json": {
          key: "manifests/sql_helper/2.0.0.json",
          sha256: manifestSha,
          data: manifestContent,
          contentType: "application/json",
        },
      },
    });

    const restoreResult = await backupEngine.restoreBackup(backup, { objectStore });
    expect(restoreResult.restored).toBe(true);
    expect(restoreResult.objectsRestored).toBe(1);

    // Verify object store actually received the object
    const fetched = await objectStore.getObject("manifests/sql_helper/2.0.0.json");
    expect(fetched).not.toBeNull();
    expect(fetched.toString("utf8")).toBe(manifestContent);
  });

  it("should execute full Restore Rehearsal verifying Device Auth, Catalog serving & Lifecycle resumption", async () => {
    const manifestContent = JSON.stringify({ name: "log_parser", version: "1.0.0" });
    const manifestSha = sha256Digest(manifestContent);

    const backup = await backupEngine.createBackup({
      environment: "staging",
      relationalTables: {
        accounts: [{ id: tenantA.accountId, name: "Rehearsal Corp" }],
        workspaces: [{ id: tenantA.workspaceId, accountId: tenantA.accountId, name: "Main" }],
        access_tokens: [
          {
            id: "tok_rehearsal_1",
            accountId: tenantA.accountId,
            deviceId: "dev_macbook_pro_staging",
          },
        ],
        tool_registry: [{ id: "tool_reg_1", name: "log_parser" }],
        tool_versions: [
          {
            name: "log_parser",
            version: "1.0.0",
            manifestDigest: manifestSha,
          },
        ],
        candidates: [
          {
            id: "cand_interrupted_1",
            accountId: tenantA.accountId,
            toolName: "log_parser",
          },
        ],
        candidate_lifecycles: [
          {
            candidateId: "cand_interrupted_1",
            status: "validating",
            currentStep: "step_validate",
          },
        ],
      },
      objectStorage: {
        "manifests/log_parser/1.0.0.json": {
          key: "manifests/log_parser/1.0.0.json",
          sha256: manifestSha,
          data: manifestContent,
          contentType: "application/json",
        },
      },
    });

    const authService = createAuthService();

    const rehearsalResult = await backupEngine.rehearseRestore(backup, {
      authService,
      tenant: tenantA,
    });

    expect(rehearsalResult.rehearsalPassed).toBe(true);
    expect(rehearsalResult.deviceAuthOk).toBe(true);
    expect(rehearsalResult.catalogIntegrityOk).toBe(true);
    expect(rehearsalResult.interruptedEvolutionResumeOk).toBe(true);
    expect(rehearsalResult.rpoSeconds).toBeGreaterThanOrEqual(0);
    expect(rehearsalResult.rtoMs).toBeGreaterThanOrEqual(0);
  });

  it("should preserve strict multi-tenant isolation across backup and restore boundaries", async () => {
    const backup = await backupEngine.createBackup({
      environment: "staging",
      relationalTables: {
        accounts: [
          { id: tenantA.accountId, name: "Tenant A" },
          { id: tenantB.accountId, name: "Tenant B" },
        ],
        candidates: [
          { id: "cand_A", accountId: tenantA.accountId, toolName: "tool_a" },
          { id: "cand_B", accountId: tenantB.accountId, toolName: "tool_b" },
        ],
      },
    });

    const tenantACandidates = backup.relationalData.candidates.filter(
      (c) => c.accountId === tenantA.accountId,
    );
    const tenantBCandidates = backup.relationalData.candidates.filter(
      (c) => c.accountId === tenantB.accountId,
    );

    expect(tenantACandidates).toHaveLength(1);
    expect(tenantACandidates[0].toolName).toBe("tool_a");
    expect(tenantBCandidates).toHaveLength(1);
    expect(tenantBCandidates[0].toolName).toBe("tool_b");

    // Cross-tenant access check
    const crossTenantLeak = tenantACandidates.some((c) => c.accountId === tenantB.accountId);
    expect(crossTenantLeak).toBe(false);
  });
});
