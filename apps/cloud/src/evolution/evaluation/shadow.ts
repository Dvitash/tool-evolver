import type {
  EvaluationDecision,
  EvaluationDecisionRecord,
  EvaluationDimensionKey,
  EvaluationPolicy,
  ShadowCalibrationReport,
  ShadowEvaluationResult,
} from "./types.js";
import { HardGateEvaluator } from "./hard-gates.js";
import { CandidateScorer } from "./scorer.js";
import { UpdateComparator } from "./update-comparator.js";
import { extractCandidateInfo, resolveActiveBaseline } from "./service.js";
import type { CandidateEvaluationInput } from "./types.js";

/**
 * Evaluates candidate tools against shadow policies for offline calibration and threshold tuning.
 */
export class ShadowPolicyEvaluator {
  private gateEvaluator = new HardGateEvaluator();
  private scorer = new CandidateScorer();
  private comparator = new UpdateComparator();

  /**
   * Evaluates candidate against a set of shadow policies and compares outcomes against the active decision.
   */
  evaluateShadowPolicies(
    input: CandidateEvaluationInput,
    activeDecisionRecord: EvaluationDecisionRecord,
    shadowPolicies: EvaluationPolicy[]
  ): ShadowEvaluationResult[] {
    const results: ShadowEvaluationResult[] = [];

    const { candidate, validationResult, replayResult, opportunity, envelope, activeVersionBaseline } = input;
    const { manifest, sourceCode, requiredCapabilities } = extractCandidateInfo(candidate);
    for (const shadowPolicy of shadowPolicies) {
      // 1. Evaluate hard gates under shadow policy
      const hardGateResult = this.gateEvaluator.evaluate({
        manifest,
        sourceCode,
        requiredCapabilities,
        validationResult,
        replayResult,
        envelope,
        policy: shadowPolicy,
      });

      // 2. Score dimensions under shadow policy
      const scoringResult = this.scorer.score({
        manifest,
        sourceCode,
        requiredCapabilities,
        validationResult,
        replayResult,
        opportunity,
        policy: shadowPolicy,
      });

      // 3. Compare with active baseline if present
      let regressionPassed = true;
      if (activeVersionBaseline && !input.options?.skipRegressionCheck) {
        const baselineObj = resolveActiveBaseline(activeVersionBaseline);
        if (baselineObj) {
          const regRes = this.comparator.compare({
            candidateManifest: manifest,
            candidateSourceCode: sourceCode,
            candidateCapabilities: requiredCapabilities,
            candidateValidation: validationResult,
            candidateReplay: replayResult,
            baseline: baselineObj,
            policy: shadowPolicy,
            allowBreakingChanges: input.options?.allowBreakingChanges,
          });
          regressionPassed = regRes.passed;
        }
      }

      // 4. Render shadow decision
      let shadowDecision: EvaluationDecision;
      if (validationResult.status === "infrastructure_fail" || replayResult?.status === "infrastructure_failure") {
        shadowDecision = "infrastructure_retry";
      } else if (!hardGateResult.passed) {
        shadowDecision = hardGateResult.canRepair ? "repair_requested" : "rejected";
      } else if (!regressionPassed) {
        shadowDecision = "repair_requested";
      } else if (scoringResult.confidenceScore < scoringResult.minRequiredConfidence) {
        shadowDecision = "deferred_for_more_evidence";
      } else if (scoringResult.passed) {
        shadowDecision = "eligible_for_artifact";
      } else {
        shadowDecision = "repair_requested";
      }

      const shadowVerdict = shadowDecision === "eligible_for_artifact" ? "pass" : shadowDecision === "rejected" ? "fail" : "conditional";
      const agreementWithActive = shadowDecision === activeDecisionRecord.decision;
      const scoreDeltaWithActive = Number((scoringResult.compositeScore - activeDecisionRecord.compositeScore).toFixed(4));

      // Find differing dimensions
      const differingDimensions: EvaluationDimensionKey[] = [];
      for (const d of scoringResult.dimensionScores) {
        const activeDim = activeDecisionRecord.dimensionScores.find((ad) => ad.dimension === d.dimension);
        if (activeDim && activeDim.passed !== d.passed) {
          differingDimensions.push(d.dimension);
        }
      }

      // Find differing gates
      const differingGates: string[] = [];
      for (const g of hardGateResult.gateResults) {
        const activeGate = activeDecisionRecord.hardGateResult.gateResults.find((ag) => ag.gate === g.gate);
        if (activeGate && activeGate.passed !== g.passed) {
          differingGates.push(g.gate);
        }
      }

      results.push({
        shadowPolicyId: shadowPolicy.policyId,
        shadowPolicyVersion: shadowPolicy.version,
        decision: shadowDecision,
        verdict: shadowVerdict,
        compositeScore: scoringResult.compositeScore,
        confidenceScore: scoringResult.confidenceScore,
        hardGatePassed: hardGateResult.passed,
        agreementWithActive,
        scoreDeltaWithActive,
        differingDimensions,
        differingGates,
      });
    }

    return results;
  }
}

