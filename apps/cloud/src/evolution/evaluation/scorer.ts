import type {
  CapabilityManifest,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { CandidateValidationResult, CoverageReport, StaticAnalysisFinding } from "../testing/types.js";
import type { HistoricalReplayResult } from "../replay/types.js";
import type { OpportunityDetection } from "../opportunity/types.js";
import type {
  DimensionScore,
  EvaluationDimensionKey,
  EvaluationPolicy,
  RiskTier,
} from "./types.js";
import { classifyRiskTier } from "./policy.js";

/**
 * Parameter bundle for candidate scoring.
 */
export interface CandidateScoringContext {
  manifest: ToolManifest;
  sourceCode: string;
  requiredCapabilities?: CapabilityManifest;
  validationResult: CandidateValidationResult;
  replayResult?: HistoricalReplayResult;
  opportunity?: OpportunityDetection;
  selfReviewIssuesCount?: number;
  policy: EvaluationPolicy;
  riskTier?: RiskTier;
}

/**
 * Result bundle produced by CandidateScorer.
 */
export interface CandidateScoringResult {
  compositeScore: number;
  confidenceScore: number;
  thresholdScore: number;
  minRequiredConfidence: number;
  passed: boolean;
  dimensionScores: DimensionScore[];
  riskTier: RiskTier;
}

/**
 * Multi-dimensional scoring engine evaluating candidate quality, safety, performance, and economics.
 */
export class CandidateScorer {
  /**
   * Scores an evolution candidate across all dimensions using the provided evaluation policy.
   */
  score(context: CandidateScoringContext): CandidateScoringResult {
    const { policy, manifest, requiredCapabilities } = context;
    const riskTier = context.riskTier ?? classifyRiskTier(manifest, requiredCapabilities);
    const tierThresholds = policy.riskTierThresholds[riskTier];
    const weights = policy.weights;

    // 1. Compute scores for each dimension
    const correctness = this.scoreCorrectness(context, weights.correctness, tierThresholds.minTestPassRate);
    const replayCoverage = this.scoreReplayCoverage(context, weights.replayCoverage, tierThresholds.minReplayPassRate);
    const securityPolicyFit = this.scoreSecurityPolicyFit(context, weights.securityPolicyFit, riskTier);
    const reliability = this.scoreReliability(context, weights.reliability);
    const latencyResources = this.scoreLatencyResources(context, weights.latencyResources);
    const tokenSavings = this.scoreTokenSavings(context, weights.tokenSavings);
    const timeSavings = this.scoreTimeSavings(context, weights.timeSavings);
    const utilityRecurrence = this.scoreUtilityRecurrence(context, weights.utilityRecurrence);
    const maintainability = this.scoreMaintainability(context, weights.maintainability, tierThresholds.minCoveragePercent);

    const dimensionScores: DimensionScore[] = [
      correctness,
      replayCoverage,
      securityPolicyFit,
      reliability,
      latencyResources,
      tokenSavings,
      timeSavings,
      utilityRecurrence,
      maintainability,
    ];

    // 2. Compute composite weighted score
    let totalWeight = 0;
    let weightedSum = 0;
    let weightedConfidence = 0;

    for (const d of dimensionScores) {
      weightedSum += d.adjustedScore * d.weight;
      weightedConfidence += d.confidence * d.weight;
      totalWeight += d.weight;
    }

    const compositeScore = totalWeight > 0 ? Number((weightedSum / totalWeight).toFixed(4)) : 0;
    const confidenceScore = totalWeight > 0 ? Number((weightedConfidence / totalWeight).toFixed(4)) : 0;
    const thresholdScore = tierThresholds.minCompositeScore;
    const minRequiredConfidence = tierThresholds.minConfidence;

    // 3. Check if all dimensions and overall thresholds are satisfied
    const allDimensionsPassed = dimensionScores.every((d) => d.passed);
    const passed =
      compositeScore >= thresholdScore &&
      confidenceScore >= minRequiredConfidence &&
      allDimensionsPassed;

    return {
      compositeScore,
      confidenceScore,
      thresholdScore,
      minRequiredConfidence,
      passed,
      dimensionScores,
      riskTier,
    };
  }

  /**
   * Dimension 1: Correctness (Test pass rate, type safety, assertions).
   */
  private scoreCorrectness(
    context: CandidateScoringContext,
    weight: number,
    minPassRate: number
  ): DimensionScore {
    const { validationResult } = context;
    const report = validationResult.testReport;

    let rawScore = 1.0;
    let confidence = 0.9;
    const metrics: Record<string, number | string | boolean> = {
      typecheckPassed: validationResult.typecheckPassed,
      validationPassed: validationResult.passed,
    };

    if (report && report.totalTests > 0) {
      const passRate = report.passed / report.totalTests;
      metrics.testPassRate = Number(passRate.toFixed(4));
      metrics.totalTests = report.totalTests;
      metrics.passedTests = report.passed;
      metrics.failedTests = report.failed;

      rawScore = passRate;
      // High confidence if we ran a meaningful number of tests
      confidence = Math.min(1.0, 0.7 + report.totalTests * 0.05);
    } else {
      rawScore = validationResult.typecheckPassed ? 0.75 : 0.0;
      confidence = 0.5;
      metrics.testPassRate = 0;
      metrics.totalTests = 0;
    }

    if (!validationResult.typecheckPassed) {
      rawScore *= 0.2;
    }

    // Static error deduction
    const staticErrors = validationResult.staticFindings.filter((f) => f.severity === "error").length;
    if (staticErrors > 0) {
      rawScore = Math.max(0, rawScore - staticErrors * 0.25);
    }

    const adjustedScore = Number(rawScore.toFixed(4));
    const passed = adjustedScore >= minPassRate;

    return {
      dimension: "correctness",
      rawScore: Number(rawScore.toFixed(4)),
      adjustedScore,
      weight,
      threshold: minPassRate,
      passed,
      confidence: Number(confidence.toFixed(4)),
      metrics,
      details: `Correctness score based on ${metrics.totalTests ?? 0} tests, typecheck=${validationResult.typecheckPassed}`,
    };
  }

  /**
   * Dimension 2: Replay Coverage (Scenario pass rate, invariant preservation).
   */
  private scoreReplayCoverage(
    context: CandidateScoringContext,
    weight: number,
    minPassRate: number
  ): DimensionScore {
    const { replayResult, policy } = context;
    const uncertainty = policy.uncertaintyConfig;

    if (!replayResult || replayResult.totalScenarioCount === 0) {
      return {
        dimension: "replay_coverage",
        rawScore: 0.5,
        adjustedScore: 0.4,
        weight,
        threshold: minPassRate,
        passed: minPassRate <= 0.4,
        confidence: 0.3,
        metrics: { totalScenarios: 0, passedScenarios: 0, scenarioPassRate: 0 },
        details: "No historical replay scenarios available.",
      };
    }

    const scenarioPassRate = replayResult.passedScenarioCount / replayResult.totalScenarioCount;
    let totalInvariants = 0;
    let passedInvariants = 0;

    for (const sc of replayResult.scenarioResults) {
      for (const inv of sc.invariantEvaluations) {
        totalInvariants++;
        if (inv.passed) passedInvariants++;
      }
    }

    const invariantPassRate = totalInvariants > 0 ? passedInvariants / totalInvariants : 1.0;
    const rawScore = 0.6 * scenarioPassRate + 0.4 * invariantPassRate;

    // Uncertainty penalty for small scenario count
    let confidence = 1.0;
    if (replayResult.totalScenarioCount < uncertainty.minReplayScenariosForFullConfidence) {
      const missing = uncertainty.minReplayScenariosForFullConfidence - replayResult.totalScenarioCount;
      confidence = Math.max(0.2, 1.0 - missing * uncertainty.penaltyPerMissingScenario);
    }

    const adjustedScore = Number((rawScore * confidence).toFixed(4));
    const passed = scenarioPassRate >= minPassRate;

    return {
      dimension: "replay_coverage",
      rawScore: Number(rawScore.toFixed(4)),
      adjustedScore,
      weight,
      threshold: minPassRate,
      passed,
      confidence: Number(confidence.toFixed(4)),
      metrics: {
        totalScenarios: replayResult.totalScenarioCount,
        passedScenarios: replayResult.passedScenarioCount,
        scenarioPassRate: Number(scenarioPassRate.toFixed(4)),
        totalInvariants,
        passedInvariants,
        invariantPassRate: Number(invariantPassRate.toFixed(4)),
      },
      details: `Replay pass rate ${(scenarioPassRate * 100).toFixed(1)}% across ${replayResult.totalScenarioCount} scenarios`,
    };
  }

  /**
   * Dimension 3: Security & Policy Fit (Static findings, least privilege, risk tier penalties).
   */
  private scoreSecurityPolicyFit(
    context: CandidateScoringContext,
    weight: number,
    riskTier: RiskTier
  ): DimensionScore {
    const { validationResult, policy } = context;
    const tierThresholds = policy.riskTierThresholds[riskTier];

    const errorCount = validationResult.staticFindings.filter((f) => f.severity === "error").length;
    const warningCount = validationResult.staticFindings.filter((f) => f.severity === "warning").length;

    let rawScore = 1.0;
    if (errorCount > 0) {
      rawScore = 0.0;
    } else {
      rawScore = Math.max(0, 1.0 - warningCount * 0.08);
    }

    // Risk tier penalty: riskier tiers penalize warnings more severely
    let tierPenalty = 0;
    if (riskTier === "secret_mediated" && warningCount > 0) {
      tierPenalty = 0.25;
    } else if (riskTier === "command_exec" && warningCount > 0) {
      tierPenalty = 0.15;
    } else if (riskTier === "network_client" && warningCount > 1) {
      tierPenalty = 0.10;
    }

    const adjustedScore = Math.max(0, Number((rawScore - tierPenalty).toFixed(4)));
    const threshold = tierThresholds.requireZeroStaticErrors ? 0.8 : 0.6;
    const passed = errorCount === 0 && warningCount <= tierThresholds.maxAllowedStaticWarnings;

    return {
      dimension: "security_policy_fit",
      rawScore: Number(rawScore.toFixed(4)),
      adjustedScore,
      weight,
      threshold,
      passed,
      confidence: 0.95,
      metrics: {
        errorCount,
        warningCount,
        riskTier,
        maxAllowedWarnings: tierThresholds.maxAllowedStaticWarnings,
      },
      details: `Security evaluation: ${errorCount} errors, ${warningCount} warnings (risk tier: ${riskTier})`,
    };
  }

  /**
   * Dimension 4: Reliability (Seed reproducibility, error handling, timeout resilience).
   */
  private scoreReliability(
    context: CandidateScoringContext,
    weight: number
  ): DimensionScore {
    const { validationResult, replayResult } = context;

    let score = 0.95;
    let timeoutCount = 0;
    let errorHandlingPassRate = 1.0;

    if (validationResult.testReport) {
      const timeouts = validationResult.testReport.results.filter((r) => r.status === "timeout").length;
      timeoutCount = timeouts;
      if (timeouts > 0) {
        score -= timeouts * 0.15;
      }

      const edgeCases = validationResult.testReport.results.filter((r) => r.testType === "edge_case" || r.testType === "error_mode");
      if (edgeCases.length > 0) {
        const passedEdge = edgeCases.filter((r) => r.passed).length;
        errorHandlingPassRate = passedEdge / edgeCases.length;
        score = score * 0.7 + errorHandlingPassRate * 0.3;
      }
    }

    if (replayResult && replayResult.reproducibilitySeed) {
      score += 0.05;
    }

    score = Math.min(1.0, Math.max(0.0, score));
    const adjustedScore = Number(score.toFixed(4));
    const threshold = 0.70;

    return {
      dimension: "reliability",
      rawScore: adjustedScore,
      adjustedScore,
      weight,
      threshold,
      passed: adjustedScore >= threshold,
      confidence: 0.85,
      metrics: {
        timeoutCount,
        errorHandlingPassRate: Number(errorHandlingPassRate.toFixed(4)),
        reproducibilitySeedPresent: Boolean(replayResult?.reproducibilitySeed),
      },
      details: `Reliability score: ${adjustedScore}`,
    };
  }

  /**
   * Dimension 5: Latency & Resources (Execution duration vs multi-step trace).
   */
  private scoreLatencyResources(
    context: CandidateScoringContext,
    weight: number
  ): DimensionScore {
    const { validationResult, replayResult, opportunity } = context;

    let durationMs = 0;
    if (validationResult.testReport) {
      durationMs = validationResult.testReport.durationMs;
    }
    // Faster single-tool execution yields higher score
    let durationScore = 1.0;
    if (durationMs > 5000) {
      durationScore = 0.5;
    } else if (durationMs > 2000) {
      durationScore = 0.7;
    } else if (durationMs > 500) {
      durationScore = 0.85;
    } else {
      durationScore = 1.0;
    }

    let stepReduction = 0;
    if (replayResult) {
      stepReduction = replayResult.overallMetrics.stepReductionCount;
    } else if (opportunity) {
      stepReduction = Math.max(0, opportunity.occurrenceCount - 1);
    }

    // Bonus for saving multi-step roundtrips
    const stepBonus = Math.min(0.2, stepReduction * 0.05);
    const rawScore = Math.min(1.0, durationScore + stepBonus);
    const adjustedScore = Number(rawScore.toFixed(4));
    const threshold = 0.60;

    return {
      dimension: "latency_resources",
      rawScore: adjustedScore,
      adjustedScore,
      weight,
      threshold,
      passed: adjustedScore >= threshold,
      confidence: 0.80,
      metrics: {
        durationMs,
        stepReductionCount: stepReduction,
      },
      details: `Execution time ${durationMs}ms, multi-step reduction: ${stepReduction}`,
    };
  }

  /**
   * Dimension 6: Token Savings (Multi-turn conversational prompt tokens saved).
   */
  private scoreTokenSavings(
    context: CandidateScoringContext,
    weight: number
  ): DimensionScore {
    const { replayResult, opportunity } = context;

    let tokenSavingsPercent = 75;
    let estimatedTokensSaved = 1000;

    if (replayResult && replayResult.overallMetrics) {
      const { baselineStepCount, candidateStepCount } = replayResult.overallMetrics;
      if (baselineStepCount > 0) {
        tokenSavingsPercent = Math.max(0, Math.min(100, Math.round(((baselineStepCount - candidateStepCount) / baselineStepCount) * 100)));
      }
    } else if (opportunity && opportunity.metrics.totalTokens > 0) {
      estimatedTokensSaved = Math.round(opportunity.metrics.totalTokens * 0.7);
    }

    const rawScore = Math.min(1.0, Math.max(0.0, tokenSavingsPercent / 100));
    const adjustedScore = Number(rawScore.toFixed(4));
    const threshold = 0.50;

    return {
      dimension: "token_savings",
      rawScore: adjustedScore,
      adjustedScore,
      weight,
      threshold,
      passed: adjustedScore >= threshold,
      confidence: 0.75,
      metrics: {
        tokenSavingsPercent,
        estimatedTokensSaved,
      },
      details: `Estimated token savings: ${tokenSavingsPercent}% (${estimatedTokensSaved} tokens)`,
    };
  }

  /**
   * Dimension 7: Time Savings (Wall-clock agent session time reduction).
   */
  private scoreTimeSavings(
    context: CandidateScoringContext,
    weight: number
  ): DimensionScore {
    const { opportunity } = context;

    let timeSavingsPercent = 60;
    if (opportunity && opportunity.metrics.totalDurationMs > 0) {
      timeSavingsPercent = Math.min(95, Math.max(20, Math.round((opportunity.metrics.totalDurationMs / (opportunity.metrics.totalDurationMs + 2000)) * 100)));
    }

    const rawScore = Math.min(1.0, Math.max(0.0, timeSavingsPercent / 100));
    const adjustedScore = Number(rawScore.toFixed(4));
    const threshold = 0.40;

    return {
      dimension: "time_savings",
      rawScore: adjustedScore,
      adjustedScore,
      weight,
      threshold,
      passed: adjustedScore >= threshold,
      confidence: 0.70,
      metrics: {
        timeSavingsPercent,
      },
      details: `Estimated time savings: ${timeSavingsPercent}%`,
    };
  }

  /**
   * Dimension 8: Utility & Recurrence (Opportunity frequency, recurrence count, trigger priority).
   */
  private scoreUtilityRecurrence(
    context: CandidateScoringContext,
    weight: number
  ): DimensionScore {
    const { opportunity, policy } = context;
    const uncertainty = policy.uncertaintyConfig;

    if (!opportunity) {
      return {
        dimension: "utility_recurrence",
        rawScore: 0.70,
        adjustedScore: 0.65,
        weight,
        threshold: 0.50,
        passed: true,
        confidence: 0.60,
        metrics: { occurrenceCount: 1, distinctSessionCount: 1 },
        details: "Single opportunity detection context.",
      };
    }

    const { occurrenceCount, distinctSessionCount, triggerType, triggerReason } = opportunity;

    let freqScore = 0.5;
    if (occurrenceCount >= 5) {
      freqScore = 1.0;
    } else if (occurrenceCount >= 3) {
      freqScore = 0.85;
    } else if (occurrenceCount >= 2) {
      freqScore = 0.75;
    } else {
      freqScore = 0.60;
    }

    // Trigger bonus
    let triggerBonus = 0;
    if (triggerType === "exceptional_waste" || triggerReason === "latency_bottleneck") {
      triggerBonus = 0.1;
    }

    const rawScore = Math.min(1.0, freqScore + triggerBonus);

    // Confidence adjustment
    let confidence = 1.0;
    if (occurrenceCount < uncertainty.minOccurrencesForFullConfidence) {
      confidence *= 0.75;
    }
    if (distinctSessionCount < uncertainty.minDistinctSessionsForFullConfidence) {
      confidence *= 0.85;
    }

    const adjustedScore = Number((rawScore * confidence).toFixed(4));
    const threshold = 0.50;

    return {
      dimension: "utility_recurrence",
      rawScore: Number(rawScore.toFixed(4)),
      adjustedScore,
      weight,
      threshold,
      passed: adjustedScore >= threshold,
      confidence: Number(confidence.toFixed(4)),
      metrics: {
        occurrenceCount,
        distinctSessionCount,
        triggerType,
        triggerReason,
      },
      details: `Opportunity frequency: ${occurrenceCount} occurrences across ${distinctSessionCount} sessions`,
    };
  }

  /**
   * Dimension 9: Maintainability (Code size, test coverage, self-review cleanliness).
   */
  private scoreMaintainability(
    context: CandidateScoringContext,
    weight: number,
    minCoveragePercent: number
  ): DimensionScore {
    const { validationResult, sourceCode, selfReviewIssuesCount = 0 } = context;
    const coverage = validationResult.coverage;

    let statementCov = 80;
    let branchCov = 70;
    let functionCov = 80;

    if (coverage) {
      statementCov = coverage.statementCoveragePercent;
      branchCov = coverage.branchCoveragePercent;
      functionCov = coverage.functionCoveragePercent;
    }

    const avgCoverage = (statementCov + branchCov + functionCov) / 3;
    let rawScore = avgCoverage / 100;

    // Code length check: concise code is more maintainable
    const lineCount = sourceCode ? sourceCode.split("\n").length : 100;
    if (lineCount > 1000) {
      rawScore -= 0.2;
    } else if (lineCount > 500) {
      rawScore -= 0.1;
    }

    // Self-review issues deduction
    if (selfReviewIssuesCount > 0) {
      rawScore -= selfReviewIssuesCount * 0.05;
    }

    rawScore = Math.min(1.0, Math.max(0.0, rawScore));
    const adjustedScore = Number(rawScore.toFixed(4));
    const threshold = minCoveragePercent / 100;
    const passed = statementCov >= minCoveragePercent;

    return {
      dimension: "maintainability",
      rawScore: adjustedScore,
      adjustedScore,
      weight,
      threshold,
      passed,
      confidence: coverage ? 0.90 : 0.60,
      metrics: {
        statementCoverage: statementCov,
        branchCoverage: branchCov,
        functionCoverage: functionCov,
        lineCount,
        selfReviewIssuesCount,
        minCoveragePercent,
      },
      details: `Code maintainability: coverage=${avgCoverage.toFixed(1)}%, lines=${lineCount}`,
    };
  }
}
