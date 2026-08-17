import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { EvidenceRepository } from "../../src/storage/repositories/evidence-repository.js";
import { ObservationRepository } from "../../src/storage/repositories/observation-repository.js";
import { RetentionRepository } from "../../src/storage/repositories/retention-repository.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import { RetentionService } from "../../src/storage/retention-service.js";
import { TenantContext } from "../../src/tenant.js";

describe("RetentionService", () => {
  const setup = async () => {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);
    const obsRepo = new ObservationRepository(pool);
    const sessionRepo = new SessionRepository(pool);
    const evidenceRepo = new EvidenceRepository(pool);
    const retentionRepo = new RetentionRepository(pool);
    const retentionService = new RetentionService(pool, { retentionRepo });

    const tenant: TenantContext = {
      accountId: "acc-ret",
      workspaceId: "ws-ret",
    };

    await pool.query(
      `INSERT INTO accounts (id, name) VALUES ($1, $2)`,
      ["acc-ret", "Retention Corp"],
    );
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug) VALUES ($1, $2, $3, $4)`,
      ["ws-ret", "acc-ret", "Retention Workspace", "ret"],
    );

    return { pool, obsRepo, sessionRepo, evidenceRepo, retentionRepo, retentionService, tenant };
  };

  it("should prune expired unheld sessions and preserve active held sessions", async () => {
    const { sessionRepo, obsRepo, retentionRepo, retentionService, tenant } = await setup();

    const now = new Date("2026-08-17T12:00:00.000Z");

    // 1. Expired Session A (100 days old) - Unheld
    const oldStartedAt = new Date(now.getTime() - 100 * 86400000).toISOString();
    await sessionRepo.createSession(tenant, {
      id: "sess-expired-unheld",
      startedAt: oldStartedAt,
    });
    await obsRepo.insertEvent(tenant, {
      eventId: "evt-old-1",
      schemaVersion: "1.0.0",
      sessionId: "sess-expired-unheld",
      timestamp: oldStartedAt,
      type: "message",
      role: "user",
      content: "Old message",
      causalRef: { causalSequence: 1 },
    });

    // 2. Expired Session B (100 days old) - Held for evaluation
    await sessionRepo.createSession(tenant, {
      id: "sess-expired-held",
      startedAt: oldStartedAt,
    });
    await obsRepo.insertEvent(tenant, {
      eventId: "evt-old-2",
      schemaVersion: "1.0.0",
      sessionId: "sess-expired-held",
      timestamp: oldStartedAt,
      type: "message",
      role: "user",
      content: "Old held message",
      causalRef: { causalSequence: 1 },
    });
    // Create retention hold
    await retentionRepo.createHold(tenant, {
      targetType: "session",
      targetId: "sess-expired-held",
      holdType: "evaluation",
      reason: "Active candidate evaluation hold",
    });

    // 3. Recent Session C (5 days old)
    const recentStartedAt = new Date(now.getTime() - 5 * 86400000).toISOString();
    await sessionRepo.createSession(tenant, {
      id: "sess-recent",
      startedAt: recentStartedAt,
    });
    await obsRepo.insertEvent(tenant, {
      eventId: "evt-recent-1",
      schemaVersion: "1.0.0",
      sessionId: "sess-recent",
      timestamp: recentStartedAt,
      type: "message",
      role: "user",
      content: "Recent message",
      causalRef: { causalSequence: 1 },
    });

    // Run retention pass (sessionRetentionDays = 90)
    const result = await retentionService.runRetentionPass(tenant, {
      now: now.toISOString(),
      sessionRetentionDays: 90,
      eventRetentionDays: 30,
      dryRun: false,
    });

    expect(result.deletedSessions).toBe(1); // sess-expired-unheld deleted
    expect(result.preservedHeldSessions).toBe(1); // sess-expired-held preserved

    // Verify DB state
    const unheldSession = await sessionRepo.getSessionById(tenant, "sess-expired-unheld");
    expect(unheldSession).toBeNull();
    const unheldEvent = await obsRepo.getEventById(tenant, "evt-old-1");
    expect(unheldEvent).toBeNull();

    const heldSession = await sessionRepo.getSessionById(tenant, "sess-expired-held");
    expect(heldSession).not.toBeNull();
    const heldEvent = await obsRepo.getEventById(tenant, "evt-old-2");
    expect(heldEvent).not.toBeNull();

    const recentSession = await sessionRepo.getSessionById(tenant, "sess-recent");
    expect(recentSession).not.toBeNull();
  });

  it("should preserve expired events if referenced in an EvidenceSet", async () => {
    const { sessionRepo, obsRepo, evidenceRepo, retentionService, tenant } = await setup();

    const now = new Date("2026-08-17T12:00:00.000Z");
    const activeSessionStarted = new Date(now.getTime() - 10 * 86400000).toISOString();
    const expiredEventTime = new Date(now.getTime() - 45 * 86400000).toISOString();

    await sessionRepo.createSession(tenant, {
      id: "sess-active-with-old-events",
      startedAt: activeSessionStarted,
    });

    // Event 1: Expired and unreferenced
    await obsRepo.insertEvent(tenant, {
      eventId: "evt-expired-unreferenced",
      schemaVersion: "1.0.0",
      sessionId: "sess-active-with-old-events",
      timestamp: expiredEventTime,
      type: "message",
      role: "user",
      content: "Unreferenced old",
      causalRef: { causalSequence: 1 },
    });

    // Event 2: Expired but referenced in EvidenceSet
    const ev2 = await obsRepo.insertEvent(tenant, {
      eventId: "evt-expired-in-evidence",
      schemaVersion: "1.0.0",
      sessionId: "sess-active-with-old-events",
      timestamp: expiredEventTime,
      type: "tool_execution",
      toolName: "benchmark",
      toolCallId: "b1",
      output: "score: 100",
      status: "success",
      causalRef: { causalSequence: 2 },
    });

    await evidenceRepo.createEvidenceSet(tenant, {
      id: "ev-set-ref-1",
      sessionId: "sess-active-with-old-events",
      name: "Benchmark Evidence",
      eventIds: [ev2.id],
    });

    // Run retention pass (eventRetentionDays = 30)
    const result = await retentionService.runRetentionPass(tenant, {
      now: now.toISOString(),
      sessionRetentionDays: 90,
      eventRetentionDays: 30,
      dryRun: false,
    });

    expect(result.deletedEvents).toBe(1); // evt-expired-unreferenced deleted
    expect(result.preservedHeldEvents).toBe(1); // evt-expired-in-evidence preserved

    const unref = await obsRepo.getEventById(tenant, "evt-expired-unreferenced");
    expect(unref).toBeNull();

    const inEvidence = await obsRepo.getEventById(tenant, "evt-expired-in-evidence");
    expect(inEvidence).not.toBeNull();
  });
});
