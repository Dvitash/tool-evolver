import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { OutboxRepository } from "../../src/db/outbox.js";
import { createJobEnvelope } from "../../src/queue/envelope.js";
import {
  StoreObservationBatchConsumer,
  type StoreObservationBatchPayload,
} from "../../src/storage/consumer.js";
import { ObservationRepository } from "../../src/storage/repositories/observation-repository.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import type { TenantContext } from "../../src/tenant.js";

describe("StoreObservationBatchConsumer", () => {
  const setup = async () => {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);
    const obsRepo = new ObservationRepository(pool);
    const sessionRepo = new SessionRepository(pool);
    const consumer = new StoreObservationBatchConsumer(pool, { obsRepo, sessionRepo });

    const tenant: TenantContext = {
      accountId: "acc-consumer",
      workspaceId: "ws-consumer",
      deviceId: "dev-consumer",
    };

    await pool.query(`INSERT INTO accounts (id, name) VALUES ($1, $2)`, [
      "acc-consumer",
      "Consumer Corp",
    ]);
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug) VALUES ($1, $2, $3, $4)`,
      ["ws-consumer", "acc-consumer", "Consumer Workspace", "consumer"],
    );

    return { pool, obsRepo, sessionRepo, consumer, tenant };
  };

  it("should process batch idempotently, materialize summaries, and publish observation-available event", async () => {
    const { pool, obsRepo, sessionRepo, consumer, tenant } = await setup();

    const observations: NormalizedSessionEvent[] = [
      {
        eventId: "evt-c1",
        schemaVersion: "1.0.0",
        sessionId: "sess-batch-1",
        timestamp: "2026-08-17T12:00:00.000Z",
        type: "message",
        role: "user",
        content: "What is the status?",
        causalRef: { causalSequence: 1 },
      },
      {
        eventId: "evt-c2",
        schemaVersion: "1.0.0",
        sessionId: "sess-batch-1",
        timestamp: "2026-08-17T12:00:01.000Z",
        type: "tool_invocation",
        toolName: "system_status",
        toolCallId: "call-1",
        input: {},
        causalRef: { causalSequence: 2 },
      },
      {
        eventId: "evt-c3",
        schemaVersion: "1.0.0",
        sessionId: "sess-batch-1",
        timestamp: "2026-08-17T12:00:02.000Z",
        type: "branch_fork",
        forkBranchId: "branch-investigation",
        parentBranchId: "main",
        name: "investigation",
        causalRef: { causalSequence: 3 },
      },
    ];

    const payload: StoreObservationBatchPayload = {
      batchId: "batch-100",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      deviceId: tenant.deviceId,
      installationId: "inst-1",
      contentHash: "hash-100",
      acceptedCount: observations.length,
      observations,
      ingestedAt: new Date().toISOString(),
    };

    const envelope = createJobEnvelope({
      jobType: "store-observation-batch",
      tenantContext: tenant,
      payload,
    });

    // 1. First execution
    await consumer.processJob(envelope);

    // Verify session exists and has materialized summary
    const session = await sessionRepo.getSessionById(tenant, "sess-batch-1");
    expect(session).not.toBeNull();
    expect(session?.eventCount).toBe(3);
    expect(session?.summaryByKind.message).toBe(1);
    expect(session?.summaryByKind.tool_invocation).toBe(1);
    expect(session?.summaryByKind.branch_fork).toBe(1);

    // Verify branch was created
    const branches = await sessionRepo.listBranches(tenant, "sess-batch-1");
    expect(branches.length).toBe(1);
    expect(branches[0].name).toBe("investigation");

    // Verify events were stored
    const events = await obsRepo.queryEvents({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      sessionId: "sess-batch-1",
    });
    expect(events.events.length).toBe(3);

    // Verify outbox observation-available event
    const outboxEvents = await OutboxRepository.fetchPending(pool);
    expect(outboxEvents.some((e) => e.eventType === "observation-available")).toBe(true);

    // 2. Second execution (idempotency check)
    await consumer.processJob(envelope);

    // Summary and count should remain stable
    const sessionAfter = await sessionRepo.getSessionById(tenant, "sess-batch-1");
    expect(sessionAfter?.eventCount).toBe(3);
  });
});
