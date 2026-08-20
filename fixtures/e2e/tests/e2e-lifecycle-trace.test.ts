import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_COST_SCHEDULE_ID_V1, calculateWeightedModelCost } from "@tool-evolver/cloud";
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
    const happyResult = await runHappyPathScenario(env);
    await runCanaryPromotionScenario(env);
    await runRollbackScenario(env);
    await runUserControlsScenario(env);
    await runOfflineRecoveryScenario(env);
    await runCrossHarnessIsolationScenario(env);
    await runAdversarialSecurityScenario(env);
    await runCloudMcpProxyScenario(env);

    // Happy-path must have passed both workflow_coverage and workload_cost_non_regression through normal replay/evaluation route
    // Inspect actual hardGateResult via evaluationDecision and benchmark bindings
    expect(happyResult.evaluationDecision).toBe("pass");
    expect(happyResult.workflowContract).toBeDefined();
    expect(happyResult.workflowCoverage?.complete).toBe(true);
    expect(happyResult.workflowCoverage?.uncoveredOperationIds).toEqual([]);
    expect(happyResult.workflowCoverage?.uncoveredOutputNames).toEqual([]);
    expect(happyResult.workloadBenchmarks).toBeDefined();
    expect(happyResult.workloadBenchmarks).toHaveLength(3);
    const sizes = (happyResult.workloadBenchmarks ?? []).map((b) => b.workloadSize).sort();
    expect(sizes).toEqual(["large", "medium", "small"]);
    const bms = happyResult.workloadBenchmarks ?? [];
    expect(new Set(bms.map((b) => b.benchmarkId)).size).toBe(3);
    expect(new Set(bms.map((b) => b.baselineRunId)).size).toBe(3);
    expect(new Set(bms.map((b) => b.candidateRunId)).size).toBe(3);
    expect(new Set(bms.map((b) => b.workloadInputDigest)).size).toBe(3);
    expect(new Set(bms.map((b) => b.candidateRevisionId)).size).toBe(1);
    expect(new Set(bms.map((b) => b.artifactDigest)).size).toBe(1);
    if (happyResult.candidateId) {
      for (const bm of bms) expect(bm.candidateRevisionId).toBe(happyResult.candidateId);
    }
    for (const bm of bms) {
      expect(bm.workloadInputDigest).toMatch(/^(sha256:)?[a-f0-9]{64}$/i);
      expect(bm.artifactDigest).toMatch(/^(sha256:)?[a-f0-9]{64}$/i);
      expect(bm.benchmarkId).toBeTruthy();
      expect(bm.baselineRunId).toBeTruthy();
      expect(bm.candidateRunId).toBeTruthy();
      expect(bm.modelProvider).toBeTruthy();
      expect(bm.modelId).toBeTruthy();
      expect(bm.observedAt).toBeTruthy();
      expect(() => new Date(bm.observedAt).toISOString()).not.toThrow();
      expect(bm.scheduleId).toBe(MODEL_COST_SCHEDULE_ID_V1);
      const recomputedBaseline = calculateWeightedModelCost(bm.baseline, bm.scheduleId);
      const recomputedCandidate = calculateWeightedModelCost(bm.candidate, bm.scheduleId);
      expect(bm.baselineCostUsd).toBeCloseTo(recomputedBaseline, 9);
      expect(bm.candidateCostUsd).toBeCloseTo(recomputedCandidate, 9);
      const expectedDelta = recomputedBaseline === 0 ? 0 : ((recomputedCandidate - recomputedBaseline) / recomputedBaseline) * 100;
      expect(bm.costDeltaPercent).toBeCloseTo(expectedDelta, 6);
      expect(bm.candidateCostUsd).toBeLessThanOrEqual(bm.baselineCostUsd);
      expect(bm.candidate.correct).toBe(true);
      expect(bm.correctnessPassed).toBe(true);
      expect(bm.redundantVerificationCalls).toBe(0);
      expect(bm.candidate.redundantToolCalls).toBe(0);
      if (bm.candidateCostUsd > bm.baselineCostUsd) {
        throw new Error(`Workload ${bm.workloadSize} cost regression in lifecycle trace: candidate ${bm.candidateCostUsd} > baseline ${bm.baselineCostUsd}`);
      }
      expect(bm.artifactDigest).not.toBe("d".repeat(64));
      expect(bm.workloadInputDigest).not.toBe("a".repeat(64));
    }

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
    // Retain full publish/lifecycle trace contract: artifact published, lifecycle replay/evaluation evidenced
    expect(happyResult.artifactPublished).toBe(true);
    expect(happyResult.candidateReplayed).toBe(true);
    expect(happyResult.candidateEvaluated).toBe(true);
    expect(happyResult.success).toBe(true);
  });
});
