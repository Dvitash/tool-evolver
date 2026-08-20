import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_COST_SCHEDULE_ID_V1, calculateWeightedModelCost } from "@tool-evolver/cloud";
import { HermeticE2EEnvironment } from "../src/environment.js";
import { runHappyPathScenario } from "../src/scenarios/happy-path.js";

describe("E2E - Autonomous Evolution Happy Path", () => {
  let env: HermeticE2EEnvironment;

  beforeEach(async () => {
    env = new HermeticE2EEnvironment();
    await env.initialize();
  });

  afterEach(async () => {
    await env.shutdown();
  });

  it("completes full autonomous tool lifecycle from repeated sessions to native & meta invocation", async () => {
    const result = await runHappyPathScenario(env);

    expect(result).toMatchObject({
      success: true,
      candidateValidated: true,
      candidateReplayed: true,
      candidateEvaluated: true,
      artifactPublished: true,
      localActivated: true,
      nativeInvocationSuccess: true,
      metaToolInvocationSuccess: true,
    });
    expect(result.toolName).toBeTruthy();

    // Verify trace assertions recorded cleanly
    const report = env.traceReporter.getReport();
    expect(report.summary.passed).toBeGreaterThan(0);
    expect(report.summary.failed).toBe(0);

    // Mandatory workflow promotion gates: workflow_coverage must be complete with no uncovered ids/names
    // Inspect actual evaluation hardGateResult/failedGates — must have passed both named gates and security via normal state
    expect(result.evaluationDecision).toBe("pass");
    expect(result.workflowContract).toBeDefined();
    expect(result.workflowContract!.operations.length).toBeGreaterThan(0);
    expect(result.workflowContract!.outputRequirements.length).toBeGreaterThan(0);
    expect(result.workflowCoverage).toBeDefined();
    expect(result.workflowCoverage!.complete).toBe(true);
    expect(result.workflowCoverage!.uncoveredOperationIds).toEqual([]);
    expect(result.workflowCoverage!.uncoveredOutputNames).toEqual([]);
    // Mandatory workload_cost_non_regression: exactly small/medium/large, correct=true, zero redundant, candidateCost <= baseline
    // Plus immutable evidence/pricing contract: distinct identities/digests per size, bound candidateRevisionId/artifactDigest, explicit model/prices, costs recomputed from prices
    expect(result.workloadBenchmarks).toBeDefined();
    expect(result.workloadBenchmarks).toHaveLength(3);
    const sizes = (result.workloadBenchmarks ?? []).map((b) => b.workloadSize).sort();
    expect(sizes).toEqual(["large", "medium", "small"]);
    const bms = result.workloadBenchmarks ?? [];
    // Distinct immutable evidence identities/digests
    expect(new Set(bms.map((b) => b.benchmarkId)).size).toBe(3);
    expect(new Set(bms.map((b) => b.baselineRunId)).size).toBe(3);
    expect(new Set(bms.map((b) => b.candidateRunId)).size).toBe(3);
    expect(new Set(bms.map((b) => b.workloadInputDigest)).size).toBe(3);
    // Bound candidateRevisionId/artifactDigest across rows
    expect(new Set(bms.map((b) => b.candidateRevisionId)).size).toBe(1);
    expect(new Set(bms.map((b) => b.artifactDigest)).size).toBe(1);
    if (result.candidateId) {
      for (const bm of bms) expect(bm.candidateRevisionId).toBe(result.candidateId);
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
        throw new Error(`Workload ${bm.workloadSize} cost regression detected: candidate ${bm.candidateCostUsd} > baseline ${bm.baselineCostUsd}`);
      }
      if (!bm.candidate.correct || bm.redundantVerificationCalls !== 0) {
        throw new Error(`Workload ${bm.workloadSize} evidence invalid: correct=${bm.candidate.correct} redundant=${bm.redundantVerificationCalls}`);
      }
      expect(bm.artifactDigest).not.toBe("d".repeat(64));
      expect(bm.workloadInputDigest).not.toBe("a".repeat(64));
    }
    // Ensure workload evidence would cause failure if missing - this assertion guarantees gate sensitivity
    const expectedSizes = ["small", "medium", "large"] as const;
    const missingSizes = expectedSizes.filter((s) => !sizes.includes(s));
    expect(missingSizes).toEqual([]);
  });

  it("discovers evolved tool in catalog via search_tools meta-tool", async () => {
    const result = await runHappyPathScenario(env);

    const searchRes = await env.invokeTool("search_tools", { query: result.toolName });
    expect(searchRes.success).toBe(true);
    const contentText = searchRes.content[0]?.text ?? "";
    expect(contentText).toContain(result.toolName);
  });

  it("inspects evolved tool schema via get_tool_schema meta-tool", async () => {
    const result = await runHappyPathScenario(env);

    const schemaRes = await env.invokeTool("get_tool_schema", { name: result.toolName });
    expect(schemaRes.success).toBe(true);
    const contentText = schemaRes.content[0]?.text ?? "";
    expect(contentText).toContain(result.toolName);
    expect(contentText).toContain("inputSchema");
  });
});
