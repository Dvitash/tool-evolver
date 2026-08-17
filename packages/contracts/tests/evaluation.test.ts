import { describe, expect, it } from "vitest";
import { validEvaluationResult } from "../fixtures/index.js";
import {
  EvaluationDecisionSchema,
  EvaluationDimensionNameSchema,
  EvaluationDimensionSchema,
  EvaluationResultSchema,
  EvaluationVerdictSchema,
} from "../src/evaluation.js";

describe("evaluation contracts", () => {
  describe("EvaluationDimensionSchema", () => {
    it("parses valid dimension scores", () => {
      const dim = EvaluationDimensionSchema.parse({
        name: "latency",
        weight: 0.3,
        score: 0.95,
        threshold: 0.8,
        passed: true,
        metrics: { p95Ms: 15.2, speedupRatio: 2.5 },
      });
      expect(dim.name).toBe("latency");
      expect(dim.passed).toBe(true);
    });

    it("rejects score greater than 1", () => {
      expect(() =>
        EvaluationDimensionSchema.parse({
          name: "security",
          weight: 1,
          score: 1.5,
          threshold: 0.8,
          passed: true,
        }),
      ).toThrow();
    });

    it("accepts all valid dimension names", () => {
      const dims = [
        "test",
        "replay",
        "security",
        "quality",
        "latency",
        "reliability",
        "token_savings",
      ];
      for (const d of dims) {
        expect(EvaluationDimensionNameSchema.parse(d)).toBe(d);
      }
    });
  });

  describe("EvaluationDecisionSchema", () => {
    it("parses valid decision", () => {
      const decision = EvaluationDecisionSchema.parse({
        verdict: "pass",
        score: 0.92,
        confidence: 0.98,
        threshold: 0.85,
        evaluatedBy: "EvaluatorWorker-1",
        evaluatedAt: "2026-08-17T12:00:00.000Z",
      });
      expect(decision.verdict).toBe("pass");
    });

    it("validates verdict enum", () => {
      expect(EvaluationVerdictSchema.parse("pass")).toBe("pass");
      expect(EvaluationVerdictSchema.parse("fail")).toBe("fail");
      expect(EvaluationVerdictSchema.parse("conditional")).toBe("conditional");
      expect(() => EvaluationVerdictSchema.parse("maybe")).toThrow();
    });
  });

  describe("EvaluationResultSchema", () => {
    it("parses valid evaluation result fixture", () => {
      const parsed = EvaluationResultSchema.parse(validEvaluationResult);
      expect(parsed.evaluationId).toBe("eval_001");
      expect(parsed.dimensions).toHaveLength(4);
      expect(parsed.overallDecision.verdict).toBe("pass");
    });
  });
});
