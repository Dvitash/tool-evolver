import { beforeEach, describe, expect, it } from "vitest";
import { AnomalyDetector } from "../../src/analytics/anomaly.js";
import { MetricsRepository } from "../../src/analytics/repositories/metrics-repository.js";
import type { TelemetryBatchRequest } from "../../src/analytics/types.js";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";

describe("AnomalyDetector: Lifecycle Sequences & Cardinality Integrity", () => {
  let pool: MemoryDatabasePool;
  let repo: MetricsRepository;
  let detector: AnomalyDetector;

  const workspaceId = "ws_anom_001";

  beforeEach(async () => {
    pool = new MemoryDatabasePool();
    await runMigrations(pool);
    repo = new MetricsRepository(pool);
    detector = new AnomalyDetector(pool, repo);
  });

  it("should detect future timestamps as impossible sequence anomalies", async () => {
    const futureTime = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 minutes
    const batch: TelemetryBatchRequest = {
      batchId: "batch_future_1",
      deviceId: "dev_1",
      installationId: "inst_1",
      workspaceId,
      timestamp: futureTime,
      metrics: [],
      invocations: [],
    };

    const alerts = await detector.checkBatch(workspaceId, batch);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].anomalyType).toBe("impossible_timestamp");
    expect(alerts[0].severity).toBe("critical");
  });

  it("should detect cardinality explosions when batch contains too many distinct tools", async () => {
    const metrics = [];
    for (let i = 0; i < 60; i++) {
      metrics.push({
        metricName: "tool.invocation",
        value: 1,
        tags: { toolId: `random_tool_${i}` },
        timestamp: new Date().toISOString(),
      });
    }

    const batch: TelemetryBatchRequest = {
      batchId: "batch_cardinality_1",
      deviceId: "dev_1",
      installationId: "inst_1",
      workspaceId,
      timestamp: new Date().toISOString(),
      metrics,
      invocations: [],
    };

    const alerts = await detector.checkBatch(workspaceId, batch);
    const cardinalityAlert = alerts.find((a) => a.anomalyType === "cardinality_explosion");
    expect(cardinalityAlert).toBeDefined();
    expect(cardinalityAlert?.severity).toBe("critical");
  });

  it("should detect invocation before tool activation timestamp", async () => {
    const activatedAt = "2026-08-17T12:00:00.000Z";
    const reportedStartedAt = "2026-08-17T11:30:00.000Z"; // 30 minutes before activation

    const batch: TelemetryBatchRequest = {
      batchId: "batch_early_inv",
      deviceId: "dev_1",
      installationId: "inst_1",
      workspaceId,
      timestamp: "2026-08-17T12:05:00.000Z",
      metrics: [],
      invocations: [
        {
          invocationId: "inv_early_1",
          sessionId: "sess_1",
          workspaceId,
          toolId: "new_optimizer",
          toolVersion: "2.0.0",
          startedAt: reportedStartedAt,
          completedAt: "2026-08-17T11:30:01.000Z",
          durationMs: 1000,
          status: "success",
          inputDigest: "a".repeat(64),
        },
      ],
    };

    const alerts = await detector.checkBatch(workspaceId, batch, {
      activeRolloutTimestamps: {
        "new_optimizer:2.0.0": activatedAt,
      },
    });

    const earlyAlert = alerts.find((a) => a.anomalyType === "invocation_before_activation");
    expect(earlyAlert).toBeDefined();
    expect(earlyAlert?.severity).toBe("critical");
  });

  it("should detect invocation of revoked tool versions without shadowRun flag", async () => {
    const batch: TelemetryBatchRequest = {
      batchId: "batch_revoked_inv",
      deviceId: "dev_1",
      installationId: "inst_1",
      workspaceId,
      timestamp: new Date().toISOString(),
      metrics: [],
      invocations: [
        {
          invocationId: "inv_revoked_1",
          sessionId: "sess_1",
          workspaceId,
          toolId: "deprecated_tool",
          toolVersion: "0.9.0",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 100,
          status: "success",
          inputDigest: "a".repeat(64),
          resourceUsage: {
            cpuTimeMs: 10,
            memoryBytes: 1024,
            shadowRun: false,
          },
        },
      ],
    };

    const alerts = await detector.checkBatch(workspaceId, batch, {
      revokedVersions: {
        "deprecated_tool:0.9.0": true,
      },
    });

    const revokedAlert = alerts.find((a) => a.anomalyType === "revoked_tool_invocation");
    expect(revokedAlert).toBeDefined();
  });

  it("should detect monotonic counter resets in a session", async () => {
    // Sequence 1: 10
    const alert1 = await detector.checkSequenceCounter(
      workspaceId,
      "sess_1",
      "tool_x",
      "1.0.0",
      10,
    );
    expect(alert1).toBeNull();

    // Sequence 2: 25 (increasing, normal)
    const alert2 = await detector.checkSequenceCounter(
      workspaceId,
      "sess_1",
      "tool_x",
      "1.0.0",
      25,
    );
    expect(alert2).toBeNull();

    // Sequence 3: 5 (counter decreased -> reset anomaly)
    const alert3 = await detector.checkSequenceCounter(workspaceId, "sess_1", "tool_x", "1.0.0", 5);
    expect(alert3).not.toBeNull();
    expect(alert3?.anomalyType).toBe("counter_reset");
  });

  it("should resolve anomaly alerts via repository", async () => {
    const alert = await detector.checkSequenceCounter(
      workspaceId,
      "sess_res",
      "tool_r",
      "1.0.0",
      100,
    );
    await detector.checkSequenceCounter(workspaceId, "sess_res", "tool_r", "1.0.0", 50);

    const alerts = await repo.queryAnomalyAlerts({ workspaceId, resolved: false });
    expect(alerts.length).toBe(1);

    const resolved = await repo.resolveAnomalyAlert(workspaceId, alerts[0].id);
    expect(resolved).toBe(true);

    const after = await repo.queryAnomalyAlerts({ workspaceId, resolved: false });
    expect(after.length).toBe(0);
  });
});
