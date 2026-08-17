import type {
  CapabilityEnvelope,
  CapabilityManifest,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { CandidateValidationResult, StaticAnalysisFinding } from "../testing/types.js";
import type { HistoricalReplayResult } from "../replay/types.js";
import type {
  EvaluationPolicy,
  GateCheckResult,
  HardGateResult,
  RiskTier,
} from "./types.js";
import { classifyRiskTier } from "./policy.js";

/**
 * Parameter bundle for hard gate evaluation.
 */
export interface HardGateEvaluationContext {
  manifest: ToolManifest;
  sourceCode: string;
  requiredCapabilities?: CapabilityManifest;
  validationResult: CandidateValidationResult;
  replayResult?: HistoricalReplayResult;
  envelope?: CapabilityEnvelope;
  policy: EvaluationPolicy;
  riskTier?: RiskTier;
}

/**
 * Evaluates non-negotiable hard safety gates for an evolution candidate.
 */
export class HardGateEvaluator {
  /**
   * Evaluates all hard gates and returns an aggregated HardGateResult.
   */
  evaluate(context: HardGateEvaluationContext): HardGateResult {
    const { policy, manifest, sourceCode, requiredCapabilities, validationResult, replayResult, envelope } = context;
    const riskTier = context.riskTier ?? classifyRiskTier(manifest, requiredCapabilities);
    const tierThresholds = policy.riskTierThresholds[riskTier];

    const gateResults: GateCheckResult[] = [];

    // 1. Compile and Schema Gate
    if (policy.hardGates.requireTypecheck) {
      gateResults.push(this.evaluateCompileSchemaGate(manifest, sourceCode, validationResult));
    }

    // 2. Forbidden Imports Gate
    if (policy.hardGates.forbidForbiddenImports) {
      gateResults.push(this.evaluateForbiddenImportsGate(validationResult.staticFindings));
    }

    // 3. Manifest Capability Parity Gate
    if (policy.hardGates.requireManifestParity) {
      gateResults.push(this.evaluateManifestParityGate(manifest, requiredCapabilities, validationResult.staticFindings));
    }

    // 4. Envelope Bounds Gate
    if (policy.hardGates.enforceEnvelopeBounds && envelope) {
      gateResults.push(this.evaluateEnvelopeBoundsGate(manifest, requiredCapabilities, envelope));
    }

    // 5. Critical Security Findings Gate
    if (policy.hardGates.forbidCriticalSecurityFindings) {
      gateResults.push(this.evaluateSecurityFindingsGate(validationResult.staticFindings, policy, tierThresholds.maxAllowedStaticWarnings));
    }

    // 6. Generated Tests Passing Gate
    if (policy.hardGates.requireGeneratedTestsPass) {
      gateResults.push(this.evaluateGeneratedTestsGate(validationResult));
    }

    // 7. Replay Divergence Gate
    if (policy.hardGates.forbidReplayDivergence) {
      gateResults.push(this.evaluateReplayDivergenceGate(replayResult, tierThresholds.minReplayPassRate, tierThresholds.minReplayScenarioCount));
    }

    // 8. Evidence Completeness Gate
    if (policy.hardGates.requireEvidenceCompleteness) {
      gateResults.push(this.evaluateEvidenceCompletenessGate(validationResult, replayResult, tierThresholds.minReplayScenarioCount));
    }

    const failedGates = gateResults.filter((g) => !g.passed).map((g) => g.gate);
    const passed = failedGates.length === 0;

    const repairTargets: string[] = [];
    let canRepair = true;

    for (const res of gateResults) {
      if (!res.passed) {
        if (res.canRepair === false) {
          canRepair = false;
        }
        if (res.repairHint) {
          repairTargets.push(res.repairHint);
        }
      }
    }

    let rejectionReason: string | undefined;
    if (!passed) {
      const messages = gateResults
        .filter((g) => !g.passed)
        .map((g) => `[${g.gate}] ${g.message ?? "Gate check failed"}`);
      rejectionReason = `Hard safety gate failures: ${messages.join("; ")}`;
    }

    return {
      passed,
      failedGates,
      gateResults,
      rejectionReason,
      canRepair: passed ? true : canRepair,
      repairTargets: repairTargets.length > 0 ? repairTargets : undefined,
    };
  }

  /**
   * Gate 1: Compile & Schema pass.
   */
  private evaluateCompileSchemaGate(
    manifest: ToolManifest,
    sourceCode: string,
    validationResult: CandidateValidationResult
  ): GateCheckResult {
    if (!sourceCode || sourceCode.trim().length === 0) {
      return {
        gate: "compile_schema_pass",
        passed: false,
        category: "compiler",
        message: "Candidate tool has empty or missing source code.",
        canRepair: true,
        repairHint: "Regenerate candidate implementation code.",
      };
    }

    if (!manifest || !manifest.id || !manifest.name || !manifest.version) {
      return {
        gate: "compile_schema_pass",
        passed: false,
        category: "manifest",
        message: "Candidate tool manifest is missing required identity fields (id, name, version).",
        canRepair: true,
        repairHint: "Repair tool manifest metadata.",
      };
    }

    if (validationResult.typecheckPassed === false) {
      const errorMsg = validationResult.typecheckErrors?.join("; ") ?? "TypeScript compilation failed.";
      return {
        gate: "compile_schema_pass",
        passed: false,
        category: "compiler",
        message: `Type check compilation failed: ${errorMsg}`,
        details: { errors: validationResult.typecheckErrors },
        canRepair: true,
        repairHint: "Fix TypeScript type and syntax errors in candidate code.",
      };
    }

    if (validationResult.status === "terminal_fail") {
      return {
        gate: "compile_schema_pass",
        passed: false,
        category: "compiler",
        message: "Candidate validation terminated with terminal failure status.",
        canRepair: false,
        repairHint: "Candidate has fatal non-recoverable compilation defects.",
      };
    }

    return {
      gate: "compile_schema_pass",
      passed: true,
      category: "compiler",
      message: "Type check and manifest schema validations passed cleanly.",
    };
  }

  /**
   * Gate 2: No forbidden imports.
   */
  private evaluateForbiddenImportsGate(findings: StaticAnalysisFinding[]): GateCheckResult {
    const forbidden = findings.filter(
      (f) => (f.category === "forbidden_import" || f.category === "forbidden_api") && f.severity === "error"
    );

    if (forbidden.length > 0) {
      const msgs = forbidden.map((f) => f.message).join("; ");
      return {
        gate: "no_forbidden_imports",
        passed: false,
        category: "security",
        message: `Forbidden module import or unauthorized API detected: ${msgs}`,
        details: { forbiddenFindings: forbidden },
        canRepair: true,
        repairHint: "Remove forbidden module imports and unauthorized node APIs; use platform SDK / broker APIs instead.",
      };
    }

    return {
      gate: "no_forbidden_imports",
      passed: true,
      category: "security",
      message: "No forbidden module imports or unauthorized APIs found.",
    };
  }

  /**
   * Gate 3: Manifest-capability parity.
   */
  private evaluateManifestParityGate(
    manifest: ToolManifest,
    requiredCapabilities: CapabilityManifest | undefined,
    findings: StaticAnalysisFinding[]
  ): GateCheckResult {
    const parityFindings = findings.filter(
      (f) =>
        (f.category === "undeclared_capability" || f.category === "broker_manifest_mismatch") &&
        f.severity === "error"
    );

    if (parityFindings.length > 0) {
      const msgs = parityFindings.map((f) => f.message).join("; ");
      return {
        gate: "manifest_capability_parity",
        passed: false,
        category: "manifest",
        message: `Capabilities used in code do not match manifest declarations: ${msgs}`,
        details: { parityFindings },
        canRepair: true,
        repairHint: "Declare all required capabilities in manifest or remove undeclared broker API calls from source code.",
      };
    }

    return {
      gate: "manifest_capability_parity",
      passed: true,
      category: "manifest",
      message: "Manifest declarations match all required runtime capabilities.",
    };
  }

  /**
   * Gate 4: Envelope bounds check.
   */
  private evaluateEnvelopeBoundsGate(
    manifest: ToolManifest,
    requiredCapabilities: CapabilityManifest | undefined,
    envelope: CapabilityEnvelope
  ): GateCheckResult {
    const cap = requiredCapabilities ?? manifest.capabilities;
    const violations: string[] = [];
    if (cap) {
      // Check filesystem
      if (cap.fs && envelope.fs) {
        if (
          envelope.fs.writePaths.length === 0 &&
          cap.fs.writePaths &&
          cap.fs.writePaths.length > 0
        ) {
          violations.push("Candidate requests filesystem write access in a read-only envelope.");
        }
        if (envelope.fs.denyPaths && envelope.fs.denyPaths.length > 0) {
          const candPaths = [...(cap.fs.readPaths ?? []), ...(cap.fs.writePaths ?? [])];
          for (const dp of envelope.fs.denyPaths) {
            if (candPaths.some((p) => p.startsWith(dp))) {
              violations.push(`Candidate requests access to denied filesystem path '${dp}'.`);
            }
          }
        }
      }

      // Check network
      if (cap.net) {
        if (!envelope.net.allowOutbound && cap.net.allowOutbound) {
          violations.push("Candidate requests network access prohibited by workspace envelope.");
        }
        if (envelope.net.allowedDomains.length > 0 && cap.net.allowedDomains) {
          for (const dom of cap.net.allowedDomains) {
            if (!envelope.net.allowedDomains.includes(dom)) {
              violations.push(`Candidate requests access to domain '${dom}' not permitted by envelope.`);
            }
          }
        }
      }

      // Check commands
      if (cap.command && cap.command.allowedCommands && cap.command.allowedCommands.length > 0) {
        if (envelope.command.allowedCommands.length === 0) {
          violations.push("Candidate requests command execution prohibited by workspace envelope.");
        } else {
          for (const cmd of cap.command.allowedCommands) {
            if (!envelope.command.allowedCommands.includes(cmd)) {
              violations.push(`Candidate requests command '${cmd}' not permitted by envelope.`);
            }
          }
        }
      }

      // Check secrets
      if (cap.secrets && cap.secrets.allowedSecretNames && cap.secrets.allowedSecretNames.length > 0) {
        if (envelope.secrets.allowedSecretNames.length === 0) {
          violations.push("Candidate requests secret access prohibited by workspace envelope.");
        } else {
          for (const sec of cap.secrets.allowedSecretNames) {
            if (!envelope.secrets.allowedSecretNames.includes(sec)) {
              violations.push(`Candidate requests secret '${sec}' not permitted by envelope.`);
            }
          }
        }
      }
    }

    if (violations.length > 0) {
      return {
        gate: "envelope_bounds",
        passed: false,
        category: "envelope",
        message: `Capability envelope violations detected: ${violations.join("; ")}`,
        details: { violations },
        canRepair: false,
        repairHint: "Candidate tool exceeds security boundary defined by workspace envelope.",
      };
    }

    return {
      gate: "envelope_bounds",
      passed: true,
      category: "envelope",
      message: "Candidate capabilities stay within allowed capability envelope bounds.",
    };
  }

  /**
   * Gate 5: No critical security findings.
   */
  private evaluateSecurityFindingsGate(
    findings: StaticAnalysisFinding[],
    policy: EvaluationPolicy,
    maxAllowedWarnings = 5
  ): GateCheckResult {
    const errorFindings = findings.filter((f) => f.severity === "error");
    if (errorFindings.length > 0) {
      const msgs = errorFindings.map((f) => f.message).join("; ");
      return {
        gate: "no_critical_security_findings",
        passed: false,
        category: "security",
        message: `Critical security findings detected: ${msgs}`,
        details: { errors: errorFindings },
        canRepair: true,
        repairHint: "Resolve static security findings and remove dangerous constructs.",
      };
    }

    const warningFindings = findings.filter((f) => f.severity === "warning");
    const warningLimit = policy.hardGates.maxAllowedStaticWarnings ?? maxAllowedWarnings;
    if (warningFindings.length > warningLimit) {
      return {
        gate: "no_critical_security_findings",
        passed: false,
        category: "security",
        message: `Too many static analysis warnings: ${warningFindings.length} (allowed: ${warningLimit})`,
        details: { warningCount: warningFindings.length, warningLimit },
        canRepair: true,
        repairHint: "Clean up code quality warnings and potential edge-case issues.",
      };
    }

    return {
      gate: "no_critical_security_findings",
      passed: true,
      category: "security",
      message: "Static security check passed without critical findings.",
    };
  }

  /**
   * Gate 6: Generated tests passing.
   */
  private evaluateGeneratedTestsGate(validationResult: CandidateValidationResult): GateCheckResult {
    if (!validationResult.testReport) {
      if (validationResult.passed === false) {
        return {
          gate: "generated_tests_passing",
          passed: false,
          category: "tests",
          message: "Candidate validation failed without test report.",
          canRepair: true,
          repairHint: "Fix candidate runtime errors.",
        };
      }
      return {
        gate: "generated_tests_passing",
        passed: true,
        category: "tests",
        message: "No test report generated, validation status passed.",
      };
    }

    const { failed: failedCount, totalTests: totalCount, passed: passedCount } = validationResult.testReport;
    if (failedCount > 0) {
      const failedTests = validationResult.testReport.results
        .filter((r) => r.status === "fail" || r.status === "error" || r.status === "timeout")
        .map((r) => `${r.name}: ${r.error ?? "Failed"}`);
      return {
        gate: "generated_tests_passing",
        passed: false,
        category: "tests",
        message: `${failedCount} of ${totalCount} generated test cases failed: ${failedTests.slice(0, 3).join("; ")}`,
        details: { failedCount, totalCount, passedCount, failedTests },
        canRepair: true,
        repairHint: `Fix code behavior for failing test cases: ${failedTests.slice(0, 2).join("; ")}`,
      };
    }

    if (totalCount === 0) {
      return {
        gate: "generated_tests_passing",
        passed: false,
        category: "tests",
        message: "Test execution report contains zero test cases.",
        canRepair: true,
        repairHint: "Synthesize and execute unit and property test suite.",
      };
    }

    return {
      gate: "generated_tests_passing",
      passed: true,
      category: "tests",
      message: `All ${totalCount} synthesized test cases passed successfully.`,
    };
  }

  /**
   * Gate 7: Replay divergence check.
   */
  private evaluateReplayDivergenceGate(
    replayResult: HistoricalReplayResult | undefined,
    minPassRate: number,
    minScenarioCount: number
  ): GateCheckResult {
    if (!replayResult) {
      // Replay not executed; if required, will be caught by evidence completeness
      return {
        gate: "replay_divergence_check",
        passed: true,
        category: "replay",
        message: "Replay was not executed for this candidate.",
      };
    }

    if (replayResult.status === "terminal_divergence") {
      const findings = replayResult.divergenceFindings.map((f) => f.message).join("; ");
      return {
        gate: "replay_divergence_check",
        passed: false,
        category: "replay",
        message: `Terminal divergence in historical replay: ${findings || "Invariant check failed"}`,
        details: { divergenceFindings: replayResult.divergenceFindings },
        canRepair: false,
        repairHint: "Candidate tool fundamentally diverges from historical behavior baseline.",
      };
    }

    if (replayResult.status === "repairable_divergence") {
      const findings = replayResult.divergenceFindings.map((f) => f.message).join("; ");
      return {
        gate: "replay_divergence_check",
        passed: false,
        category: "replay",
        message: `Repairable divergence in historical replay: ${findings || "Replay invariant mismatch"}`,
        details: { divergenceFindings: replayResult.divergenceFindings },
        canRepair: true,
        repairHint: "Adjust tool output format or parameter mapping to preserve historical invariant behavior.",
      };
    }

    // Check critical invariant evaluations across scenarios
    for (const sc of replayResult.scenarioResults) {
      const criticalFailures = sc.invariantEvaluations.filter(
        (inv) => !inv.passed && inv.severity === "critical"
      );
      if (criticalFailures.length > 0) {
        const msgs = criticalFailures.map((i) => i.invariantName).join(", ");
        return {
          gate: "replay_divergence_check",
          passed: false,
          category: "replay",
          message: `Critical replay invariant failed: ${msgs} in scenario ${sc.scenarioName}`,
          details: { criticalFailures },
          canRepair: true,
          repairHint: `Ensure critical replay invariant '${msgs}' is maintained during tool execution.`,
        };
      }
    }

    if (replayResult.totalScenarioCount > 0) {
      const passRate = replayResult.passedScenarioCount / replayResult.totalScenarioCount;
      if (passRate < minPassRate) {
        return {
          gate: "replay_divergence_check",
          passed: false,
          category: "replay",
          message: `Replay pass rate ${(passRate * 100).toFixed(1)}% is below required minimum ${(minPassRate * 100).toFixed(1)}% (${replayResult.passedScenarioCount}/${replayResult.totalScenarioCount} scenarios passed).`,
          details: { passRate, minPassRate, passed: replayResult.passedScenarioCount, total: replayResult.totalScenarioCount },
          canRepair: true,
          repairHint: "Fix edge case regressions in failing historical replay scenarios.",
        };
      }
    }

    return {
      gate: "replay_divergence_check",
      passed: true,
      category: "replay",
      message: `Historical replay passed with ${replayResult.passedScenarioCount}/${replayResult.totalScenarioCount} scenarios conforming to invariants.`,
    };
  }

  /**
   * Gate 8: Evidence completeness.
   */
  private evaluateEvidenceCompletenessGate(
    validationResult: CandidateValidationResult,
    replayResult: HistoricalReplayResult | undefined,
    minReplayScenarioCount: number
  ): GateCheckResult {
    if (validationResult.status === "infrastructure_fail") {
      return {
        gate: "evidence_completeness",
        passed: false,
        category: "evidence",
        message: "Candidate validation encountered an infrastructure failure.",
        canRepair: true,
        repairHint: "Retry validation execution on healthy infrastructure.",
      };
    }

    if (replayResult && replayResult.status === "infrastructure_failure") {
      return {
        gate: "evidence_completeness",
        passed: false,
        category: "evidence",
        message: "Historical replay encountered an infrastructure failure.",
        canRepair: true,
        repairHint: "Retry replay execution on healthy infrastructure.",
      };
    }

    if (minReplayScenarioCount > 0 && (!replayResult || replayResult.totalScenarioCount < minReplayScenarioCount)) {
      const current = replayResult?.totalScenarioCount ?? 0;
      return {
        gate: "evidence_completeness",
        passed: false,
        category: "evidence",
        message: `Insufficient replay evidence: candidate evaluated on ${current} replay scenarios (required at least ${minReplayScenarioCount}).`,
        details: { currentScenarioCount: current, minReplayScenarioCount },
        canRepair: true,
        repairHint: `Acquire at least ${minReplayScenarioCount} historical session evidence scenarios before eligibility.`,
      };
    }

    return {
      gate: "evidence_completeness",
      passed: true,
      category: "evidence",
      message: "Evidence package is complete and validated without infrastructure faults.",
    };
  }
}
