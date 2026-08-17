import { beforeEach, describe, expect, it } from "vitest";
import { AnalyticsService, AnalyticsTenantMismatchError } from "../../src/analytics/service.js";
import type { TelemetryBatchRequest } from "../../src/analytics/types.js";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import type { TenantContext } from "../../src/tenant.js";

describe("AnalyticsService: End-to-End Ingestion, Isolation & Cascade", () => {
  let pool: MemoryDatabasePool;
  let service: AnalyticsService;

  const tenantA: TenantContext = {
    accountId: "acc_alpha",
    workspaceId: "ws_alpha",
  };

  const tenantB: TenantContext = {
    accountId: "acc_beta",
    workspaceId: "ws_beta",
  };

  const sampleBatch: TelemetryBatchRequest = {
    batchId: "batch_svc_001",
    deviceId: "dev_svc_1",
    installationId: "inst_svc_1",
    workspaceId: "ws_alpha",
    timestamp: "2026-08-17T12:00:00.000Z",
    metrics: [
      {
        metricName: "tool.cpu_time_ms",
        value: 45,
        unit: "ms",
        tags: { toolId: "linter_tool", version: "1.0.0" },
        timestamp: "2026-08-17T12:00:00.000Z",
      },
    ],
    invocations: [
      {
        invocationId: "inv_svc_1",
        sessionId: "sess_svc_1",
        workspaceId: "ws_alpha",
        toolId: "linter_tool",
        toolVersion: "1.0.0",
        startedAt: "2026-08-17T11:59:58.000Z",
        completedAt: "2026-08-17T12:00:00.000Z",
        durationMs: 2000,
        status: "success",
        inputDigest: "c".repeat(64),
      },
    ],
  };

  beforeEach(async () => {
    pool = new MemoryDatabasePool();
    await runMigrations(pool);
    service = new AnalyticsService(pool);
  });

  it("should ingest a valid telemetry batch and populate buckets and rollout events", async () => {
    const res = await service.ingestBatch(tenantA, sampleBatch);
    expect(res.status).toBe("accepted");
    expect(res.processedCount).toBe(2);

    // Query buckets
    const buckets = await service.queryBuckets(tenantA, {
      toolId: "linter_tool",
    });
    expect(buckets.length).toBeGreaterThanOrEqual(1);

    // Verify rollout telemetry events table
    const eventsRes = await pool.query(
      `SELECT * FROM rollout_telemetry_events WHERE workspace_id = $1`,
      [tenantA.workspaceId],
    );
    expect(eventsRes.rows.length).toBe(1);
    expect(eventsRes.rows[0].tool_id).toBe("linter_tool");
  });

  it("should reject batch with tenant workspace mismatch", async () => {
    await expect(service.ingestBatch(tenantB, sampleBatch)).rejects.toThrow(
      AnalyticsTenantMismatchError,
    );
  });

  it("should enforce strict tenant data isolation", async () => {
    // Ingest data for Tenant A
    await service.ingestBatch(tenantA, sampleBatch);

    // Tenant B queries buckets
    const tenantBBuckets = await service.queryBuckets(tenantB, {
      toolId: "linter_tool",
    });
    expect(tenantBBuckets.length).toBe(0);

    // Tenant B materializes window
    const windowB = await service.materializeRolloutWindow(tenantB, {
      toolId: "linter_tool",
      version: "1.0.0",
      windowStart: "2026-08-17T11:00:00.000Z",
      windowEnd: "2026-08-17T13:00:00.000Z",
    });
    expect(windowB.totalInvocations).toBe(0);

    // Tenant A materializes window
    const windowA = await service.materializeRolloutWindow(tenantA, {
      toolId: "linter_tool",
      version: "1.0.0",
      windowStart: "2026-08-17T11:00:00.000Z",
      windowEnd: "2026-08-17T13:00:00.000Z",
    });
    expect(windowA.totalInvocations).toBe(1);
  });

  it("should export and cascade delete tenant analytics data cleanly", async () => {
    // 1. Ingest batch and create windows, efficiency, calibration, anomaly
    await service.ingestBatch(tenantA, sampleBatch);
    await service.materializeRolloutWindow(tenantA, {
      toolId: "linter_tool",
      version: "1.0.0",
      windowStart: "2026-08-17T11:00:00.000Z",
    });
    await service.calculateEfficiency(tenantA, {
      toolId: "linter_tool",
      version: "1.0.0",
      windowStart: "2026-08-17T11:00:00.000Z",
    });
    await service.calibrateEvaluation(tenantA, {
      toolId: "linter_tool",
      version: "1.0.0",
      candidateId: "cand_1",
      evaluationId: "eval_1",
      predictedSuccessRate: 0.9,
      predictedP95LatencyMs: 2000,
    });

    // 2. Export tenant data
    const exported = await service.exportTenantData(tenantA);
    expect(exported.buckets.length).toBeGreaterThan(0);
    expect(exported.windows.length).toBe(1);
    expect(exported.efficiency.length).toBe(1);
    expect(exported.calibrations.length).toBe(1);

    // 3. Cascade delete
    const deletion = await service.deleteTenantData(tenantA);
    expect(deletion.deletedBuckets).toBeGreaterThan(0);
    expect(deletion.deletedWindows).toBe(1);
    expect(deletion.deletedEfficiency).toBe(1);
    expect(deletion.deletedCalibrations).toBe(1);

    // 4. Verify tables are now empty for tenant A
    const afterBuckets = await service.queryBuckets(tenantA, {});
    expect(afterBuckets.length).toBe(0);
    const afterWindows = await service.queryRolloutWindows(tenantA, {});
    expect(afterWindows.length).toBe(0);
  });
});
