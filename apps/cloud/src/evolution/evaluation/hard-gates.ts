import type { CapabilityEnvelope, CapabilityManifest, ToolManifest } from "@tool-evolver/contracts";
import type { ToolPlan, WorkflowCoverage } from "../generator/types.js";
import type { WorkflowContract } from "../opportunity/types.js";
import type { HistoricalReplayResult, WorkloadBenchmarkComparison, WorkloadSize } from "../replay/types.js";
import type { CandidateValidationResult, StaticAnalysisFinding } from "../testing/types.js";
import { buildWorkflowCoverage } from "../generator/workflow-coverage.js";
import { calculateWeightedModelCost, resolveModelCostSchedule, assertValidScheduleId, MODEL_COST_SCHEDULES } from "../replay/types.js";
import { classifyRiskTier } from "./policy.js";
import type { EvaluationPolicy, GateCheckResult, HardGateResult, RiskTier } from "./types.js";

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
  workflowContract?: WorkflowContract;
  workflowCoverage?: WorkflowCoverage;
  toolPlan?: ToolPlan;
  candidateRevisionId?: string;
  artifactDigest?: string;
  verifiedBenchmarkIds?: string[];
}

/**
 * Evaluates non-negotiable hard safety gates for an evolution candidate.
 */
export class HardGateEvaluator {
  /**
   * Evaluates all hard gates and returns an aggregated HardGateResult.
   */
  evaluate(context: HardGateEvaluationContext): HardGateResult {
    const {
      policy,
      manifest,
      sourceCode,
      requiredCapabilities,
      validationResult,
      replayResult,
      envelope,
    } = context;
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
      gateResults.push(
        this.evaluateManifestParityGate(
          manifest,
          requiredCapabilities,
          validationResult.staticFindings,
        ),
      );
    }

    // 4. Envelope Bounds Gate
    if (policy.hardGates.enforceEnvelopeBounds && envelope) {
      gateResults.push(this.evaluateEnvelopeBoundsGate(manifest, requiredCapabilities, envelope));
    }

    // 5. Critical Security Findings Gate
    if (policy.hardGates.forbidCriticalSecurityFindings) {
      gateResults.push(
        this.evaluateSecurityFindingsGate(
          validationResult.staticFindings,
          policy,
          tierThresholds.maxAllowedStaticWarnings,
        ),
      );
    }

    // 6. Generated Tests Passing Gate
    if (policy.hardGates.requireGeneratedTestsPass) {
      gateResults.push(this.evaluateGeneratedTestsGate(validationResult));
    }

    // 7. Replay Divergence Gate
    if (policy.hardGates.forbidReplayDivergence) {
      gateResults.push(
        this.evaluateReplayDivergenceGate(
          replayResult,
          tierThresholds.minReplayPassRate,
          tierThresholds.minReplayScenarioCount,
        ),
      );
    }

    // 8. Evidence Completeness Gate
    if (policy.hardGates.requireEvidenceCompleteness) {
      gateResults.push(
        this.evaluateEvidenceCompletenessGate(
          validationResult,
          replayResult,
          tierThresholds.minReplayScenarioCount,
        ),
      );
    }

    const authoritativeWorkflowContract = context.toolPlan?.workflowContract ?? context.workflowContract;
    // 9. Workflow Coverage Gate (only for workflow-contract candidates) — recompute coverage from authoritative ToolPlan
    if (this.shouldEvaluateWorkflowCoverage(policy, authoritativeWorkflowContract)) {
      gateResults.push(
        this.evaluateWorkflowCoverageGate(authoritativeWorkflowContract, context.toolPlan),
      );
    }

