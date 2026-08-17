import type { CapabilityManifest, EvolutionCandidate, ToolManifest } from "@tool-evolver/contracts";
import type { InferenceService } from "../../models/service.js";
import type { CandidateRevision, ToolPlan } from "../generator/types.js";
import { StaticAnalyzer } from "./static-analyzer.js";
import { TestSynthesizer } from "./test-synthesizer.js";
import { TypeChecker } from "./type-checker.js";
import type {
  CandidateValidationOptions,
  CandidateValidationResult,
  CandidateValidationTarget,
  CoverageReport,
  StaticAnalysisFinding,
  StructuredRepairFeedback,
  TestExecutionReport,
  ValidationStatus,
} from "./types.js";
import { ValidationSandbox } from "./validation-sandbox.js";

export interface CandidateValidationServiceOptions {
  inferenceService?: InferenceService;
  staticAnalyzer?: StaticAnalyzer;
  typeChecker?: TypeChecker;
  synthesizer?: TestSynthesizer;
  sandbox?: ValidationSandbox;
}

/**
 * Candidate Validation Service: Coordinates AST static analysis, pinned TypeScript type checking,
 * deterministic and LLM test synthesis, sandbox test execution with fake brokers, and structured repair feedback.
 */
export class CandidateValidationService {
  private readonly staticAnalyzer: StaticAnalyzer;
  private readonly typeChecker: TypeChecker;
  private readonly synthesizer: TestSynthesizer;
  private readonly sandbox: ValidationSandbox;
  private readonly inferenceService?: InferenceService;

  constructor(options: CandidateValidationServiceOptions = {}) {
    this.staticAnalyzer = options.staticAnalyzer ?? new StaticAnalyzer();
    this.typeChecker = options.typeChecker ?? new TypeChecker();
    this.synthesizer =
      options.synthesizer ?? new TestSynthesizer({ inferenceService: options.inferenceService });
    this.sandbox = options.sandbox ?? new ValidationSandbox();
    this.inferenceService = options.inferenceService;
  }

