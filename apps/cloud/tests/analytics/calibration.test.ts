import { describe, expect, it, beforeEach } from "vitest";
import { EvaluationCalibrator } from "../../src/analytics/calibration.js";
import { RolloutWindowMaterializer } from "../../src/analytics/materializer.js";
import { MetricsRepository } from "../../src/analytics/repositories/metrics-repository.js";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";

describe("EvaluationCalibrator: Predeployment Predictions vs Canary Outcomes", () => {
  let pool: MemoryDatabasePool;
  let repo: MetricsRepository;
  let materializer: RolloutWindowMaterializer;
  let calibrator: EvaluationCalibrator;

  const workspaceId = "ws_cal_001";
  const toolId = "unit_test_generator";
  const version = "3.0.0";
  const candidateId = "cand_abc_123";
  const evaluationId = "eval_xyz_789";

  beforeEach(async () => {
    pool = new MemoryDatabasePool();
    await runMigrations(pool);
    repo = new MetricsRepository(pool);
    materializer = new RolloutWindowMaterializer(pool, repo);
    calibrator = new EvaluationCalibrator(pool, repo);
  });

  it("should record a concordant calibration when prediction closely matches outcome", async () => {
    // 20 successful invocations with ~200ms latency
    for (let i = 0; i < 20; i++) {
      await pool.query(
        `INSERT INTO rollout_telemetry_events (
          id, workspace_id, device_id, session_id, tool_id, version,
          success, duration_ms, security_violation, quarantine_signal,
          capability_breach, schema_mismatch, signature_valid, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          `evt_cal_${i}`,
          workspaceId,
          "dev_1",
          `sess_${i}`,
          toolId,
          version,
          true,
          200,
          false,
          false,
          false,
          false,
          true,
          "2026-08-17T10:00:00.000Z",
        ],
      );
    }

    // Materialize the rollout window
    await materializer.materializeWindow({
      workspaceId,
      toolId,
      version,
      windowStart: "2026-08-17T09:00:00.000Z",
      windowEnd: "2026-08-17T11:00:00.000Z",
    });

    const calibration = await calibrator.calibrateEvaluation({
      workspaceId,
      toolId,
      version,
      candidateId,
      evaluationId,
      predictedSuccessRate: 0.95,
      predictedP95LatencyMs: 220,
      predictedTokenSavings: 50,
    });

    expect(calibration.candidateId).toBe(candidateId);
    expect(calibration.evaluationId).toBe(evaluationId);
    expect(calibration.actualSuccessRate).toBe(1.0);
    expect(calibration.actualP95LatencyMs).toBe(200);
    expect(calibration.decisionOutcome).toBe("concordant");
    expect(calibration.predictionError.brierScore).toBeLessThan(0.05);

    // Verify stored record in repository
    const stored = await repo.queryCalibrations({ workspaceId, toolId, version });
    expect(stored.length).toBe(1);
    expect(stored[0].decisionOutcome).toBe("concordant");
  });

  it("should classify optimistic false positive when predicted high success but actual failed", async () => {
    // 10 invocations with only 3 successes (30% success rate)
    for (let i = 0; i < 10; i++) {
      await pool.query(
        `INSERT INTO rollout_telemetry_events (
          id, workspace_id, device_id, session_id, tool_id, version,
          success, duration_ms, security_violation, quarantine_signal,
          capability_breach, schema_mismatch, signature_valid, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          `evt_fail_${i}`,
          workspaceId,
          "dev_1",
          `sess_${i}`,
          toolId,
          version,
          i < 3,
          800,
          false,
          false,
          false,
          false,
          true,
          "2026-08-17T10:00:00.000Z",
        ],
      );
    }

    await materializer.materializeWindow({
      workspaceId,
      toolId,
      version,
      windowStart: "2026-08-17T09:00:00.000Z",
      windowEnd: "2026-08-17T11:00:00.000Z",
    });

    const calibration = await calibrator.calibrateEvaluation({
      workspaceId,
      toolId,
      version,
      candidateId,
      evaluationId,
      predictedSuccessRate: 0.95, // Optimistic prediction
      predictedP95LatencyMs: 200,
    });

    expect(calibration.actualSuccessRate).toBe(0.3);
    expect(calibration.decisionOutcome).toBe("optimistic_false_positive");
  });

  it("should classify pessimistic false negative when predicted low success but actual succeeded", async () => {
    // 10 invocations with 10 successes (100% success rate)
    for (let i = 0; i < 10; i++) {
      await pool.query(
        `INSERT INTO rollout_telemetry_events (
          id, workspace_id, device_id, session_id, tool_id, version,
          success, duration_ms, security_violation, quarantine_signal,
          capability_breach, schema_mismatch, signature_valid, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          `evt_succ_${i}`,
          workspaceId,
          "dev_1",
          `sess_${i}`,
          toolId,
          version,
          true,
          150,
          false,
          false,
          false,
          false,
          true,
          "2026-08-17T10:00:00.000Z",
        ],
      );
    }

    await materializer.materializeWindow({
      workspaceId,
      toolId,
      version,
      windowStart: "2026-08-17T09:00:00.000Z",
      windowEnd: "2026-08-17T11:00:00.000Z",
    });

    const calibration = await calibrator.calibrateEvaluation({
      workspaceId,
      toolId,
      version,
      candidateId,
      evaluationId,
      predictedSuccessRate: 0.50, // Pessimistic prediction
      predictedP95LatencyMs: 150,
    });

    expect(calibration.actualSuccessRate).toBe(1.0);
    expect(calibration.decisionOutcome).toBe("pessimistic_false_negative");
  });
});