    // 10. Workload Cost Non-Regression Gate (only for workflow-contract candidates)
    if (this.shouldEvaluateWorkloadCostNonRegression(policy, authoritativeWorkflowContract)) {
      gateResults.push(
        this.evaluateWorkloadCostNonRegressionGate(
          authoritativeWorkflowContract,
          replayResult,
          context.candidateRevisionId,
          context.artifactDigest,
          context.verifiedBenchmarkIds,
        ),
      );
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
    validationResult: CandidateValidationResult,
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
      const errorMsg =
        validationResult.typecheckErrors?.join("; ") ?? "TypeScript compilation failed.";
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
      (f) =>
        (f.category === "forbidden_import" || f.category === "forbidden_api") &&
        f.severity === "error",
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
        repairHint:
          "Remove forbidden module imports and unauthorized node APIs; use platform SDK / broker APIs instead.",
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
    findings: StaticAnalysisFinding[],
  ): GateCheckResult {
    const parityFindings = findings.filter(
      (f) =>
        (f.category === "undeclared_capability" || f.category === "broker_manifest_mismatch") &&
        f.severity === "error",
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
        repairHint:
          "Declare all required capabilities in manifest or remove undeclared broker API calls from source code.",
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
    envelope: CapabilityEnvelope,
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
              violations.push(
                `Candidate requests access to domain '${dom}' not permitted by envelope.`,
              );
            }
          }
        }
      }

      // Check commands
      if (cap.command?.allowedCommands && cap.command.allowedCommands.length > 0) {
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
      if (cap.secrets?.allowedSecretNames && cap.secrets.allowedSecretNames.length > 0) {
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
    maxAllowedWarnings = 5,
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

    const {
      failed: failedCount,
      totalTests: totalCount,
      passed: passedCount,
    } = validationResult.testReport;
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
    minScenarioCount: number,
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
        repairHint:
          "Adjust tool output format or parameter mapping to preserve historical invariant behavior.",
      };
    }

    // Check critical invariant evaluations across scenarios
    for (const sc of replayResult.scenarioResults) {
      const criticalFailures = sc.invariantEvaluations.filter(
        (inv) => !inv.passed && inv.severity === "critical",
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
          details: {
            passRate,
            minPassRate,
            passed: replayResult.passedScenarioCount,
            total: replayResult.totalScenarioCount,
          },
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
    minReplayScenarioCount: number,
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

    if (
      minReplayScenarioCount > 0 &&
      (!replayResult || replayResult.totalScenarioCount < minReplayScenarioCount)
    ) {
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
  private shouldEvaluateWorkflowCoverage(
    policy: EvaluationPolicy,
    workflowContract?: WorkflowContract,
  ): boolean {
    if (!workflowContract) return false;
    const hg = policy.hardGates as unknown as Record<string, unknown>;
    const flag =
      (hg["requireWorkflowCoverage"] as boolean | undefined) ??
      (hg["enforceWorkflowCoverage"] as boolean | undefined) ??
      (hg["requireWorkflowCoverageGate"] as boolean | undefined) ??
      true;
    return Boolean(flag);
  }

  private shouldEvaluateWorkloadCostNonRegression(
    policy: EvaluationPolicy,
    workflowContract?: WorkflowContract,
  ): boolean {
    if (!workflowContract) return false;
    const hg = policy.hardGates as unknown as Record<string, unknown>;
    const flag =
      (hg["requireWorkloadCostNonRegression"] as boolean | undefined) ??
      (hg["forbidWorkloadCostRegression"] as boolean | undefined) ??
      (hg["enforceWorkloadCostNonRegression"] as boolean | undefined) ??
      (hg["requireWorkloadBenchmarkCostCheck"] as boolean | undefined) ??
      true;
    return Boolean(flag);
  }

  /**
   * Gate 9: Workflow Coverage — recomputes coverage from authoritative ToolPlan via buildWorkflowCoverage.
   * Ignores caller-provided WorkflowCoverage.complete as evidence. Enforces exact contract operation/output sets
   * and nonempty step/schema mappings. Repairable; details contain missing IDs/names.
   */
  private evaluateWorkflowCoverageGate(
    workflowContract: WorkflowContract | undefined,
    toolPlan: ToolPlan | undefined,
  ): GateCheckResult {
    if (!workflowContract) {
      return {
        gate: "workflow_coverage",
        passed: true,
        category: "workflow",
        message: "No workflow contract present; coverage gate skipped for legacy candidate.",
      };
    }

    if (!toolPlan) {
      const uncoveredOperationIds = (workflowContract.operations ?? []).map((op) => op.id);
      const uncoveredOutputNames = (workflowContract.outputRequirements ?? [])
        .filter((r) => r.required)
        .map((r) => r.name);
      return {
        gate: "workflow_coverage",
        passed: false,
        category: "workflow",
        message: `Workflow coverage missing: no ToolPlan provided (required ${uncoveredOperationIds.length} operations, ${uncoveredOutputNames.length} outputs).`,
        details: {
          uncoveredOperationIds,
          uncoveredOutputNames,
          missingToolPlan: true,
        },
        canRepair: true,
        repairHint: "Ensure every workflow contract operation and required output is covered by plan steps and outputSchema.",
      };
    }

    const steps = (toolPlan.steps ?? []) as unknown as import("../generator/types.js").WorkflowStep[];
    const outputSchema = toolPlan.outputSchema as unknown as Record<string, unknown>;
    const computed = buildWorkflowCoverage(workflowContract, steps, outputSchema as any);

    if (!computed) {
      const uncoveredOperationIds = (workflowContract.operations ?? []).map((op) => op.id);
      const uncoveredOutputNames = (workflowContract.outputRequirements ?? [])
        .filter((r) => r.required)
        .map((r) => r.name);
      return {
        gate: "workflow_coverage",
        passed: false,
        category: "workflow",
        message: `Workflow coverage missing: unable to compute coverage (required ${uncoveredOperationIds.length} operations, ${uncoveredOutputNames.length} outputs).`,
        details: {
          uncoveredOperationIds,
          uncoveredOutputNames,
          missingCoverage: true,
        },
        canRepair: true,
        repairHint: "Ensure every workflow contract operation and required output is covered by plan steps and outputSchema.",
      };
    }

    const uncoveredOperationIds = computed.uncoveredOperationIds ?? [];
    const uncoveredOutputNames = computed.uncoveredOutputNames ?? [];
    const complete = computed.complete === true;

    const contractOperationIds = new Set((workflowContract.operations ?? []).map((op) => op.id));
    const coverageOperationIds = new Set((computed.operationCoverage ?? []).map((e) => e.operationId));

    const hasEmptyStepMapping = (computed.operationCoverage ?? []).some(
      (entry) => !Array.isArray((entry as any).stepIds) || (entry as any).stepIds.length === 0,
    );
    const hasEmptySchemaMapping = (computed.outputCoverage ?? []).some((entry) => {
      const req = workflowContract.outputRequirements.find((r) => r.name === (entry as any).outputName);
      if (!req?.required) return false;
      return !Array.isArray((entry as any).schemaPaths) || (entry as any).schemaPaths.length === 0;
    });
    const hasEmptyOutputStepMapping = (computed.outputCoverage ?? []).some((entry) => {
      const req = workflowContract.outputRequirements.find((r) => r.name === (entry as any).outputName);
      if (!req?.required) return false;
      return !Array.isArray((entry as any).stepIds) || (entry as any).stepIds.length === 0;
    });

    const operationSetMismatch =
      contractOperationIds.size !== coverageOperationIds.size ||
      [...contractOperationIds].some((id) => !coverageOperationIds.has(id));

    if (
      !complete ||
      uncoveredOperationIds.length > 0 ||
      uncoveredOutputNames.length > 0 ||
      hasEmptyStepMapping ||
      hasEmptySchemaMapping ||
      hasEmptyOutputStepMapping ||
      operationSetMismatch
    ) {
      const parts: string[] = [];
      if (uncoveredOperationIds.length > 0) {
        parts.push(`uncovered operations: ${uncoveredOperationIds.join(", ")}`);
      }
      if (uncoveredOutputNames.length > 0) {
        parts.push(`uncovered outputs: ${uncoveredOutputNames.join(", ")}`);
      }
      if (hasEmptyStepMapping && uncoveredOperationIds.length === 0) {
        parts.push("empty step mapping for required operation");
      }
      if (hasEmptySchemaMapping && uncoveredOutputNames.length === 0) {
        parts.push("empty schema path for required output");
      }
      if (hasEmptyOutputStepMapping && uncoveredOutputNames.length === 0) {
        parts.push("empty step mapping for required output");
      }
      if (operationSetMismatch && uncoveredOperationIds.length === 0) {
        parts.push("operation set mismatch with contract");
      }
      if (!complete && parts.length === 0) {
        parts.push("coverage incomplete");
      }
      return {
        gate: "workflow_coverage",
        passed: false,
        category: "workflow",
        message: `Workflow coverage incomplete: ${parts.join("; ")}`,
        details: {
          uncoveredOperationIds,
          uncoveredOutputNames,
          complete,
          operationCoverage: computed.operationCoverage,
          outputCoverage: computed.outputCoverage,
        },
        canRepair: true,
        repairHint: "Add steps covering missing operations and ensure outputSchema includes required outputs.",
      };
    }

    return {
      gate: "workflow_coverage",
      passed: true,
      category: "workflow",
      message: "Workflow coverage complete: all operations and required outputs are covered.",
    };
  }

  /**
   * Gate 10: Workload Cost Non-Regression — requires exactly small/medium/large comparisons,
   * candidate.correct, candidateCostUsd <= baselineCostUsd at each size, and redundantVerificationCalls===0.
   * Missing data, incorrect result, cost regression, or redundancy is terminal and names the workload.
   */
    /**
   * Gate 10: Workload Cost Non-Regression — requires exactly small/medium/large comparisons,
   * candidate.correct, candidateCostUsd <= baselineCostUsd at each size, and redundantVerificationCalls===0.
   * Additionally requires immutable evidence bindings: benchmarkId, baselineRunId, candidateRunId,
   * workloadInputDigest, candidateRevisionId, artifactDigest, modelProvider, modelId, observedAt, and scheduleId.
   * Validators recompute baseline/candidate cost with authoritative scheduleId and reject mismatch. Small/medium/large rows
   * require distinct benchmark/run/input identities and exact candidate revision/artifact binding.
   * Missing data, incorrect result, cost regression, binding mismatch, or redundancy is terminal and names the workload.
   */
  private evaluateWorkloadCostNonRegressionGate(
    workflowContract: WorkflowContract | undefined,
    replayResult: HistoricalReplayResult | undefined,
    candidateRevisionId?: string,
    artifactDigest?: string,
    verifiedBenchmarkIds?: string[],
  ): GateCheckResult {
    if (!workflowContract) {
      return {
        gate: "workload_cost_non_regression",
        passed: true,
        category: "workflow",
        message: "No workflow contract present; workload cost gate skipped for legacy candidate.",
      };
    }

    const benchmarks: WorkloadBenchmarkComparison[] | undefined = (replayResult as unknown as { workloadBenchmarks?: WorkloadBenchmarkComparison[] })?.workloadBenchmarks;

    const expectedSizes: WorkloadSize[] = ["small", "medium", "large"];

    if (!benchmarks || !Array.isArray(benchmarks) || benchmarks.length === 0) {
      return {
        gate: "workload_cost_non_regression",
        passed: false,
        category: "workflow",
        message: `Missing workload benchmarks: expected workloads ${expectedSizes.join(", ")} but received none.`,
        details: {
          missingWorkloads: expectedSizes,
          expectedSizes,
          actualCount: 0,
        },
        canRepair: false,
        repairHint: "Provide workload benchmark comparisons for small, medium, and large workloads.",
      };
    }

    const sizeSet = new Set(benchmarks.map((b) => b.workloadSize));
    const missingSizes = expectedSizes.filter((s) => !sizeSet.has(s));
    const extraSizes = [...sizeSet].filter((s) => !expectedSizes.includes(s));
    if (benchmarks.length !== 3 || missingSizes.length > 0 || extraSizes.length > 0) {
      const actualSizes = benchmarks.map((b) => String(b.workloadSize)).join(", ");
      return {
        gate: "workload_cost_non_regression",
        passed: false,
        category: "workflow",
        message: `Workload benchmarks incomplete: expected exactly ${expectedSizes.join(", ")} (3 entries), got [${actualSizes}]${missingSizes.length ? `; missing ${missingSizes.join(", ")}` : ""}${extraSizes.length ? `; unexpected ${extraSizes.join(", ")}` : ""}.`,
        details: {
          expectedSizes,
          actualSizes: benchmarks.map((b) => b.workloadSize),
          missingWorkloads: missingSizes,
          extraWorkloads: extraSizes,
          actualCount: benchmarks.length,
        },
        canRepair: false,
        repairHint: "Provide exactly three workload comparisons for small, medium, and large.",
      };
    }

    // Validate required immutable evidence binding fields for each benchmark
    for (const bm of benchmarks) {
      const anyBm = bm as unknown as Record<string, unknown>;
      const ws = String((bm as any).workloadSize);
      const requiredStringFields = [
        "benchmarkId",
        "baselineRunId",
        "candidateRunId",
        "workloadInputDigest",
        "candidateRevisionId",
        "artifactDigest",
        "modelProvider",
        "modelId",
        "observedAt",
        "scheduleId",
      ];
      for (const field of requiredStringFields) {
        const val = anyBm[field];
        if (typeof val !== "string" || (val as string).trim().length === 0) {
          return {
            gate: "workload_cost_non_regression",
            passed: false,
            category: "workflow",
            message: `Workload ${ws} missing or invalid ${field}: ${String(val)}.`,
            details: {
              workloadSize: ws,
              missingField: field,
              benchmarkId: anyBm["benchmarkId"],
              workloadInputDigest: anyBm["workloadInputDigest"],
            },
            canRepair: false,
            repairHint: `Provide valid ${field} for workload ${ws}.`,
          };
        }
      }
      const scheduleId = anyBm["scheduleId"] as unknown as string | undefined;
      try {
        assertValidScheduleId(scheduleId);
        // also resolve to ensure schedule exists and prices are valid
        resolveModelCostSchedule(scheduleId as string);
      } catch (e) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} has invalid or unknown scheduleId: ${String(scheduleId)} — ${(e as Error).message}.`,
          details: { workloadSize: ws, scheduleId, error: (e as Error).message },
          canRepair: false,
          repairHint: `Provide a known evaluator-owned scheduleId (e.g. MODEL_COST_SCHEDULE_V1) for workload ${ws}.`,
        };
      }
      const observedAt = anyBm["observedAt"] as string;
      const parsed = Date.parse(observedAt);
      if (!Number.isFinite(parsed)) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} has invalid observedAt: ${observedAt}.`,
          details: { workloadSize: ws, observedAt },
          canRepair: false,
          repairHint: `Provide valid ISO observedAt for workload ${ws}.`,
        };
      }
    }

    // Require distinct identities across small/medium/large for benchmark/run/input fields
    const distinctFields = ["benchmarkId", "baselineRunId", "candidateRunId", "workloadInputDigest"] as const;
    for (const field of distinctFields) {
      const values = benchmarks.map((b) => (b as unknown as Record<string, unknown>)[field] as string);
      const seen = new Set(values);
      if (seen.size !== benchmarks.length) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload benchmarks have duplicate ${field}: ${values.join(", ")} (expected distinct across workloads).`,
          details: { field, values, duplicateField: field },
          canRepair: false,
          repairHint: `Ensure ${field} is distinct for small/medium/large workloads.`,
        };
      }
    }

    // Benchmark attestation verification: for workflow-contract candidates, all rows must be verified via BenchmarkEvidenceVerifier
    if (workflowContract) {
      const verifiedSet = new Set(verifiedBenchmarkIds ?? []);
      for (const bm of benchmarks) {
        if (!verifiedSet.has(bm.benchmarkId)) {
          return {
            gate: "workload_cost_non_regression",
            passed: false,
            category: "workflow",
            message: `Workload ${String(bm.workloadSize)} benchmark ${String(bm.benchmarkId)} not verified: missing or invalid attestation (expected HMAC-SHA256 via BenchmarkEvidenceVerifier).`,
            details: {
              workloadSize: bm.workloadSize,
              benchmarkId: bm.benchmarkId,
              verifiedBenchmarkIds: verifiedBenchmarkIds ?? [],
              expectedAttestation: "HMAC-SHA256 via BenchmarkEvidenceVerifier",
            },
            canRepair: false,
            repairHint: "Ensure workload benchmark is signed via signWorkloadBenchmark with HMAC-SHA256 and verifiedBenchmarkIds includes its benchmarkId.",
          };
        }
        // Also require attestation field presence for defense in depth
        const anyBm = bm as unknown as Record<string, unknown>;
        if (!anyBm["attestation"] || typeof anyBm["attestation"] !== "object") {
          return {
            gate: "workload_cost_non_regression",
            passed: false,
            category: "workflow",
            message: `Workload ${String(bm.workloadSize)} benchmark ${String(bm.benchmarkId)} missing attestation object.`,
            details: {
              workloadSize: bm.workloadSize,
              benchmarkId: bm.benchmarkId,
            },
            canRepair: false,
            repairHint: "Provide HMAC-SHA256 attestation via signWorkloadBenchmark.",
          };
        }
      }
    }

    // Exact candidate revision/artifact binding check
    if (candidateRevisionId) {
      for (const bm of benchmarks) {
        const anyBm = bm as unknown as Record<string, unknown>;
        if (anyBm["candidateRevisionId"] !== candidateRevisionId) {
          return {
            gate: "workload_cost_non_regression",
            passed: false,
            category: "workflow",
            message: `Workload ${String(bm.workloadSize)} candidateRevisionId mismatch: expected ${candidateRevisionId}, got ${String(anyBm["candidateRevisionId"])}.`,
            details: {
              workloadSize: bm.workloadSize,
              expectedCandidateRevisionId: candidateRevisionId,
              actualCandidateRevisionId: anyBm["candidateRevisionId"],
            },
            canRepair: false,
            repairHint: "Ensure workload benchmark candidateRevisionId matches evaluated candidate revision.",
          };
        }
      }
    } else {
      // No candidateRevisionId provided but contract exists: treat as missing binding -> fail if benchmarks lack it (already checked), but if we have no expected, skip exact match.
    }

    if (artifactDigest) {
      for (const bm of benchmarks) {
        const anyBm = bm as unknown as Record<string, unknown>;
        if (anyBm["artifactDigest"] !== artifactDigest) {
          return {
            gate: "workload_cost_non_regression",
            passed: false,
            category: "workflow",
            message: `Workload ${String(bm.workloadSize)} artifactDigest mismatch: expected ${artifactDigest}, got ${String(anyBm["artifactDigest"])}.`,
            details: {
              workloadSize: bm.workloadSize,
              expectedArtifactDigest: artifactDigest,
              actualArtifactDigest: anyBm["artifactDigest"],
            },
            canRepair: false,
            repairHint: "Ensure workload benchmark artifactDigest matches evaluated candidate artifact digest.",
          };
        }
      }
    }

    for (const bm of benchmarks) {
      const ws = String(bm.workloadSize);
      const baseline = bm.baseline as unknown as { correct?: boolean; redundantToolCalls?: number } & Record<string, unknown>;
      const candidate = bm.candidate as unknown as { correct?: boolean; redundantToolCalls?: number } & Record<string, unknown>;
      const baselineCost = bm.baselineCostUsd;
      const candidateCost = bm.candidateCostUsd;
      const correctnessPassed = bm.correctnessPassed;
      const redundant = bm.redundantVerificationCalls;
      const anyBm2 = bm as unknown as { scheduleId?: string };
      const scheduleId2 = (anyBm2.scheduleId ?? (bm as unknown as Record<string, unknown>)["scheduleId"]) as string | undefined;

      const candidateCorrect = candidate?.correct;

      // Validate and recompute costs with authoritative scheduleId
      {
        try {
          if (!scheduleId2) throw new Error("missing scheduleId");
          assertValidScheduleId(scheduleId2);
          const expectedBaseline = calculateWeightedModelCost(bm.baseline as any, scheduleId2);
          const expectedCandidate = calculateWeightedModelCost(bm.candidate as any, scheduleId2);
          const epsilon = 1e-6;
          if (Math.abs(expectedBaseline - baselineCost) > epsilon) {
            return {
              gate: "workload_cost_non_regression",
              passed: false,
              category: "workflow",
              message: `Workload ${ws} baselineCostUsd mismatch: expected ${expectedBaseline} (recomputed with scheduleId ${scheduleId2}), got ${baselineCost}.`,
              details: {
                workloadSize: ws,
                expectedBaselineCostUsd: expectedBaseline,
                baselineCostUsd: baselineCost,
                scheduleId: scheduleId2,
              },
              canRepair: false,
              repairHint: `Ensure baselineCostUsd matches weighted cost with authoritative scheduleId ${scheduleId2} for workload ${ws}.`,
            };
          }
          if (Math.abs(expectedCandidate - candidateCost) > epsilon) {
            return {
              gate: "workload_cost_non_regression",
              passed: false,
              category: "workflow",
              message: `Workload ${ws} candidateCostUsd mismatch: expected ${expectedCandidate} (recomputed with scheduleId ${scheduleId2}), got ${candidateCost}.`,
              details: {
                workloadSize: ws,
                expectedCandidateCostUsd: expectedCandidate,
                candidateCostUsd: candidateCost,
                scheduleId: scheduleId2,
              },
              canRepair: false,
              repairHint: `Ensure candidateCostUsd matches weighted cost with authoritative scheduleId ${scheduleId2} for workload ${ws}.`,
            };
          }
        } catch (e) {
          return {
            gate: "workload_cost_non_regression",
            passed: false,
            category: "workflow",
            message: `Workload ${ws} has invalid model usage metrics for cost calculation: ${(e as Error).message}`,
            details: { workloadSize: ws, error: (e as Error).message },
            canRepair: false,
            repairHint: `Provide valid model usage metrics for workload ${ws}.`,
          };
        }
      }

      if (candidateCorrect === undefined && correctnessPassed === undefined) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} missing correctness data: candidate.correct and correctnessPassed undefined.`,
          details: { workloadSize: ws, baseline, candidate },
          canRepair: false,
          repairHint: `Provide correctness for workload ${ws}.`,
        };
      }

      if (candidateCorrect !== true) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} failed correctness: candidate incorrect (candidate.correct=${String(candidateCorrect)}, correctnessPassed=${String(correctnessPassed)}).`,
          details: {
            workloadSize: ws,
            candidateCorrect,
            correctnessPassed,
            baseline,
            candidate,
          },
          canRepair: false,
          repairHint: `Ensure workload ${ws} candidate is correct.`,
        };
      }

      if (correctnessPassed !== undefined && correctnessPassed !== true) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} failed correctness: correctnessPassed false (candidate.correct=${String(candidateCorrect)}, correctnessPassed=${String(correctnessPassed)}).`,
          details: {
            workloadSize: ws,
            candidateCorrect,
            correctnessPassed,
            baseline,
            candidate,
          },
          canRepair: false,
          repairHint: `Ensure workload ${ws} candidate is correct.`,
        };
      }

      if (typeof redundant === "number" && redundant !== 0) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} has redundant verification calls: ${redundant} (expected 0).`,
          details: {
            workloadSize: ws,
            redundantVerificationCalls: redundant,
            candidateRedundantToolCalls: candidate?.redundantToolCalls,
          },
          canRepair: false,
          repairHint: `Remove redundant verification tool calls for workload ${ws}.`,
        };
      }

      if (typeof candidate?.redundantToolCalls === "number" && candidate.redundantToolCalls !== 0) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} has redundant verification calls: candidate redundantToolCalls=${candidate.redundantToolCalls} (expected 0).`,
          details: {
            workloadSize: ws,
            redundantVerificationCalls: redundant,
            candidateRedundantToolCalls: candidate.redundantToolCalls,
          },
          canRepair: false,
          repairHint: `Remove redundant verification tool calls for workload ${ws}.`,
        };
      }

      if (typeof baselineCost !== "number" || !Number.isFinite(baselineCost) || baselineCost < 0) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} has invalid baselineCostUsd: ${String(baselineCost)}.`,
          details: { workloadSize: ws, baselineCostUsd: baselineCost, candidateCostUsd: candidateCost },
          canRepair: false,
          repairHint: `Provide finite baselineCostUsd for workload ${ws}.`,
        };
      }
      if (typeof candidateCost !== "number" || !Number.isFinite(candidateCost) || candidateCost < 0) {
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} has invalid candidateCostUsd: ${String(candidateCost)}.`,
          details: { workloadSize: ws, baselineCostUsd: baselineCost, candidateCostUsd: candidateCost },
          canRepair: false,
          repairHint: `Provide finite candidateCostUsd for workload ${ws}.`,
        };
      }

      if (candidateCost > baselineCost) {
        const delta = candidateCost - baselineCost;
        const deltaPercent = baselineCost > 0 ? ((delta / baselineCost) * 100).toFixed(2) : "N/A";
        return {
          gate: "workload_cost_non_regression",
          passed: false,
          category: "workflow",
          message: `Workload ${ws} cost regression: candidateCostUsd ${candidateCost} > baselineCostUsd ${baselineCost} (delta ${delta.toFixed(2)}, ${deltaPercent}%).`,
          details: {
            workloadSize: ws,
            baselineCostUsd: baselineCost,
            candidateCostUsd: candidateCost,
            delta,
            costDeltaPercent: bm.costDeltaPercent,
          },
          canRepair: false,
          repairHint: `Reduce candidate cost for workload ${ws} to be <= baseline.`,
        };
      }
    }

    return {
      gate: "workload_cost_non_regression",
      passed: true,
      category: "workflow",
      message: "Workload benchmarks passed: all small/medium/large workloads are correct, non-redundant, and cost non-regressing.",
    };
  }
}
