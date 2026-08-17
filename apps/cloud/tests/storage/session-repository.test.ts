import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { ObservationRepository } from "../../src/storage/repositories/observation-repository.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import { TenantContext } from "../../src/tenant.js";

describe("SessionRepository", () => {
  const setup = async () => {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);
    const obsRepo = new ObservationRepository(pool);
    const sessionRepo = new SessionRepository(pool);

    const tenantA: TenantContext = {
      accountId: "acc-1",
      workspaceId: "ws-1",
    };

    const tenantB: TenantContext = {
      accountId: "acc-2",
      workspaceId: "ws-2",
    };

    await pool.query(
      `INSERT INTO accounts (id, name) VALUES ($1, $2), ($3, $4)`,
      ["acc-1", "Account 1", "acc-2", "Account 2"],
    );
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      ["ws-1", "acc-1", "Workspace 1", "ws1", "ws-2", "acc-2", "Workspace 2", "ws2"],
    );

    return { pool, obsRepo, sessionRepo, tenantA, tenantB };
  };

  it("should create and manage session lifecycle with branches", async () => {
    const { sessionRepo, tenantA } = await setup();

    const session = await sessionRepo.createSession(tenantA, {
      id: "sess-lifecycle",
      harnessType: "codex",
      fidelity: "full",
    });

    expect(session.id).toBe("sess-lifecycle");
    expect(session.status).toBe("active");
    expect(session.eventCount).toBe(0);

    // Create a branch
    const branch = await sessionRepo.createBranch(tenantA, {
      id: "branch-exp-1",
      sessionId: "sess-lifecycle",
      name: "experiment-1",
    });
    expect(branch.id).toBe("branch-exp-1");
    expect(branch.sessionId).toBe("sess-lifecycle");

    const branches = await sessionRepo.listBranches(tenantA, "sess-lifecycle");
    expect(branches.length).toBe(1);
    expect(branches[0].name).toBe("experiment-1");

    // Complete session
    await sessionRepo.updateSessionStatus(tenantA, "sess-lifecycle", "completed");
    const completed = await sessionRepo.getSessionById(tenantA, "sess-lifecycle");
    expect(completed?.status).toBe("completed");
    expect(completed?.endedAt).not.toBeNull();
  });

  it("should materialize event summaries across batches and types", async () => {
    const { obsRepo, sessionRepo, tenantA } = await setup();
    await sessionRepo.createSession(tenantA, { id: "sess-summary" });

    // Ingest first batch: 2 messages, 1 tool invocation
    const batch1 = await obsRepo.insertEventsBatch(tenantA, [
      {
        eventId: "e1",
        schemaVersion: "1.0.0",
        sessionId: "sess-summary",
        timestamp: "2026-08-17T12:00:00.000Z",
        type: "message",
        role: "user",
        content: "Hi",
        causalRef: { causalSequence: 1 },
      },
      {
        eventId: "e2",
        schemaVersion: "1.0.0",
        sessionId: "sess-summary",
        timestamp: "2026-08-17T12:00:01.000Z",
        type: "message",
        role: "assistant",
        content: "Hello",
        causalRef: { causalSequence: 2 },
      },
      {
        eventId: "e3",
        schemaVersion: "1.0.0",
        sessionId: "sess-summary",
        timestamp: "2026-08-17T12:00:02.000Z",
        type: "tool_invocation",
        toolName: "calc",
        toolCallId: "c1",
        input: { expr: "1+1" },
        causalRef: { causalSequence: 3 },
      },
    ]);

    const updated1 = await sessionRepo.recordSessionEventsMaterialized(tenantA, "sess-summary", batch1);
    expect(updated1.eventCount).toBe(3);
    expect(updated1.summaryByKind).toEqual({
      message: 2,
      tool_invocation: 1,
    });
    expect(updated1.cursor).toBe("3");

    // Ingest second batch: 1 tool execution, 1 state snapshot
    const batch2 = await obsRepo.insertEventsBatch(tenantA, [
      {
        eventId: "e4",
        schemaVersion: "1.0.0",
        sessionId: "sess-summary",
        timestamp: "2026-08-17T12:00:03.000Z",
        type: "tool_execution",
        toolName: "calc",
        toolCallId: "c1",
        output: "2",
        status: "success",
        causalRef: { causalSequence: 4 },
      },
      {
        eventId: "e5",
        schemaVersion: "1.0.0",
        sessionId: "sess-summary",
        timestamp: "2026-08-17T12:00:04.000Z",
        type: "state_snapshot",
        source: "workspace",
        snapshotType: "tree",
        data: {},
        causalRef: { causalSequence: 5 },
      },
    ]);

    const updated2 = await sessionRepo.recordSessionEventsMaterialized(tenantA, "sess-summary", batch2);
    expect(updated2.eventCount).toBe(5);
    expect(updated2.summaryByKind).toEqual({
      message: 2,
      tool_invocation: 1,
      tool_execution: 1,
      state_snapshot: 1,
    });
    expect(updated2.cursor).toBe("5");

    const summary = await sessionRepo.getSessionSummary(tenantA, "sess-summary");
    expect(summary?.eventCount).toBe(5);
    expect(summary?.summaryByKind.message).toBe(2);
    expect(summary?.summaryByKind.tool_execution).toBe(1);
  });

  it("should handle out-of-order and late batch ingestion preserving causal metadata", async () => {
    const { obsRepo, sessionRepo, tenantA } = await setup();
    await sessionRepo.createSession(tenantA, {
      id: "sess-late",
      startedAt: "2026-08-17T12:00:10.000Z",
    });

    // Ingest later events first
    const lateBatch = await obsRepo.insertEventsBatch(tenantA, [
      {
        eventId: "e-late-10",
        schemaVersion: "1.0.0",
        sessionId: "sess-late",
        timestamp: "2026-08-17T12:00:10.000Z",
        type: "message",
        role: "user",
        content: "Later turn",
        causalRef: { causalSequence: 10 },
      },
    ]);
    await sessionRepo.recordSessionEventsMaterialized(tenantA, "sess-late", lateBatch);

    // Ingest earlier (delayed/late-arriving) events
    const earlyBatch = await obsRepo.insertEventsBatch(tenantA, [
      {
        eventId: "e-early-1",
        schemaVersion: "1.0.0",
        sessionId: "sess-late",
        timestamp: "2026-08-17T12:00:01.000Z",
        type: "message",
        role: "user",
        content: "Early turn",
        causalRef: { causalSequence: 1 },
      },
    ]);
    const updated = await sessionRepo.recordSessionEventsMaterialized(tenantA, "sess-late", earlyBatch);

    expect(updated.eventCount).toBe(2);
    // Earliest startedAt updated to 12:00:01
    expect(updated.startedAt).toBe("2026-08-17T12:00:01.000Z");

    const events = await obsRepo.queryEvents({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      sessionId: "sess-late",
      sortOrder: "ASC",
    });

    expect(events.events.map((e) => e.id)).toEqual(["e-early-1", "e-late-10"]);
  });

  it("should enforce strict tenant isolation on sessions and branches", async () => {
    const { sessionRepo, tenantA, tenantB } = await setup();

    await sessionRepo.createSession(tenantA, { id: "sess-isolated-a" });
    await sessionRepo.createBranch(tenantA, {
      id: "branch-a",
      sessionId: "sess-isolated-a",
      name: "branch-a",
    });

    // Tenant B cannot fetch session A
    const fetchSession = await sessionRepo.getSessionById(tenantB, "sess-isolated-a");
    expect(fetchSession).toBeNull();

    // Tenant B cannot fetch branch A
    const fetchBranch = await sessionRepo.getBranchById(tenantB, "branch-a");
    expect(fetchBranch).toBeNull();

    // Tenant B listSessions returns empty
    const listB = await sessionRepo.listSessions({
      accountId: tenantB.accountId,
      workspaceId: tenantB.workspaceId,
    });
    expect(listB.length).toBe(0);
  });
});
