import { describe, expect, it } from "vitest";
import type { OpportunityDetection } from "../../../src/evolution/opportunity/types.js";
import { TenantGuard, TenantMismatchError } from "../../../src/tenant.js";
import {
  TEST_ACCOUNT_ID,
  TEST_TENANT,
  TEST_WORKSPACE_ID,
  createMockOpportunity,
  createTestOpportunityEnvironment,
} from "./helpers.js";

describe("OpportunityRepository - PostgreSQL Persistence & Outbox Publication", () => {
  it("should persist, retrieve, and list opportunities with full schema fidelity", async () => {
    const env = await createTestOpportunityEnvironment();
    const mockOpp = createMockOpportunity({
      id: "opp_persist_001",
      structuralHash: "sha256_struct_001",
      idempotencyKey: "opp_ik_001",
      occurrenceCount: 5,
      distinctSessionCount: 3,
      evidenceEventIds: ["evt_1", "evt_2", "evt_3", "evt_4", "evt_5"],
    });

    const saved = await env.repository.saveOpportunity(TEST_TENANT, mockOpp);
    expect(saved.id).toBe("opp_persist_001");
    expect(saved.workspaceId).toBe(TEST_WORKSPACE_ID);
    expect(saved.occurrenceCount).toBe(5);
    expect(saved.distinctSessionCount).toBe(3);
    expect(saved.evidenceEventIds).toEqual(["evt_1", "evt_2", "evt_3", "evt_4", "evt_5"]);
    expect(saved.classification.suggestedToolName).toBe("batch_csv_converter");

    // Fetch by ID
    const retrieved = await env.repository.getOpportunityById(TEST_TENANT, "opp_persist_001");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("opp_persist_001");
    expect(retrieved?.structuralHash).toBe("sha256_struct_001");
    expect(retrieved?.metrics.totalDurationMs).toBe(4500);

    // List opportunities
    const list = await env.repository.listOpportunities(TEST_TENANT);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("opp_persist_001");
  });

  it("should enforce idempotency and preserve immutable deterministic fields on duplicate save", async () => {
    const env = await createTestOpportunityEnvironment();
    const original = createMockOpportunity({
      id: "opp_idemp_001",
      structuralHash: "sha256_idemp_001",
      idempotencyKey: "opp_ik_idemp_001",
      occurrenceCount: 3,
      metrics: {
        totalDurationMs: 3000,
        avgDurationMs: 1000,
        totalTokens: 500,
        totalRetries: 0,
        totalCostUsd: 0.001,
      },
    });

    const firstSave = await env.repository.saveOpportunity(TEST_TENANT, original);
    expect(firstSave.id).toBe("opp_idemp_001");
    expect(firstSave.occurrenceCount).toBe(3);

    // Attempt to overwrite with altered metrics / model enrichment
    const altered = createMockOpportunity({
      id: "opp_idemp_001",
      structuralHash: "sha256_idemp_001",
      idempotencyKey: "opp_ik_idemp_001",
      occurrenceCount: 999, // Should NOT overwrite
      metrics: {
        totalDurationMs: 999999,
        avgDurationMs: 999999,
        totalTokens: 999999,
        totalRetries: 99,
        totalCostUsd: 99.99,
      },
      classification: {
        title: "Altered Title",
        description: "Altered Description",
        taskClass: "altered",
        pattern: "altered",
        confidenceScore: 0.1,
        priority: "low",
      },
    });

    const secondSave = await env.repository.saveOpportunity(TEST_TENANT, altered);
    expect(secondSave.id).toBe("opp_idemp_001");
    expect(secondSave.occurrenceCount).toBe(3); // Invariant preserved!
    expect(secondSave.metrics.totalDurationMs).toBe(3000); // Invariant preserved!

    // Verify database only has 1 record
    const allOpps = await env.repository.listOpportunities(TEST_TENANT);
    expect(allOpps).toHaveLength(1);
  });

  it("should atomically enqueue candidate.generate in Outbox when saving an eligible opportunity", async () => {
    const env = await createTestOpportunityEnvironment();
    const opp = createMockOpportunity({
      id: "opp_outbox_001",
      idempotencyKey: "opp_ik_outbox_001",
      status: "eligible",
      evidenceEventIds: ["evt_10", "evt_11"],
    });

    await env.repository.saveOpportunity(TEST_TENANT, opp);

    // Query outbox table
    const outboxRes = await env.pool.query(
      `SELECT * FROM outbox WHERE aggregate_id = $1 AND event_type = $2`,
      ["opp_outbox_001", "candidate.generate"],
    );

    expect(outboxRes.rows).toHaveLength(1);
    const outboxRecord = outboxRes.rows[0];
    expect(outboxRecord.account_id).toBe(TEST_ACCOUNT_ID);
    expect(outboxRecord.workspace_id).toBe(TEST_WORKSPACE_ID);
    expect(outboxRecord.aggregate_type).toBe("opportunity");
    expect(outboxRecord.status).toBe("pending");

    const payload =
      typeof outboxRecord.payload === "string"
        ? JSON.parse(outboxRecord.payload)
        : outboxRecord.payload;
    expect(payload.opportunityId).toBe("opp_outbox_001");
    expect(payload.structuralHash).toBe(opp.structuralHash);
    expect(payload.workspaceId).toBe(TEST_WORKSPACE_ID);

    const headers =
      typeof outboxRecord.headers === "string"
        ? JSON.parse(outboxRecord.headers)
        : outboxRecord.headers;
    expect(headers.correlationId).toBe("opp_outbox_001");
    expect(headers.idempotencyKey).toBe("opp_ik_outbox_001");
  });

  it("should NOT enqueue outbox event for suppressed, covered, duplicate, or empty-evidence opportunities", async () => {
    const env = await createTestOpportunityEnvironment();

    // 1. Suppressed
    const suppressedOpp = createMockOpportunity({
      id: "opp_suppressed_001",
      idempotencyKey: "opp_ik_supp_001",
      status: "suppressed",
      suppression: {
        suppressed: true,
        reason: "destructive",
        details: "Workflow contains destructive rm -rf commands",
      },
    });
    await env.repository.saveOpportunity(TEST_TENANT, suppressedOpp);

    // 2. Covered
    const coveredOpp = createMockOpportunity({
      id: "opp_covered_001",
      idempotencyKey: "opp_ik_cov_001",
      status: "covered",
      coverage: {
        status: "covered",
        coveredByToolId: "existing_file_tool",
        reason: "Existing tool covers functionality",
      },
    });
    await env.repository.saveOpportunity(TEST_TENANT, coveredOpp);

    // 3. Duplicate
    const duplicateOpp = createMockOpportunity({
      id: "opp_duplicate_001",
      idempotencyKey: "opp_ik_dup_001",
      status: "duplicate",
      coverage: {
        status: "duplicate",
        isDuplicate: true,
        reason: "Duplicate candidate detected",
      },
    });
    await env.repository.saveOpportunity(TEST_TENANT, duplicateOpp);

    // 4. Eligible but missing evidence event IDs
    const noEvidenceOpp = createMockOpportunity({
      id: "opp_no_evidence_001",
      idempotencyKey: "opp_ik_no_ev_001",
      status: "eligible",
      evidenceEventIds: [],
    });
    await env.repository.saveOpportunity(TEST_TENANT, noEvidenceOpp);

    // Verify outbox has 0 records
    const outboxRes = await env.pool.query(`SELECT * FROM outbox`);
    expect(outboxRes.rows).toHaveLength(0);

    // All 4 records are persisted in opportunities table for audit and cooldown tracking
    const allOpps = await env.repository.listOpportunities(TEST_TENANT);
    expect(allOpps).toHaveLength(4);
  });

  it("should enforce strict tenant and workspace isolation", async () => {
    const env = await createTestOpportunityEnvironment();

    // Setup Tenant Alpha
    const alphaTenant = { accountId: "acc_alpha", workspaceId: "ws_alpha" };
    await env.pool.query(
      `INSERT INTO accounts (id, name, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
      ["acc_alpha", "Alpha", "standard", new Date().toISOString(), new Date().toISOString()],
    );
    await env.pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "ws_alpha",
        "acc_alpha",
        "Alpha WS",
        "alpha",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );

    // Setup Tenant Beta
    const betaTenant = { accountId: "acc_beta", workspaceId: "ws_beta" };
    await env.pool.query(
      `INSERT INTO accounts (id, name, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
      ["acc_beta", "Beta", "standard", new Date().toISOString(), new Date().toISOString()],
    );
    await env.pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "ws_beta",
        "acc_beta",
        "Beta WS",
        "beta",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );

    const oppAlpha = createMockOpportunity({
      id: "opp_alpha_001",
      accountId: "acc_alpha",
      workspaceId: "ws_alpha",
      idempotencyKey: "opp_ik_alpha_001",
    });

    const oppBeta = createMockOpportunity({
      id: "opp_beta_001",
      accountId: "acc_beta",
      workspaceId: "ws_beta",
      idempotencyKey: "opp_ik_beta_001",
    });

    await env.repository.saveOpportunity(alphaTenant, oppAlpha);
    await env.repository.saveOpportunity(betaTenant, oppBeta);

    // Tenant Alpha cannot access Tenant Beta's opportunity
    const alphaLookupOfBeta = await env.repository.getOpportunityById(alphaTenant, "opp_beta_001");
    expect(alphaLookupOfBeta).toBeNull();

    // Tenant Beta cannot access Tenant Alpha's opportunity
    const betaLookupOfAlpha = await env.repository.getOpportunityById(betaTenant, "opp_alpha_001");
    expect(betaLookupOfAlpha).toBeNull();

    // List isolation
    const alphaList = await env.repository.listOpportunities(alphaTenant);
    expect(alphaList).toHaveLength(1);
    expect(alphaList[0].id).toBe("opp_alpha_001");

    const betaList = await env.repository.listOpportunities(betaTenant);
    expect(betaList).toHaveLength(1);
    expect(betaList[0].id).toBe("opp_beta_001");

    // Saving with mismatched tenant context throws TenantMismatchError
    await expect(env.repository.saveOpportunity(alphaTenant, oppBeta)).rejects.toThrow();
  });

  it("should query recent opportunity structural hashes for cooldown tracking", async () => {
    const env = await createTestOpportunityEnvironment();
    const t0 = new Date("2026-08-17T10:00:00.000Z").getTime();
    const t1 = new Date("2026-08-17T11:00:00.000Z").getTime();
    const t2 = new Date("2026-08-17T12:00:00.000Z").getTime();

    const opp1 = createMockOpportunity({
      id: "opp_hash_001",
      structuralHash: "hash_old",
      idempotencyKey: "opp_ik_h1",
      createdAt: new Date(t0).toISOString(),
      updatedAt: new Date(t0).toISOString(),
    });
    const opp2 = createMockOpportunity({
      id: "opp_hash_002",
      structuralHash: "hash_recent",
      idempotencyKey: "opp_ik_h2",
      createdAt: new Date(t2).toISOString(),
      updatedAt: new Date(t2).toISOString(),
    });

    await env.repository.saveOpportunity(TEST_TENANT, opp1);
    await env.repository.saveOpportunity(TEST_TENANT, opp2);

    // Query since t1 (11:00)
    const recentHashes = await env.repository.getRecentOpportunityHashes(TEST_TENANT, t1);
    expect(recentHashes.has("hash_recent")).toBe(true);
    expect(recentHashes.has("hash_old")).toBe(false);
  });

  it("should handle concurrent save calls safely producing 1 row and 1 outbox message", async () => {
    const env = await createTestOpportunityEnvironment();
    const opp = createMockOpportunity({
      id: "opp_concurrent_001",
      structuralHash: "hash_concurrent",
      idempotencyKey: "opp_ik_concurrent_001",
      status: "eligible",
      evidenceEventIds: ["evt_c1", "evt_c2"],
    });

    // 5 concurrent workers attempting to save the same detected opportunity
    const results = await Promise.all([
      env.repository.saveOpportunity(TEST_TENANT, opp),
      env.repository.saveOpportunity(TEST_TENANT, opp),
      env.repository.saveOpportunity(TEST_TENANT, opp),
      env.repository.saveOpportunity(TEST_TENANT, opp),
      env.repository.saveOpportunity(TEST_TENANT, opp),
    ]);

    for (const res of results) {
      expect(res.id).toBe("opp_concurrent_001");
    }

    // Verify exactly 1 opportunity row in database
    const oppRows = await env.pool.query(
      `SELECT * FROM opportunities WHERE workspace_id = $1 AND idempotency_key = $2`,
      [TEST_WORKSPACE_ID, "opp_ik_concurrent_001"],
    );
    expect(oppRows.rows).toHaveLength(1);

    // Verify exactly 1 outbox message
    const outboxRows = await env.pool.query(
      `SELECT * FROM outbox WHERE aggregate_id = $1 AND event_type = $2`,
      ["opp_concurrent_001", "candidate.generate"],
    );
    expect(outboxRows.rows).toHaveLength(1);
  });
});
