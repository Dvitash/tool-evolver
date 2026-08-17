import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermeticE2EEnvironment } from "../src/environment.js";
import { runCanaryPromotionScenario } from "../src/scenarios/canary-promotion.js";
import { runRollbackScenario } from "../src/scenarios/rollback.js";

describe("E2E - Canary Rollouts & Autonomous Rollback", () => {
  let env: HermeticE2EEnvironment;

  beforeEach(async () => {
    env = new HermeticE2EEnvironment();
    await env.initialize();
  });

  afterEach(async () => {
    await env.shutdown();
  });

  it("autonomously promotes canary deployment upon healthy invocation telemetry", async () => {
    const canaryResult = await runCanaryPromotionScenario(env);

    expect(canaryResult.success).toBe(true);
    expect(canaryResult.telemetryIngested).toBeGreaterThan(0);
    expect(canaryResult.rolloutId).toBeTruthy();

    const report = env.traceReporter.getReport();
    expect(report.summary.passed).toBeGreaterThan(0);
    expect(report.summary.failed).toBe(0);
  });

  it("triggers automatic rollback to exact known-good version on regressive update and quarantines digest", async () => {
    const rollbackResult = await runRollbackScenario(env);

    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.baselineVersion).toBe("1.0.0");
    expect(rollbackResult.regressiveVersion).toBe("1.1.0");
    expect(rollbackResult.rolledBackToVersion).toBe("1.0.0");
    expect(rollbackResult.isQuarantined).toBe(true);
    expect(rollbackResult.subsequentInvocationSuccess).toBe(true);
  });
});
