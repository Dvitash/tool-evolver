import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  ActiveRetentionHoldBlockedError,
  ExportService,
} from "../../src/storage/export-service.js";
import { MemoryObjectStore } from "../../src/storage/object-store.js";
import { EvidenceRepository } from "../../src/storage/repositories/evidence-repository.js";
import { ObservationRepository } from "../../src/storage/repositories/observation-repository.js";
import { RetentionRepository } from "../../src/storage/repositories/retention-repository.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import { TenantContext } from "../../src/tenant.js";

describe("ExportService & Cascading Deletion", () => {
  const setup = async () => {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);
    const objectStore = new MemoryObjectStore();
    const obsRepo = new ObservationRepository(pool);
    const sessionRepo = new SessionRepository(pool);
    const evidenceRepo = new EvidenceRepository(pool);
    const retentionRepo = new RetentionRepository(pool);
    const exportService = new ExportService(pool, objectStore, {
      obsRepo,
      sessionRepo,
      evidenceRepo,
      retentionRepo,
    });

    const tenant: TenantContext = {
      accountId: "acc-exp",
      workspaceId: "ws-exp",
    };

    await pool.query(
      `INSERT INTO accounts (id, name) VALUES ($1, $2)`,
      ["acc-exp", "Export Corp"],
    );
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug) VALUES ($1, $2, $3, $4)`,
      ["ws-exp", "acc-exp", "Export Workspace", "exp"],
    );

    return { pool, objectStore, obsRepo, sessionRepo, evidenceRepo, retentionRepo, exportService, tenant };
  };

  it("should export session observations and evidence into object storage", async () => {
    const { sessionRepo, obsRepo, evidenceRepo, exportService, objectStore, tenant } = await setup();

    await sessionRepo.createSession(tenant, { id: "sess-export-1" });
    await sessionRepo.createBranch(tenant, {
      id: "branch-exp-main",
      sessionId: "sess-export-1",
      name: "main",
    });

    const e1 = await obsRepo.insertEvent(tenant, {
      eventId: "evt-exp-1",
      schemaVersion: "1.0.0",
      sessionId: "sess-export-1",
      timestamp: "2026-08-17T12:00:00.000Z",
      type: "message",
      role: "user",
      content: "Export test prompt",
      causalRef: { causalSequence: 1 },
    });

    await evidenceRepo.createEvidenceSet(tenant, {
      id: "ev-set-export",
      sessionId: "sess-export-1",
      name: "Export Set",
      eventIds: [e1.id],
    });

    const job = await exportService.exportData(tenant, {
      scope: "session",
      targetId: "sess-export-1",
      requestedBy: "admin-user",
    });

    expect(job.status).toBe("completed");
    expect(job.recordCount).toBeGreaterThanOrEqual(3);
    expect(job.exportPath).not.toBeNull();

    // Verify object was written to ObjectStore
    if (job.exportPath) {
      const exists = await objectStore.exists(job.exportPath);
      expect(exists).toBe(true);
      const data = await objectStore.getObject(job.exportPath);
      expect(data).not.toBeNull();
      const parsed = JSON.parse(data.toString("utf8"));
      expect(parsed.manifest.scope).toBe("session");
      expect(parsed.events.length).toBe(1);
    }
  });

  it("should block deletion if target has active retention hold", async () => {
    const { sessionRepo, retentionRepo, exportService, tenant } = await setup();

    await sessionRepo.createSession(tenant, { id: "sess-held-delete" });
    await retentionRepo.createHold(tenant, {
      targetType: "session",
      targetId: "sess-held-delete",
      holdType: "legal",
      reason: "Litigation hold",
    });

    // Attempt deletion without force -> should reject with ActiveRetentionHoldBlockedError
    await expect(
      exportService.deleteData(tenant, {
        scope: "session",
        targetId: "sess-held-delete",
      }),
    ).rejects.toThrow(ActiveRetentionHoldBlockedError);

    // Session should still exist
    const session = await sessionRepo.getSessionById(tenant, "sess-held-delete");
    expect(session).not.toBeNull();
  });

  it("should cascade delete session observations, branches, and evidence when unheld", async () => {
    const { sessionRepo, obsRepo, evidenceRepo, exportService, tenant } = await setup();

    await sessionRepo.createSession(tenant, { id: "sess-cascade" });
    await sessionRepo.createBranch(tenant, {
      id: "branch-cascade",
      sessionId: "sess-cascade",
      name: "branch-cascade",
    });

    const evt = await obsRepo.insertEvent(tenant, {
      eventId: "evt-cascade-1",
      schemaVersion: "1.0.0",
      sessionId: "sess-cascade",
      timestamp: "2026-08-17T12:00:00.000Z",
      type: "message",
      role: "user",
      content: "Delete me",
      causalRef: { causalSequence: 1 },
    });

    await evidenceRepo.createEvidenceSet(tenant, {
      id: "ev-set-cascade",
      sessionId: "sess-cascade",
      name: "Cascade Evidence",
      eventIds: [evt.id],
    });

    // Execute deletion
    const job = await exportService.deleteData(tenant, {
      scope: "session",
      targetId: "sess-cascade",
    });

    expect(job.status).toBe("completed");
    expect(job.deletedRecordsCount).toBeGreaterThanOrEqual(4);

    // Verify all records gone
    expect(await sessionRepo.getSessionById(tenant, "sess-cascade")).toBeNull();
    expect(await sessionRepo.getBranchById(tenant, "branch-cascade")).toBeNull();
    expect(await obsRepo.getEventById(tenant, "evt-cascade-1")).toBeNull();
    expect(await evidenceRepo.getEvidenceSetById(tenant, "ev-set-cascade")).toBeNull();
  });
});
