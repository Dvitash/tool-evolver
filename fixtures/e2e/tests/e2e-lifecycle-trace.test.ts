import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermeticE2EEnvironment } from "../src/environment.js";
import { runAdversarialSecurityScenario } from "../src/scenarios/adversarial-security.js";
import { runCanaryPromotionScenario } from "../src/scenarios/canary-promotion.js";
import { runCloudMcpProxyScenario } from "../src/scenarios/cloud-mcp-proxy.js";
import { runCrossHarnessIsolationScenario } from "../src/scenarios/cross-harness-isolation.js";
import { runHappyPathScenario } from "../src/scenarios/happy-path.js";
import { runOfflineRecoveryScenario } from "../src/scenarios/offline-recovery.js";
import { runRollbackScenario } from "../src/scenarios/rollback.js";
import { runUserControlsScenario } from "../src/scenarios/user-controls.js";

describe("E2E - Offline Recovery & Machine-Readable Lifecycle Trace Report", () => {
  let env: HermeticE2EEnvironment;

  beforeEach(async () => {
    env = new HermeticE2EEnvironment();
    await env.initialize();
  });

  afterEach(async () => {
    await env.shutdown();
  });

  it("recovers across durable boundaries: cursor checkpointing, upload receipt dedup, and activation transaction", async () => {
    const recoveryResult = await runOfflineRecoveryScenario(env);

    expect(recoveryResult.success).toBe(true);
    expect(recoveryResult.transcriptRecoverySuccess).toBe(true);
    expect(recoveryResult.uploadDeduplicationSuccess).toBe(true);
    expect(recoveryResult.activationCrashResilienceSuccess).toBe(true);
  });

  it("executes all evolution scenarios and produces a clean machine-readable V1 lifecycle trace audit report", async () => {
    await runHappyPathScenario(env);
    await runCanaryPromotionScenario(env);
    await runRollbackScenario(env);
    await runUserControlsScenario(env);
    await runOfflineRecoveryScenario(env);
    await runCrossHarnessIsolationScenario(env);
    await runAdversarialSecurityScenario(env);
    await runCloudMcpProxyScenario(env);

    const reporter = env.traceReporter;
    const report = reporter.getReport();
    expect(reporter.hasFailures(), JSON.stringify(report, null, 2)).toBe(false);

    const summary = reporter.getSummary();
    expect(summary.total).toBeGreaterThanOrEqual(30);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(summary.total);

    expect(report.reportId).toBeTruthy();
    expect(report.environment.platform).toBeTruthy();
    expect(report.summary.passed).toBe(summary.total);

    // Verify categories are populated
    expect(report.categories.functional.passed).toBeGreaterThan(0);
    expect(report.categories.reliability.passed).toBeGreaterThan(0);
    expect(report.categories.isolation.passed).toBeGreaterThan(0);
    expect(report.categories.security.passed).toBeGreaterThan(0);
    expect(report.categories["user-controls"].passed).toBeGreaterThan(0);
    expect(report.categories["cloud-proxy"].passed).toBeGreaterThan(0);

    const jsonReport = reporter.exportJson();
    const parsed = JSON.parse(jsonReport);
    expect(parsed.summary.failed).toBe(0);
  });
});
