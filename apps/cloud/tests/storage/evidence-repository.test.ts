import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { EvidenceRepository } from "../../src/storage/repositories/evidence-repository.js";
import { ObservationRepository } from "../../src/storage/repositories/observation-repository.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import type { TenantContext } from "../../src/tenant.js";

describe("EvidenceRepository", () => {
  const setup = async () => {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);
    const obsRepo = new ObservationRepository(pool);
    const sessionRepo = new SessionRepository(pool);
    const evidenceRepo = new EvidenceRepository(pool);

    const tenantA: TenantContext = {
      accountId: "acc-ev-a",
      workspaceId: "ws-ev-a",
    };

    const tenantB: TenantContext = {
      accountId: "acc-ev-b",
      workspaceId: "ws-ev-b",
    };

    await pool.query(`INSERT INTO accounts (id, name) VALUES ($1, $2), ($3, $4)`, [
      "acc-ev-a",
      "Account A",
      "acc-ev-b",
      "Account B",
    ]);
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      ["ws-ev-a", "acc-ev-a", "Workspace A", "wsa", "ws-ev-b", "acc-ev-b", "Workspace B", "wsb"],
    );

    return { pool, obsRepo, sessionRepo, evidenceRepo, tenantA, tenantB };
  };

  it("should create immutable EvidenceSet and verify cryptographic root digest", async () => {
    const { obsRepo, sessionRepo, evidenceRepo, tenantA } = await setup();
    await sessionRepo.createSession(tenantA, { id: "sess-ev" });

    const e1 = await obsRepo.insertEvent(tenantA, {
      eventId: "ev-event-1",
      schemaVersion: "1.0.0",
      sessionId: "sess-ev",
      timestamp: "2026-08-17T12:00:00.000Z",
      type: "message",
      role: "user",
      content: "Evidence prompt",
      causalRef: { causalSequence: 1 },
    });

    const e2 = await obsRepo.insertEvent(tenantA, {
      eventId: "ev-event-2",
      schemaVersion: "1.0.0",
      sessionId: "sess-ev",
      timestamp: "2026-08-17T12:00:01.000Z",
      type: "tool_execution",
      toolName: "unit-test",
      toolCallId: "c1",
      output: "passed",
      status: "success",
      causalRef: { causalSequence: 2 },
    });

    const evidenceSet = await evidenceRepo.createEvidenceSet(tenantA, {
      id: "ev-set-001",
      sessionId: "sess-ev",
      name: "Benchmark Pass Evidence",
      description: "Cryptographically immutable trace snapshot",
      eventIds: [e1.id, e2.id],
      metadata: { candidateId: "cand-123" },
    });

    expect(evidenceSet.id).toBe("ev-set-001");
    expect(evidenceSet.memberCount).toBe(2);
    expect(evidenceSet.rootDigest).toBeDefined();
    expect(evidenceSet.rootDigest.length).toBe(64);

    // Resolve evidence set
    const resolved = await evidenceRepo.resolveEvidenceSet(tenantA, "ev-set-001");
    expect(resolved).not.toBeNull();
    expect(resolved?.isDigestValid).toBe(true);
    expect(resolved?.members.length).toBe(2);
    expect(resolved?.events.length).toBe(2);
    expect(resolved?.events[0].id).toBe("ev-event-1");
    expect(resolved?.events[1].id).toBe("ev-event-2");
  });

  it("should fail creation when referencing non-existent or other tenant events", async () => {
    const { evidenceRepo, tenantA, tenantB, obsRepo, sessionRepo } = await setup();
    await sessionRepo.createSession(tenantB, { id: "sess-b" });
    await obsRepo.insertEvent(tenantB, {
      eventId: "evt-tenant-b",
      schemaVersion: "1.0.0",
      sessionId: "sess-b",
      timestamp: "2026-08-17T12:00:00.000Z",
      type: "message",
      role: "user",
      content: "Tenant B data",
      causalRef: { causalSequence: 1 },
    });

    // Tenant A attempts to reference Tenant B's event
    await expect(
      evidenceRepo.createEvidenceSet(tenantA, {
        name: "Malicious Evidence Set",
        eventIds: ["evt-tenant-b"],
      }),
    ).rejects.toThrow();

    // Tenant A attempts to reference non-existent event
    await expect(
      evidenceRepo.createEvidenceSet(tenantA, {
        name: "Missing Event Evidence",
        eventIds: ["non-existent-evt"],
      }),
    ).rejects.toThrow();
  });

  it("should enforce strict tenant isolation on EvidenceSets", async () => {
    const { obsRepo, sessionRepo, evidenceRepo, tenantA, tenantB } = await setup();
    await sessionRepo.createSession(tenantA, { id: "sess-iso" });
    const e = await obsRepo.insertEvent(tenantA, {
      eventId: "ev-iso-1",
      schemaVersion: "1.0.0",
      sessionId: "sess-iso",
      timestamp: "2026-08-17T12:00:00.000Z",
      type: "message",
      role: "user",
      content: "Secret",
      causalRef: { causalSequence: 1 },
    });

    await evidenceRepo.createEvidenceSet(tenantA, {
      id: "ev-set-iso",
      sessionId: "sess-iso",
      name: "Secret Evidence",
      eventIds: [e.id],
    });

    // Tenant B cannot get by ID
    const getB = await evidenceRepo.getEvidenceSetById(tenantB, "ev-set-iso");
    expect(getB).toBeNull();

    // Tenant B cannot resolve
    const resolveB = await evidenceRepo.resolveEvidenceSet(tenantB, "ev-set-iso");
    expect(resolveB).toBeNull();

    // Tenant B list returns empty
    const listB = await evidenceRepo.listEvidenceSets(tenantB);
    expect(listB.length).toBe(0);
  });
});
