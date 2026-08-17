import { describe, expect, it } from "vitest";
import { validEvolutionCandidate } from "../fixtures/index.js";
import {
  CandidateEvaluationSummarySchema,
  CandidateStateSchema,
  CandidateTriggerSchema,
  EvolutionCandidateSchema,
} from "../src/candidates.js";

describe("evolution candidates contracts", () => {
  describe("CandidateStateSchema", () => {
    it("accepts all valid candidate states", () => {
      const states = [
        "detected",
        "synthesizing",
        "synthesized",
        "evaluating",
        "evaluated",
        "approved",
        "rejected",
        "superseded",
        "failed",
      ];
      for (const s of states) {
        expect(CandidateStateSchema.parse(s)).toBe(s);
      }
    });

    it("rejects unknown candidate states", () => {
      expect(() => CandidateStateSchema.parse("in_progress")).toThrow();
    });
  });

  describe("CandidateTriggerSchema", () => {
    it("parses valid triggers", () => {
      const trigger = CandidateTriggerSchema.parse({
        reason: "repeated_pattern",
        evidenceEventIds: ["evt_01", "evt_02"],
        sessionOccurrences: 5,
        detectedAt: "2026-08-17T12:00:00.000Z",
        patternFrequency: 3.5,
      });
      expect(trigger.reason).toBe("repeated_pattern");
      expect(trigger.evidenceEventIds).toHaveLength(2);
    });

    it("rejects trigger with empty evidenceEventIds", () => {
      expect(() =>
        CandidateTriggerSchema.parse({
          reason: "repeated_pattern",
          evidenceEventIds: [],
          detectedAt: "2026-08-17T12:00:00.000Z",
        }),
      ).toThrow();
    });
  });

  describe("CandidateEvaluationSummarySchema", () => {
    it("parses valid evaluation summaries", () => {
      const summary = CandidateEvaluationSummarySchema.parse({
        benchmarkScore: 0.95,
        replaySuccessRate: 1.0,
        latencyImprovementPercent: 45.2,
        tokenSavingsPercent: 30.0,
        securityVerdict: "passed",
        evaluatorVersion: "1.0.0",
        evaluatedAt: "2026-08-17T12:00:00.000Z",
      });
      expect(summary.benchmarkScore).toBe(0.95);
      expect(summary.securityVerdict).toBe("passed");
    });

    it("rejects benchmark scores outside [0, 1]", () => {
      expect(() =>
        CandidateEvaluationSummarySchema.parse({
          benchmarkScore: 1.2,
          replaySuccessRate: 1.0,
          latencyImprovementPercent: 45.2,
          tokenSavingsPercent: 30.0,
          securityVerdict: "passed",
          evaluatorVersion: "1.0.0",
          evaluatedAt: "2026-08-17T12:00:00.000Z",
        }),
      ).toThrow();
    });
  });

  describe("EvolutionCandidateSchema", () => {
    it("parses valid evolution candidate fixture", () => {
      const parsed = EvolutionCandidateSchema.parse(validEvolutionCandidate);
      expect(parsed.id).toBe("cand_fast_ast_01");
      expect(parsed.state).toBe("evaluated");
      expect(parsed.evaluationSummary?.benchmarkScore).toBe(0.96);
    });
  });
});
