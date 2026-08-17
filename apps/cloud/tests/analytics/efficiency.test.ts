import { describe, expect, it, beforeEach } from "vitest";
import { EfficiencyCalculator } from "../../src/analytics/efficiency.js";
import { MetricsRepository } from "../../src/analytics/repositories/metrics-repository.js";
import { MemoryDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";

describe("EfficiencyCalculator: Measured vs Counterfactual Savings & Uncertainty Bounds", () => {
  let pool: MemoryDatabasePool;
  let repo: MetricsRepository;
  let calculator: EfficiencyCalculator;

  const workspaceId = "ws_eff_001";
  const toolId = "code_optimizer";
  const version = "1.5.0";
  const windowStart = "2026-08-17T08:00:00.000Z";
  const windowEnd = "2026-08-17T12:00:00.000Z";

  beforeEach(async () => {
    pool = new MemoryDatabasePool();
    await runMigrations(pool);
    repo = new MetricsRepository(pool);
    calculator = new EfficiencyCalculator(pool, repo);
  });

  it("should calculate efficiency for 0 invocations without NaN", async () => {
    const result = await calculator.calculateEfficiency({
      workspaceId,
      toolId,
      version,
      windowStart,
      windowEnd,
    });

    expect(result.invocationCount).toBe(0);
    expect(result.measuredSavings.durationMsSaved).toBe(0);
    expect(result.measuredSavings.tokensSaved).toBe(0);
    expect(result.measuredSavings.estimatedCostSavedUsd).toBe(0);
    expect(result.counterfactualSavings.lowerBoundUsd).toBeGreaterThanOrEqual(0);
    expect(result.netSavingsScore).toBeGreaterThanOrEqual(0);
    expect(result.netSavingsScore).toBeLessThanOrEqual(100);
  });

  it("should separate measured savings from counterfactual uncertainty bounds", async () => {
    // Insert 50 invocations with average latency ~500ms (baseline is 1500ms)
    for (let i = 0; i < 50; i++) {
      const dur = 400 + (i % 20) * 10; // 400ms to 590ms
      await pool.query(
        `INSERT INTO rollout_telemetry_events (
          id, workspace_id, device_id, session_id, tool_id, version,
          success, duration_ms, security_violation, quarantine_signal,
          capability_breach, schema_mismatch, signature_valid, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          `evt_eff_${i}`,
          workspaceId,
          "dev_1",
          `sess_${i}`,
          toolId,
          version,
          true,
          dur,
          false,
          false,
          false,
          false,
          true,
          "2026-08-17T09:00:00.000Z",
        ],
      );
    }

    const result = await calculator.calculateEfficiency({
      workspaceId,
      toolId,
      version,
      baselineVersion: "1.0.0",
      windowStart,
      windowEnd,
      baselineP95LatencyMs: 1500,
      baselineTokensPerInvocation: 600,
      developerHourlyRateUsd: 80.0,
      costPer1kTokensUsd: 0.003,
    });

    expect(result.invocationCount).toBe(50);

    // 1. Measured Savings
    expect(result.measuredSavings.durationMsSaved).toBeGreaterThan(0);
    expect(result.measuredSavings.tokensSaved).toBeGreaterThan(0);
    expect(result.measuredSavings.stepsAvoided).toBeGreaterThan(0);
    expect(result.measuredSavings.estimatedCostSavedUsd).toBeGreaterThan(0);

    // 2. Counterfactual Savings
    expect(result.counterfactualSavings.confidenceLevel).toBe(0.95);
    expect(result.counterfactualSavings.lowerBoundUsd).toBeLessThanOrEqual(result.counterfactualSavings.upperBoundUsd);
    expect(result.counterfactualSavings.standardErrorUsd).toBeGreaterThanOrEqual(0);

    // 3. Net Savings Score
    expect(result.netSavingsScore).toBeGreaterThan(50);
    expect(result.netSavingsScore).toBeLessThanOrEqual(100);
  });
});