  /**
   * Performs end-to-end validation on a candidate tool revision.
   */
  async validateCandidate(
    target: CandidateValidationTarget,
    options: CandidateValidationOptions = {},
  ): Promise<CandidateValidationResult> {
    const startTime = Date.now();
    const validatedAt = new Date(startTime).toISOString();

    // 1. Extract Target Metadata & Artifacts
    const { candidateId, revisionId, manifest, sourceCode, capabilities, plan } =
      this.extractTargetPayload(target);

    try {
      // 2. Step 1: AST Static Analysis
      const staticFindings = this.staticAnalyzer.analyze(sourceCode, manifest, capabilities);

      // Check for terminal unrepairable security errors
      const hasTerminalForbiddenImports = staticFindings.some(
        (f) =>
          f.severity === "error" &&
          (f.category === "forbidden_import" || f.category === "forbidden_api") &&
          (f.message.includes(".node") ||
            f.message.includes("http://") ||
            f.message.includes("https://")),
      );

      // 3. Step 2: Pinned TypeScript Typecheck & Schema Consistency
      const typecheckResult = this.typeChecker.check(sourceCode, manifest);

      const staticErrors = staticFindings.filter((f) => f.severity === "error");
      const hasStaticErrors = staticErrors.length > 0;
      const typecheckPassed = typecheckResult.passed;

      // If terminal security violation, reject immediately as terminal_fail
      if (hasTerminalForbiddenImports) {
        const repairFeedback = this.buildRepairFeedback(
          staticFindings,
          typecheckResult.errors,
          undefined,
          capabilities,
        );
        repairFeedback.canRepair = false; // unrepairable

        return {
          candidateId,
          revisionId,
          status: "terminal_fail",
          passed: false,
          staticFindings,
          typecheckPassed,
          typecheckErrors: typecheckResult.errors,
          repairFeedback,
          validatedAt,
          durationMs: Date.now() - startTime,
        };
      }

      // If static syntax errors or typecheck failure prevent running tests
      if (
        staticFindings.some((f) => f.category === "syntax_error") ||
        (!typecheckPassed &&
          typecheckResult.errors.some((e) => e.includes("Syntax") || e.includes("Transpilation")))
      ) {
        const repairFeedback = this.buildRepairFeedback(
          staticFindings,
          typecheckResult.errors,
          undefined,
          capabilities,
        );

        return {
          candidateId,
          revisionId,
          status: "repairable_fail",
          passed: false,
          staticFindings,
          typecheckPassed,
          typecheckErrors: typecheckResult.errors,
          repairFeedback,
          validatedAt,
          durationMs: Date.now() - startTime,
        };
      }

      // 4. Step 3: Test Synthesis (Deterministic baseline + LLM-assisted)
      const testSuite = await this.synthesizer.synthesize(manifest, sourceCode, plan, {
        inferenceService: this.inferenceService,
        skipLlm: options.skipLlmTestSynthesis,
      });

      // 5. Step 4: Sandbox Test Execution with Deterministic Fake Brokers
      const testReport = await this.sandbox.executeTestSuite(sourceCode, manifest, testSuite, {
        timeoutMs: options.timeoutMs ?? 5000,
        maxExecutionTimeMs: options.maxExecutionTimeMs ?? 10000,
        capabilities,
      });

      const coverageReport: CoverageReport | undefined = testReport.coverage;

      // 6. Step 5: Verdict & Structured Repair Formulation
      const hasTestFailures = testReport.failed > 0 || testReport.timeouts > 0;
      const coverageThreshold = options.coverageThresholdPercent ?? 50;
      const coveragePassed =
        !coverageReport || coverageReport.statementCoveragePercent >= coverageThreshold;

      let status: ValidationStatus = "pass";

      if (hasStaticErrors || !typecheckPassed || hasTestFailures || !coveragePassed) {
        status = "repairable_fail";
      }

      let repairFeedback: StructuredRepairFeedback | undefined;
      if (status === "repairable_fail") {
        repairFeedback = this.buildRepairFeedback(
          staticFindings,
          typecheckResult.errors,
          testReport,
          capabilities,
        );
      }

      return {
        candidateId,
        revisionId,
        status,
        passed: status === "pass",
        staticFindings,
        typecheckPassed,
        typecheckErrors: typecheckResult.errors,
        testReport,
        coverage: coverageReport,
        repairFeedback,
        validatedAt,
        durationMs: Date.now() - startTime,
      };
    } catch (infraError: unknown) {
      // Step 6: Infrastructure Failure Handling
      const errMsg = infraError instanceof Error ? infraError.message : String(infraError);
      return {
        candidateId,
        revisionId,
        status: "infrastructure_fail",
        passed: false,
        staticFindings: [
          {
            severity: "error",
            category: "static_flaw",
            message: `Sandbox infrastructure failure: ${errMsg}`,
          },
        ],
        typecheckPassed: false,
        typecheckErrors: [`Infrastructure failure: ${errMsg}`],
        validatedAt,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Extracts normalized payloads from various candidate target representations.
   */
  private extractTargetPayload(target: CandidateValidationTarget): {
    candidateId: string;
    revisionId?: string;
    manifest: ToolManifest | Partial<ToolManifest>;
    sourceCode: string;
    capabilities?: CapabilityManifest;
    plan?: ToolPlan;
  } {
    // Check if target is CandidateRevision
    if ("revisionId" in target && "artifacts" in target) {
      const rev = target as CandidateRevision;
      return {
        candidateId: rev.candidateId,
        revisionId: rev.revisionId,
        manifest: rev.artifacts.manifest,
        sourceCode: rev.artifacts.sourceCode,
        capabilities: rev.artifacts.capabilities,
        plan: rev.artifacts.plan,
      };
    }

    // Check if target is EvolutionCandidate
    if ("proposedTool" in target && "requiredCapabilities" in target) {
      const cand = target as EvolutionCandidate;
      return {
        candidateId: cand.id,
        manifest: cand.proposedTool,
        sourceCode: cand.sourceCode ?? "",
        capabilities: cand.requiredCapabilities,
      };
    }

    // Fallback custom target
    const custom = target as {
      id?: string;
      candidateId?: string;
      revisionId?: string;
      manifest: ToolManifest;
      sourceCode: string;
      requiredCapabilities?: CapabilityManifest;
      workflowDefinition?: Record<string, unknown>;
    };

    return {
      candidateId: custom.candidateId ?? custom.id ?? "candidate_anonymous",
      revisionId: custom.revisionId,
      manifest: custom.manifest,
      sourceCode: custom.sourceCode,
      capabilities: custom.requiredCapabilities ?? custom.manifest.capabilities,
    };
  }

  /**
   * Formulates structured repair feedback with suggested fixes and recommended manifest/code changes.
   */
  private buildRepairFeedback(
    staticFindings: StaticAnalysisFinding[],
    typecheckErrors: string[],
    testReport?: TestExecutionReport,
    currentCapabilities?: CapabilityManifest,
  ): StructuredRepairFeedback {
    const suggestedFixes: string[] = [];
    const failedTestSummaries: string[] = [];
    const recommendedChanges: StructuredRepairFeedback["recommendedChanges"] = {};

    // 1. Process Static Findings
    for (const finding of staticFindings) {
      if (finding.fixHint) {
        suggestedFixes.push(`[${finding.category}] ${finding.fixHint}`);
      } else {
        suggestedFixes.push(`[${finding.category}] Fix: ${finding.message}`);
      }

      // Recommend capability upgrades if undeclared capability was detected
      if (finding.category === "undeclared_capability") {
        if (finding.message.includes("filesystem") || finding.message.includes("fs")) {
          recommendedChanges.capabilities = {
            ...recommendedChanges.capabilities,
            fs: {
              ...(currentCapabilities?.fs ?? {
                readPaths: [],
                writePaths: [],
                denyPaths: [],
                maxFileSizeBytes: 10485760,
              }),
              allowWorkspaceRoot: true,
              allowTemp: true,
            },
          };
        } else if (finding.message.includes("network") || finding.message.includes("net")) {
          recommendedChanges.capabilities = {
            ...recommendedChanges.capabilities,
            net: {
              ...(currentCapabilities?.net ?? {
                allowedDomains: [],
                allowedHosts: [],
                allowedPorts: [],
                allowedProtocols: ["https"],
                allowLocalhost: false,
                denyPrivateRanges: true,
              }),
              allowOutbound: true,
            },
          };
        } else if (finding.message.includes("command") || finding.message.includes("cmd")) {
          recommendedChanges.capabilities = {
            ...recommendedChanges.capabilities,
            command: {
              ...(currentCapabilities?.command ?? {
                allowedCommands: [],
                allowedBinaries: [],
                forbiddenPatterns: [],
                allowEnvPassthrough: [],
              }),
              allowShellExecution: true,
            },
          };
        }
      }
    }

    // 2. Process Typecheck Errors
    for (const typeError of typecheckErrors) {
      suggestedFixes.push(`[typecheck] Fix TypeScript error: ${typeError}`);
    }

    // 3. Process Failed Tests
    if (testReport) {
      for (const t of testReport.results) {
        if (!t.passed) {
          failedTestSummaries.push(
            `Test '${t.name}' (${t.testType}) failed: ${t.error ?? "assertion failure"}`,
          );
          if (t.testType === "schema_boundary") {
            suggestedFixes.push(
              `Ensure InputSchema strictly parses and rejects invalid parameter combinations.`,
            );
          } else if (t.testType === "error_mode") {
            suggestedFixes.push(
              `Wrap broker calls in try-catch and handle external broker errors gracefully.`,
            );
          } else if (t.testType === "happy_path") {
            suggestedFixes.push(
              `Check tool implementation logic and ensure valid return payload matching OutputSchema.`,
            );
          }
        }
      }
    }

    return {
      canRepair: true,
      suggestedFixes,
      findings: staticFindings,
      failedTestSummaries,
      recommendedChanges,
    };
  }
}

/**
 * Factory function for creating a CandidateValidationService instance.
 */
export function createCandidateValidationService(
  options: CandidateValidationServiceOptions = {},
): CandidateValidationService {
  return new CandidateValidationService(options);
}
