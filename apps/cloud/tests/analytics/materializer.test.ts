import { describe, expect, it, beforeEach } from "vitest";
import { RolloutWindowMaterializer } from "../../src/analytics/materializer.js";
import { MetricsRepository } from "../../src/analytics/repositories/metrics-repository.js";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";

describe("RolloutWindowMaterializer: Protected Metric Windows for TE-037", () => {
  let pool: MemoryDatabasePool;
  let repo: MetricsRepository;
  let materializer: RolloutWindowMaterializer;

  const workspaceId = "ws_test_001";
  const toolId = "fast_search_tool";
  const version = "2.0.0";
  const windowStart = "2026-08-17T10:00:00.000Z";
  const windowEnd = "2026-08-17T11:00:00.000Z";

  beforeEach(async () => {
    pool = new MemoryDatabasePool();
    await runMigrations(pool);
    repo = new MetricsRepository(pool);
    materializer = new RolloutWindowMaterializer(pool, repo);
  });

  it("should materialize an empty window when no events exist", async () => {
    const window = await materializer.materializeWindow({
      workspaceId,
      toolId,
      version,
      windowStart,
      windowEnd,
    });

    expect(window.totalInvocations).toBe(0);
    expect(window.successRate).toBe(0);
    expect(window.errorRate).toBe(0);
    expect(window.p95LatencyMs).toBe(0);
    expect(window.confidence).toBe(0);
  });

  it("should compute accurate rates, percentiles, and confidence from telemetry events", async () => {
    // Insert 20 telemetry events (18 success, 2 failures, varying latencies, 3 devices)
    const latencies = [
      50, 55, 60, 65, 70, 75, 80, 85, 90, 95,
      100, 105, 110, 115, 120, 130, 140, 150, 200, 500,
    ];

    for (let i = 0; i < 20; i++) {
      const isSuccess = i < 18;
      const deviceId = `dev_${(i % 3) + 1}`;
      await pool.query(
        `INSERT INTO rollout_telemetry_events (
          id, workspace_id, device_id, session_id, tool_id, version,
          success, duration_ms, security_violation, quarantine_signal,
          capability_breach, schema_mismatch, signature_valid, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          `evt_${i}`,
          workspaceId,
          deviceId,
          `sess_${i}`,
          toolId,
          version,
          isSuccess,
          latencies[i],
          i === 19, // 1 security violation
          false,
          false,
          false,
          true,
          "2026-08-17T10:30:00.000Z",
        ],
      );
    }

    const window = await materializer.materializeWindow({
      workspaceId,
      toolId,
      version,
      windowStart,
      windowEnd,
      expectedActiveDevices: 3,
      baselineP95LatencyMs: 250,
    });

    expect(window.totalInvocations).toBe(20);
    expect(window.successCount).toBe(18);
    expect(window.failureCount).toBe(2);
    expect(window.successRate).toBe(0.9);
    expect(window.errorRate).toBe(0.1);
    expect(window.p50LatencyMs).toBeGreaterThanOrEqual(95);
    expect(window.p95LatencyMs).toBeGreaterThanOrEqual(200);
    expect(window.securityViolations).toBe(1);
    expect(window.activeDevicesCount).toBe(3);
    expect(window.deviceReportingRate).toBe(1.0);
    expect(window.confidence).toBeGreaterThan(0.4);

    // Latency regression compared to baseline (250ms)
    expect(window.baselineP95LatencyMs).toBe(250);
    expect(window.latencyRegressionPercent).toBeDefined();

    // Verify converted CanaryMetricsWindow for TE-037
    const canaryWindow = materializer.toCanaryMetricsWindow(window);
    expect(canaryWindow.totalInvocations).toBe(20);
    expect(canaryWindow.successRate).toBe(0.9);
    expect(canaryWindow.p95LatencyMs).toBe(window.p95LatencyMs);
  });

  it("should record quarantine signals and reasons correctly", async () => {
    await pool.query(
      `INSERT INTO rollout_telemetry_events (
        id, workspace_id, device_id, session_id, tool_id, version,
        success, duration_ms, security_violation, quarantine_signal, quarantine_reason,
        capability_breach, schema_mismatch, signature_valid, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        "evt_q_1",
        workspaceId,
        "dev_1",
        "sess_q",
        toolId,
        version,
        false,
        100,
        false,
        true,
        "TE-024 local anomaly detected",
        false,
        false,
        true,
        "2026-08-17T10:15:00.000Z",
      ],
    );

    const window = await materializer.materializeWindow({
      workspaceId,
      toolId,
      version,
      windowStart,
      windowEnd,
    });

    expect(window.quarantineSignals).toBe(1);
    expect(window.quarantineReasons).toContain("TE-024 local anomaly detected");
  });
});
