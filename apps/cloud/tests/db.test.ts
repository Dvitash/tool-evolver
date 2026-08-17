import { describe, expect, it } from "vitest";
import {
  DatabasePool,
  MemoryDatabasePool,
  OutboxPublisher,
  OutboxRepository,
  getMigrationStatus,
  rollbackMigration,
  runMigrations,
} from "../src/db/index.js";

describe("Database Client, Migrations & Outbox", () => {
  it("should execute queries and support transactions with rollback", async () => {
    const pool = new MemoryDatabasePool();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_items (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      );
    `);

    // Insert item
    await pool.query(`INSERT INTO test_items (id, name) VALUES ($1, $2)`, ["item-1", "Alpha"]);
    const res1 = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM test_items WHERE id = $1`,
      ["item-1"],
    );
    expect(res1.rows.length).toBe(1);
    expect(res1.rows[0].name).toBe("Alpha");

    // Transaction that succeeds
    await pool.transaction(async (tx) => {
      await tx.query(`INSERT INTO test_items (id, name) VALUES ($1, $2)`, ["item-2", "Beta"]);
    });
    const res2 = await pool.query(`SELECT * FROM test_items`);
    expect(res2.rows.length).toBe(2);

    // Transaction that fails and rolls back
    try {
      await pool.transaction(async (tx) => {
        await tx.query(`INSERT INTO test_items (id, name) VALUES ($1, $2)`, ["item-3", "Gamma"]);
        throw new Error("Simulated failure in transaction");
      });
    } catch {
      // Expected
    }

    const res3 = await pool.query(`SELECT * FROM test_items`);
    expect(res3.rows.length).toBe(2); // item-3 rolled back
  });

  it("should run migrations transactionally with advisory locks", async () => {
    const pool = new MemoryDatabasePool();

    // Initial run
    const result = await runMigrations(pool);
    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(5);
    expect(result.currentVersion).toBe(5);

    // Verify migration status
    const statuses = await getMigrationStatus(pool);
    expect(statuses.length).toBeGreaterThanOrEqual(4);
    expect(statuses[0].applied).toBe(true);
    expect(statuses[0].version).toBe(1);
    expect(statuses[1].applied).toBe(true);
    expect(statuses[1].version).toBe(2);
    expect(statuses[2].applied).toBe(true);
    expect(statuses[2].version).toBe(3);
    expect(statuses[3].applied).toBe(true);
    expect(statuses[3].version).toBe(4);
    expect(statuses[4].applied).toBe(true);
    expect(statuses[4].version).toBe(5);
    // Re-running migrations is idempotent
    const secondRun = await runMigrations(pool);
    expect(secondRun.appliedCount).toBe(0);
    expect(secondRun.currentVersion).toBe(5);

    // Verify tables exist by querying accounts and jobs
    const accountsRes = await pool.query(`SELECT * FROM accounts`);
    expect(accountsRes.rows).toEqual([]);
    const jobsRes = await pool.query(`SELECT * FROM jobs`);
    expect(jobsRes.rows).toEqual([]);
    const sessionsRes = await pool.query(`SELECT * FROM sessions`);
    expect(sessionsRes.rows).toEqual([]);
    const bucketsRes = await pool.query(`SELECT * FROM telemetry_buckets`);
    expect(bucketsRes.rows).toEqual([]);
    // Rollback migration
    const rollback = await rollbackMigration(pool, { targetVersion: 0 });
    expect(rollback.success).toBe(true);
    expect(rollback.rolledBackCount).toBe(5);
    expect(rollback.currentVersion).toBe(0);
  });
  it("should atomically commit domain entity and outbox message in the same transaction", async () => {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);

    // Atomic transaction: Create account + Outbox event
    await pool.transaction(async (tx) => {
      // 1. Domain entity
      await tx.query(
        `INSERT INTO accounts (id, name, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
        [
          "acc-corp-1",
          "Acme Corporation",
          "enterprise",
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );

      // 2. Outbox event
      await OutboxRepository.insert(tx, {
        accountId: "acc-corp-1",
        workspaceId: "ws-main",
        aggregateType: "account",
        aggregateId: "acc-corp-1",
        eventType: "AccountCreated",
        payload: { name: "Acme Corporation", plan: "enterprise" },
      });
    });

    // Verify account exists
    const acc = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM accounts WHERE id = $1`,
      ["acc-corp-1"],
    );
    expect(acc.rows.length).toBe(1);
    expect(acc.rows[0].name).toBe("Acme Corporation");

    // Verify outbox record exists
    const pending = await OutboxRepository.fetchPending(pool);
    expect(pending.length).toBe(1);
    expect(pending[0].aggregateId).toBe("acc-corp-1");
    expect(pending[0].eventType).toBe("AccountCreated");
    expect(pending[0].status).toBe("pending");
  });

  it("should dispatch outbox messages with deduplication and notify subscribers", async () => {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);

    await OutboxRepository.insert(pool, {
      accountId: "acc-test",
      workspaceId: "ws-test",
      aggregateType: "device",
      aggregateId: "dev-001",
      eventType: "DeviceRegistered",
      payload: { platform: "linux-x64" },
    });

    const publisher = new OutboxPublisher(pool);
    const receivedEvents: string[] = [];

    publisher.subscribe("DeviceRegistered", async (event) => {
      receivedEvents.push(`${event.eventType}:${event.aggregateId}`);
    });

    const dispatched = await publisher.dispatchBatch(10);
    expect(dispatched).toBe(1);
    expect(receivedEvents).toEqual(["DeviceRegistered:dev-001"]);

    // Verify outbox status updated to published
    const remainingPending = await OutboxRepository.fetchPending(pool);
    expect(remainingPending.length).toBe(0);

    // Second dispatch is a no-op
    const secondDispatch = await publisher.dispatchBatch(10);
    expect(secondDispatch).toBe(0);
  });
});