/**
 * Aggregates shadow evaluation records to calibrate and compare policy behavior.
 */
export class ShadowCalibrationAggregator {
  private runs: Array<{
    candidateId: string;
    activeDecisionRecord: EvaluationDecisionRecord;
    shadowResult: ShadowEvaluationResult;
  }> = [];

  /**
   * Records a shadow evaluation execution.
   */
  record(
    candidateId: string,
    activeDecisionRecord: EvaluationDecisionRecord,
    shadowResult: ShadowEvaluationResult
  ): void {
    this.runs.push({ candidateId, activeDecisionRecord, shadowResult });
  }

  /**
   * Generates a calibration report for a specific shadow policy.
   */
  generateReport(shadowPolicyId: string, shadowPolicyVersion: string): ShadowCalibrationReport {
    const policyRuns = this.runs.filter(
      (r) => r.shadowResult.shadowPolicyId === shadowPolicyId && r.shadowResult.shadowPolicyVersion === shadowPolicyVersion
    );

    const sampleCount = policyRuns.length;
    if (sampleCount === 0) {
      return {
        shadowPolicyId,
        shadowPolicyVersion,
        activePolicyId: "unknown",
        sampleCount: 0,
        agreementCount: 0,
        agreementRate: 1.0,
        falsePositiveCount: 0,
        falseNegativeCount: 0,
        meanScoreDelta: 0,
        maxScoreDelta: 0,
        disagreements: [],
      };
    }

    let agreementCount = 0;
    let falsePositiveCount = 0;
    let falseNegativeCount = 0;
    let totalScoreDelta = 0;
    let maxScoreDelta = 0;
    const disagreements: ShadowCalibrationReport["disagreements"] = [];
    const activePolicyId = policyRuns[0]?.activeDecisionRecord.policyId ?? "active";

    for (const run of policyRuns) {
      const { candidateId, activeDecisionRecord, shadowResult } = run;
      const scoreDelta = Math.abs(shadowResult.scoreDeltaWithActive);
      totalScoreDelta += shadowResult.scoreDeltaWithActive;
      if (scoreDelta > maxScoreDelta) {
        maxScoreDelta = scoreDelta;
      }

      if (shadowResult.agreementWithActive) {
        agreementCount++;
      } else {
        const activePassed = activeDecisionRecord.decision === "eligible_for_artifact";
        const shadowPassed = shadowResult.decision === "eligible_for_artifact";

        if (!activePassed && shadowPassed) {
          falsePositiveCount++;
        } else if (activePassed && !shadowPassed) {
          falseNegativeCount++;
        }

        disagreements.push({
          candidateId,
          activeDecision: activeDecisionRecord.decision,
          shadowDecision: shadowResult.decision,
          activeScore: activeDecisionRecord.compositeScore,
          shadowScore: shadowResult.compositeScore,
          reason: `Differing gates: [${shadowResult.differingGates.join(", ")}], differing dimensions: [${shadowResult.differingDimensions.join(", ")}]`,
        });
      }
    }

    const agreementRate = Number((agreementCount / sampleCount).toFixed(4));
    const meanScoreDelta = Number((totalScoreDelta / sampleCount).toFixed(4));

    return {
      shadowPolicyId,
      shadowPolicyVersion,
      activePolicyId,
      sampleCount,
      agreementCount,
      agreementRate,
      falsePositiveCount,
      falseNegativeCount,
      meanScoreDelta,
      maxScoreDelta: Number(maxScoreDelta.toFixed(4)),
      disagreements,
    };
  }

  /**
   * Resets accumulated calibration runs.
   */
  clear(): void {
    this.runs = [];
  }
}
