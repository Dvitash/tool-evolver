import {
  type NormalizedSessionEvent,
  canonicalJsonStringify,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { ObservationRepository } from "../../src/storage/repositories/observation-repository.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import type { TenantContext } from "../../src/tenant.js";

describe("ObservationRepository", () => {
  const setup = async () => {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);
    const obsRepo = new ObservationRepository(pool);
    const sessionRepo = new SessionRepository(pool);

    const tenantA: TenantContext = {
      accountId: "acc-alpha",
      workspaceId: "ws-alpha",
    };

    const tenantB: TenantContext = {
      accountId: "acc-beta",
      workspaceId: "ws-beta",
    };

    // Pre-create account/workspace if needed
    await pool.query(`INSERT INTO accounts (id, name, plan) VALUES ($1, $2, $3), ($4, $5, $6)`, [
      "acc-alpha",
      "Alpha Corp",
      "enterprise",
      "acc-beta",
      "Beta LLC",
      "standard",
    ]);
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      [
        "ws-alpha",
        "acc-alpha",
        "Alpha Workspace",
        "alpha",
        "ws-beta",
        "acc-beta",
        "Beta Workspace",
        "beta",
      ],
    );

    return { pool, obsRepo, sessionRepo, tenantA, tenantB };
  };

  it("should insert events idempotently and compute content hash", async () => {
    const { obsRepo, sessionRepo, tenantA } = await setup();
    await sessionRepo.createSession(tenantA, { id: "sess-100" });

    const event: NormalizedSessionEvent = {
      eventId: "evt-001",
      schemaVersion: "1.0.0",
      sessionId: "sess-100",
      timestamp: "2026-08-17T10:00:00.000Z",
      type: "message",
      role: "user",
      content: "Hello Evolver",
      causalRef: {
        causalSequence: 1,
        turnIndex: 0,
        stepIndex: 0,
      },
    };

    const stored1 = await obsRepo.insertEvent(tenantA, event);
    expect(stored1.id).toBe("evt-001");
    expect(stored1.accountId).toBe(tenantA.accountId);
    expect(stored1.workspaceId).toBe(tenantA.workspaceId);
    expect(stored1.sessionId).toBe("sess-100");
    expect(stored1.causalSequence).toBe(1);
    expect(stored1.contentHash).toBe(hashCanonicalContent(event, { prefix: false }));

    // Re-inserting the exact same event should be idempotent and return existing
    const stored2 = await obsRepo.insertEvent(tenantA, event);
    expect(stored2.id).toBe("evt-001");

    const fetched = await obsRepo.getEventById(tenantA, "evt-001");
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe("evt-001");
    expect(fetched?.payload.content).toBe("Hello Evolver");
  });

  it("should insert batches in deterministic causal sequence order", async () => {
    const { obsRepo, sessionRepo, tenantA } = await setup();
    await sessionRepo.createSession(tenantA, { id: "sess-200" });

    // Intentionally out-of-order array
    const events: NormalizedSessionEvent[] = [
      {
        eventId: "evt-3",
        schemaVersion: "1.0.0",
        sessionId: "sess-200",
        timestamp: "2026-08-17T10:00:03.000Z",
        type: "tool_execution",
        toolName: "bash",
        toolCallId: "call-1",
        output: "done",
        status: "success",
        causalRef: { causalSequence: 3, parentId: "evt-2" },
      },
      {
        eventId: "evt-1",
        schemaVersion: "1.0.0",
        sessionId: "sess-200",
        timestamp: "2026-08-17T10:00:01.000Z",
        type: "message",
        role: "user",
        content: "Run test",
        causalRef: { causalSequence: 1 },
      },
      {
        eventId: "evt-2",
        schemaVersion: "1.0.0",
        sessionId: "sess-200",
        timestamp: "2026-08-17T10:00:02.000Z",
        type: "tool_invocation",
        toolName: "bash",
        toolCallId: "call-1",
        input: { cmd: "test" },
        causalRef: { causalSequence: 2, parentId: "evt-1" },
      },
    ];

    const inserted = await obsRepo.insertEventsBatch(tenantA, events);
    expect(inserted.map((e) => e.id)).toEqual(["evt-1", "evt-2", "evt-3"]);

    const queryRes = await obsRepo.queryEvents({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      sessionId: "sess-200",
      sortOrder: "ASC",
    });

    expect(queryRes.events.length).toBe(3);
    expect(queryRes.events[0].id).toBe("evt-1");
    expect(queryRes.events[1].id).toBe("evt-2");
    expect(queryRes.events[2].id).toBe("evt-3");
  });

  it("should query events with filters and deterministic pagination", async () => {
    const { obsRepo, sessionRepo, tenantA } = await setup();
    await sessionRepo.createSession(tenantA, { id: "sess-300" });

    for (let i = 1; i <= 10; i++) {
      await obsRepo.insertEvent(tenantA, {
        eventId: `evt-page-${i}`,
        schemaVersion: "1.0.0",
        sessionId: "sess-300",
        timestamp: `2026-08-17T10:0${i < 10 ? `0${i}` : i}:00.000Z`,
        type: i % 2 === 0 ? "tool_invocation" : "message",
        role: "user",
        content: `Msg ${i}`,
        causalRef: { causalSequence: i },
      });
    }

    // Filter by event type
    const messages = await obsRepo.queryEvents({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      sessionId: "sess-300",
      eventKind: "message",
    });
    expect(messages.events.length).toBe(5);
    expect(messages.totalCount).toBe(5);

    // Pagination: page 1
    const page1 = await obsRepo.queryEvents({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      sessionId: "sess-300",
      limit: 4,
      offset: 0,
      sortOrder: "ASC",
    });
    expect(page1.events.length).toBe(4);
    expect(page1.events[0].id).toBe("evt-page-1");
    expect(page1.events[3].id).toBe("evt-page-4");
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe("4");

    // Pagination: page 2
    const page2 = await obsRepo.queryEvents({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      sessionId: "sess-300",
      limit: 4,
      offset: 4,
      sortOrder: "ASC",
    });
    expect(page2.events.length).toBe(4);
    expect(page2.events[0].id).toBe("evt-page-5");
    expect(page2.events[3].id).toBe("evt-page-8");
    expect(page2.hasMore).toBe(true);

    // Pagination: page 3 (remaining 2)
    const page3 = await obsRepo.queryEvents({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      sessionId: "sess-300",
      limit: 4,
      offset: 8,
      sortOrder: "ASC",
    });
    expect(page3.events.length).toBe(2);
    expect(page3.events[0].id).toBe("evt-page-9");
    expect(page3.events[1].id).toBe("evt-page-10");
    expect(page3.hasMore).toBe(false);
  });

  it("should query causal graph neighborhood across ancestors and descendants", async () => {
    const { obsRepo, sessionRepo, tenantA } = await setup();
    await sessionRepo.createSession(tenantA, { id: "sess-graph" });

    // Root -> Child1 -> GrandChild1
    await obsRepo.insertEvent(tenantA, {
      eventId: "node-root",
      schemaVersion: "1.0.0",
      sessionId: "sess-graph",
      timestamp: "2026-08-17T10:00:00.000Z",
      type: "message",
      role: "user",
      content: "Root",
      causalRef: { causalSequence: 1, parentId: null, rootId: "node-root" },
    });

    await obsRepo.insertEvent(tenantA, {
      eventId: "node-child1",
      schemaVersion: "1.0.0",
      sessionId: "sess-graph",
      timestamp: "2026-08-17T10:00:01.000Z",
      type: "tool_invocation",
      toolName: "editor",
      toolCallId: "c1",
      input: {},
      causalRef: { causalSequence: 2, parentId: "node-root", rootId: "node-root" },
    });

    await obsRepo.insertEvent(tenantA, {
      eventId: "node-grandchild1",
      schemaVersion: "1.0.0",
      sessionId: "sess-graph",
      timestamp: "2026-08-17T10:00:02.000Z",
      type: "tool_execution",
      toolName: "editor",
      toolCallId: "c1",
      output: "ok",
      status: "success",
      causalRef: { causalSequence: 3, parentId: "node-child1", rootId: "node-root" },
    });

    const neighborhood = await obsRepo.getCausalNeighborhood(tenantA, "node-child1", {
      depth: 2,
      direction: "both",
    });

    const nodeIds = neighborhood.map((n) => n.id);
    expect(nodeIds).toContain("node-root");
    expect(nodeIds).toContain("node-child1");
    expect(nodeIds).toContain("node-grandchild1");
  });

  it("should enforce strict tenant isolation on event queries", async () => {
    const { obsRepo, sessionRepo, tenantA, tenantB } = await setup();
    await sessionRepo.createSession(tenantA, { id: "sess-shared" });
    await sessionRepo.createSession(tenantB, { id: "sess-shared" });

    await obsRepo.insertEvent(tenantA, {
      eventId: "evt-secret-a",
      schemaVersion: "1.0.0",
      sessionId: "sess-shared",
      timestamp: "2026-08-17T10:00:00.000Z",
      type: "message",
      role: "user",
      content: "Tenant A Confidential Data",
      causalRef: { causalSequence: 1 },
    });

    // Tenant B queries by ID -> should return null
    const crossTenantGet = await obsRepo.getEventById(tenantB, "evt-secret-a");
    expect(crossTenantGet).toBeNull();

    // Tenant B queries by session -> should return empty
    const crossTenantList = await obsRepo.queryEvents({
      accountId: tenantB.accountId,
      workspaceId: tenantB.workspaceId,
      sessionId: "sess-shared",
    });
    expect(crossTenantList.events.length).toBe(0);
    expect(crossTenantList.totalCount).toBe(0);

    // Tenant A queries -> should return 1 event
    const tenantAList = await obsRepo.queryEvents({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      sessionId: "sess-shared",
    });
    expect(tenantAList.events.length).toBe(1);
    expect(tenantAList.events[0].id).toBe("evt-secret-a");
  });
});
