import { describe, expect, it } from "vitest";
import { STANDARD_EVALUATION_POLICY_V1 } from "../../../src/evolution/evaluation/policy.js";
import { UpdateComparator } from "../../../src/evolution/evaluation/update-comparator.js";
import {
  createMockActiveBaseline,
  createMockReplayResult,
  createMockToolManifest,
  createMockValidationResult,
} from "./helpers.js";

describe("UpdateComparator (Update Regression Detection)", () => {
  const comparator = new UpdateComparator();
  const policy = STANDARD_EVALUATION_POLICY_V1;

  it("detects breaking schema changes when parameters from active baseline are removed", () => {
    const baseline = createMockActiveBaseline({
      manifest: {
        parameters: {
          type: "object",
          properties: {
            sourcePath: { type: "string" },
            destinationPath: { type: "string" },
            force: { type: "boolean" },
          },
          required: ["sourcePath", "destinationPath"],
          additionalProperties: false,
        },
      },
    });

    // Candidate removed 'destinationPath'
    const candidateManifest = createMockToolManifest({
      parameters: {
        type: "object",
        properties: {
          sourcePath: { type: "string" },
          force: { type: "boolean" },
        },
        required: ["sourcePath"],
        additionalProperties: false,
      },
    });

    const result = comparator.compare({
      candidateManifest,
      candidateSourceCode: "export default {}",
      baseline,
      policy,
    });

    expect(result.passed).toBe(false);
    expect(result.isBreakingChange).toBe(true);
    expect(result.criticalRegressionCount).toBeGreaterThanOrEqual(1);
    expect(result.findings.some((f) => f.dimension === "schema_compatibility")).toBe(true);
    expect(result.summary).toContain("destinationPath");
  });

  it("detects breaking schema changes when new required parameter is added", () => {
    const baseline = createMockActiveBaseline({
      manifest: {
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
          additionalProperties: false,
        },
      },
    });

    // Candidate added 'apiKey' as required without default
    const candidateManifest = createMockToolManifest({
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          apiKey: { type: "string" },
        },
        required: ["filePath", "apiKey"],
        additionalProperties: false,
      },
    });

    const result = comparator.compare({
      candidateManifest,
      candidateSourceCode: "export default {}",
      baseline,
      policy,
    });

    expect(result.passed).toBe(false);
    expect(result.isBreakingChange).toBe(true);
    expect(result.findings.some((f) => f.candidateValue === "required_param:apiKey")).toBe(true);
  });

  it("detects severe latency regressions exceeding threshold", () => {
    const baseline = createMockActiveBaseline({
      metrics: {
        latencyMs: 100,
        tokenUsage: 5,
        successRate: 1.0,
      },
      validationReport: createMockValidationResult({
        testReport: {
          suiteId: "s1",
          totalTests: 5,
          passed: 5,
          failed: 0,
          timeouts: 0,
          durationMs: 100,
          results: [],
        },
      }),
    });

    const candidateManifest = createMockToolManifest();
    const candidateValidation = createMockValidationResult({
      testReport: {
        suiteId: "s2",
        totalTests: 5,
        passed: 5,
        failed: 0,
        timeouts: 0,
        durationMs: 350, // 250% slower!
        results: [],
      },
    });

    const result = comparator.compare({
      candidateManifest,
      candidateSourceCode: "export default {}",
      candidateValidation,
      baseline,
      policy,
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.dimension === "latency_regression")).toBe(true);
    expect(result.summary).toContain("Latency regressed");
  });

  it("detects replay pass rate regressions relative to baseline", () => {
    const baselineReplay = createMockReplayResult({
      totalScenarioCount: 5,
      passedScenarioCount: 5, // 100% pass rate
    });

    const baseline = createMockActiveBaseline({
      replayReport: baselineReplay,
    });

    const candidateManifest = createMockToolManifest();
    const candidateReplay = createMockReplayResult({
      totalScenarioCount: 5,
      passedScenarioCount: 3, // 60% pass rate!
    });

    const result = comparator.compare({
      candidateManifest,
      candidateSourceCode: "export default {}",
      candidateReplay,
      baseline,
      policy,
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => f.dimension === "replay_pass_rate_regression")).toBe(true);
  });

  it("passes cleanly when update preserves compatibility and performance", () => {
    const baseline = createMockActiveBaseline({
      metrics: {
        latencyMs: 120,
        tokenUsage: 5,
        successRate: 1.0,
      },
    });

    const candidateManifest = createMockToolManifest();
    const candidateValidation = createMockValidationResult({
      testReport: {
        suiteId: "s1",
        totalTests: 5,
        passed: 5,
        failed: 0,
        timeouts: 0,
        durationMs: 95, // Faster!
        results: [],
      },
    });

    const candidateReplay = createMockReplayResult({
      totalScenarioCount: 4,
      passedScenarioCount: 4,
    });

    const result = comparator.compare({
      candidateManifest,
      candidateSourceCode: "export default {}",
      candidateValidation,
      candidateReplay,
      baseline,
      policy,
    });

    expect(result.passed).toBe(true);
    expect(result.criticalRegressionCount).toBe(0);
    expect(result.isBreakingChange).toBe(false);
  });
});
