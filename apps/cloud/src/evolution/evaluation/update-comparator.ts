import type {
  CapabilityManifest,
  ToolManifest,
  ToolParameterSchema,
} from "@tool-evolver/contracts";
import type { CandidateValidationResult } from "../testing/types.js";
import type { HistoricalReplayResult } from "../replay/types.js";
import type {
  ActiveToolBaseline,
  EvaluationPolicy,
  UpdateRegressionFinding,
  UpdateRegressionResult,
} from "./types.js";

/**
 * Parameter bundle for update comparison.
 */
export interface UpdateComparisonContext {
  candidateManifest: ToolManifest;
  candidateSourceCode: string;
  candidateCapabilities?: CapabilityManifest;
  candidateValidation?: CandidateValidationResult;
  candidateReplay?: HistoricalReplayResult;
  baseline: ActiveToolBaseline;
  policy: EvaluationPolicy;
  allowBreakingChanges?: boolean;
}

/**
 * Detects regressions when evaluating candidate tool updates against prior active baselines.
 */
export class UpdateComparator {
  /**
   * Compares candidate tool against prior active baseline version.
   */
  compare(context: UpdateComparisonContext): UpdateRegressionResult {
    const {
      candidateManifest,
      candidateValidation,
      candidateReplay,
      baseline,
      policy,
      allowBreakingChanges = false,
    } = context;

    const findings: UpdateRegressionFinding[] = [];
    let isBreakingChange = false;

    // 1. Schema Backward Compatibility Check
    const schemaRegressions = this.checkSchemaCompatibility(
      candidateManifest,
      baseline.manifest,
      allowBreakingChanges || policy.regressionThresholds.allowBreakingSchemaChanges
    );
    findings.push(...schemaRegressions.findings);
    if (schemaRegressions.isBreaking) {
      isBreakingChange = true;
    }

    // 2. Latency Regression Check
    const latencyRegressions = this.checkLatencyRegression(
      candidateValidation,
      candidateReplay,
      baseline,
      policy.regressionThresholds.maxAllowedLatencyRegressionPercent
    );
    findings.push(...latencyRegressions);

    // 3. Token Consumption Regression Check
    const tokenRegressions = this.checkTokenRegression(
      candidateReplay,
      baseline,
      policy.regressionThresholds.maxAllowedTokenRegressionPercent
    );
    findings.push(...tokenRegressions);

    // 4. Invariant & Replay Pass Rate Regression Check
    const replayRegressions = this.checkReplayInvariantPreservation(
      candidateReplay,
      baseline,
      policy.regressionThresholds.requireStrictInvariantPreservation
    );
    findings.push(...replayRegressions);

    // 5. Test Coverage Regression Check
    const coverageRegressions = this.checkCoverageRegression(
      candidateValidation,
      baseline
    );
    findings.push(...coverageRegressions);

    // 6. Capability Expansion Check
    const capabilityRegressions = this.checkCapabilityEscalation(
      context.candidateCapabilities ?? candidateManifest.capabilities,
      baseline.capabilities ?? baseline.manifest.capabilities
    );
    findings.push(...capabilityRegressions);

    const criticalRegressionCount = findings.filter((f) => f.severity === "critical").length;
    const passed = criticalRegressionCount === 0;

    let summary = `Comparison against baseline v${baseline.toolVersion}: `;
    if (passed) {
      summary += `No critical regressions detected (${findings.length} non-blocking notices).`;
    } else {
      const critMsgs = findings
        .filter((f) => f.severity === "critical")
        .map((f) => f.message)
        .join("; ");
      summary += `${criticalRegressionCount} critical regressions found: ${critMsgs}`;
    }

    return {
      hasPriorBaseline: true,
      baselineVersion: baseline.toolVersion,
      passed,
      isBreakingChange,
      findings,
      criticalRegressionCount,
      summary,
    };
  }

  /**
   * Checks schema parameter backward compatibility.
   */
  private checkSchemaCompatibility(
    candidate: ToolManifest,
    baseline: ToolManifest,
    allowBreaking: boolean
  ): { findings: UpdateRegressionFinding[]; isBreaking: boolean } {
    const findings: UpdateRegressionFinding[] = [];
    let isBreaking = false;

    const baseProperties = (baseline.parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
    const candProperties = (candidate.parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
    const candRequired = new Set(candidate.parameters?.required ?? []);

    // Check if any previously existing parameters were removed
    for (const key of Object.keys(baseProperties)) {
      if (!candProperties[key]) {
        isBreaking = true;
        findings.push({
          dimension: "schema_compatibility",
          severity: allowBreaking ? "warning" : "critical",
          baselineValue: key,
          candidateValue: "omitted",
          message: `Breaking change: Parameter '${key}' from baseline v${baseline.version} was removed in candidate.`,
        });
      }
    }

    // Check if new parameters were introduced as required
    for (const key of Object.keys(candProperties)) {
      if (!baseProperties[key] && candRequired.has(key)) {
        isBreaking = true;
        findings.push({
          dimension: "schema_compatibility",
          severity: allowBreaking ? "warning" : "critical",
          baselineValue: "non_existent",
          candidateValue: `required_param:${key}`,
          message: `Breaking change: New required parameter '${key}' added without backward compatibility.`,
        });
      }
    }

    return { findings, isBreaking };
  }

  /**
   * Checks execution latency regression.
   */
  private checkLatencyRegression(
    candidateVal?: CandidateValidationResult,
    candidateRep?: HistoricalReplayResult,
    baseline?: ActiveToolBaseline,
    maxAllowedRegressionPercent = 20
  ): UpdateRegressionFinding[] {
    const findings: UpdateRegressionFinding[] = [];

    const baselineLatency =
      baseline?.metrics?.latencyMs ??
      baseline?.validationReport?.testReport?.durationMs;

    const candidateLatency =
      candidateVal?.testReport?.durationMs ??
      candidateRep?.durationMs;
    if (baselineLatency !== undefined && candidateLatency !== undefined && baselineLatency > 0) {
      const percentDiff = ((candidateLatency - baselineLatency) / baselineLatency) * 100;
      if (percentDiff > maxAllowedRegressionPercent) {
        findings.push({
          dimension: "latency_regression",
          severity: percentDiff > maxAllowedRegressionPercent * 2 ? "critical" : "warning",
          baselineValue: `${baselineLatency}ms`,
          candidateValue: `${candidateLatency}ms`,
          percentChange: Number(percentDiff.toFixed(1)),
          message: `Latency regressed by ${percentDiff.toFixed(1)}% (candidate: ${candidateLatency}ms vs baseline: ${baselineLatency}ms, allowed max: +${maxAllowedRegressionPercent}%).`,
        });
      }
    }

    return findings;
  }

  /**
   * Checks token consumption regression.
   */
  private checkTokenRegression(
    candidateRep?: HistoricalReplayResult,
    baseline?: ActiveToolBaseline,
    maxAllowedRegressionPercent = 15
  ): UpdateRegressionFinding[] {
    const findings: UpdateRegressionFinding[] = [];

    const baselineTokens =
      baseline?.metrics?.tokenUsage ??
      baseline?.replayReport?.overallMetrics?.candidateStepCount;

    const candidateTokens =
      candidateRep?.overallMetrics?.candidateStepCount;

    if (baselineTokens !== undefined && candidateTokens !== undefined && baselineTokens > 0) {
      const percentDiff = ((candidateTokens - baselineTokens) / baselineTokens) * 100;
      if (percentDiff > maxAllowedRegressionPercent) {
        findings.push({
          dimension: "token_regression",
          severity: "warning",
          baselineValue: baselineTokens,
          candidateValue: candidateTokens,
          percentChange: Number(percentDiff.toFixed(1)),
          message: `Token consumption increased by ${percentDiff.toFixed(1)}% relative to active baseline.`,
        });
      }
    }

    return findings;
  }

  /**
   * Checks replay invariant preservation.
   */
  private checkReplayInvariantPreservation(
    candidateRep?: HistoricalReplayResult,
    baseline?: ActiveToolBaseline,
    strictPreservation = true
  ): UpdateRegressionFinding[] {
    const findings: UpdateRegressionFinding[] = [];

    if (!candidateRep || !baseline?.replayReport) {
      return findings;
    }

    const basePassRate =
      baseline.replayReport.totalScenarioCount > 0
        ? baseline.replayReport.passedScenarioCount / baseline.replayReport.totalScenarioCount
        : 1.0;

    const candPassRate =
      candidateRep.totalScenarioCount > 0
        ? candidateRep.passedScenarioCount / candidateRep.totalScenarioCount
        : 1.0;

    if (candPassRate < basePassRate) {
      const diffPercent = (basePassRate - candPassRate) * 100;
      findings.push({
        dimension: "replay_pass_rate_regression",
        severity: strictPreservation ? "critical" : "warning",
        baselineValue: `${(basePassRate * 100).toFixed(1)}%`,
        candidateValue: `${(candPassRate * 100).toFixed(1)}%`,
        percentChange: -Number(diffPercent.toFixed(1)),
        message: `Historical replay pass rate dropped from ${(basePassRate * 100).toFixed(1)}% in baseline to ${(candPassRate * 100).toFixed(1)}% in candidate.`,
      });
    }

    return findings;
  }

  /**
   * Checks test coverage regression.
   */
  private checkCoverageRegression(
    candidateVal?: CandidateValidationResult,
    baseline?: ActiveToolBaseline
  ): UpdateRegressionFinding[] {
    const findings: UpdateRegressionFinding[] = [];

    const baseCov = baseline?.validationReport?.coverage?.statementCoveragePercent;
    const candCov = candidateVal?.coverage?.statementCoveragePercent;

    if (baseCov !== undefined && candCov !== undefined) {
      const covDrop = baseCov - candCov;
      if (covDrop > 10) {
        findings.push({
          dimension: "coverage_regression",
          severity: "warning",
          baselineValue: `${baseCov}%`,
          candidateValue: `${candCov}%`,
          percentChange: -covDrop,
          message: `Test statement coverage dropped by ${covDrop}% (baseline: ${baseCov}%, candidate: ${candCov}%).`,
        });
      }
    }

    return findings;
  }

  /**
   * Checks unexpected capability privilege escalation.
   */
  private checkCapabilityEscalation(
    candidateCap?: CapabilityManifest,
    baselineCap?: CapabilityManifest
  ): UpdateRegressionFinding[] {
    const findings: UpdateRegressionFinding[] = [];

    if (!candidateCap || !baselineCap) {
      return findings;
    }

    // Check if candidate added secrets when baseline didn't have any
    const candSecrets = candidateCap.secrets?.allowedSecretNames?.length ?? 0;
    const baseSecrets = baselineCap.secrets?.allowedSecretNames?.length ?? 0;
    if (candSecrets > 0 && baseSecrets === 0) {
      findings.push({
        dimension: "privilege_escalation",
        severity: "warning",
        baselineValue: "none",
        candidateValue: "secrets_requested",
        message: "Privilege escalation: Candidate requests secret access capabilities not requested by prior baseline.",
      });
    }

    // Check if candidate added command execution when baseline didn't have any
    const candCommands = candidateCap.command?.allowedCommands?.length ?? 0;
    const baseCommands = baselineCap.command?.allowedCommands?.length ?? 0;
    if (candCommands > 0 && baseCommands === 0) {
      findings.push({
        dimension: "privilege_escalation",
        severity: "warning",
        baselineValue: "none",
        candidateValue: "commands_requested",
        message: "Privilege escalation: Candidate requests command execution capabilities not present in prior baseline.",
      });
    }

    return findings;
  }
}
