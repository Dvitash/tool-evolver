import { describe, expect, it } from "vitest";
import { HardGateEvaluator } from "../../../src/evolution/evaluation/hard-gates.js";
import {
  STANDARD_EVALUATION_POLICY_V1,
  STRICT_EVALUATION_POLICY_V1,
} from "../../../src/evolution/evaluation/policy.js";
import {
  createMockCandidateRevision,
  createMockEnvelope,
  createMockReplayResult,
  createMockToolManifest,
  createMockValidationResult,
} from "./helpers.js";

describe("HardGateEvaluator (Non-Negotiable Hard Safety Gates)", () => {
  const evaluator = new HardGateEvaluator();
  const policy = STANDARD_EVALUATION_POLICY_V1;

  describe("Gate 1: Compile and Schema Gate (compile_schema_pass)", () => {
    it("fails gate if source code is empty", () => {
      const candidate = createMockCandidateRevision({ sourceCode: "   " });
      const validationResult = createMockValidationResult();

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("compile_schema_pass");
      expect(result.canRepair).toBe(true);
    });

    it("fails gate if manifest is missing required identity fields", () => {
      const candidate = createMockCandidateRevision();
      const invalidManifest = { ...candidate.artifacts.manifest, id: "" };
      const validationResult = createMockValidationResult();

      const result = evaluator.evaluate({
        manifest: invalidManifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("compile_schema_pass");
    });

    it("fails gate if typecheck failed with compilation errors", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        typecheckPassed: false,
        typecheckErrors: [
          "Cannot find name 'undeclaredVar'",
          "Type 'string' is not assignable to 'number'",
        ],
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("compile_schema_pass");
      expect(result.canRepair).toBe(true);
      expect(result.rejectionReason).toContain("Type check compilation failed");
    });

    it("marks failure non-repairable if validation status is terminal_fail", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        status: "terminal_fail",
        passed: false,
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.canRepair).toBe(false);
    });
  });

  describe("Gate 2: Forbidden Imports Gate (no_forbidden_imports)", () => {
    it("fails gate if code imports forbidden modules (e.g. node:fs, child_process)", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        staticFindings: [
          {
            severity: "error",
            category: "forbidden_import",
            message: "Forbidden module import: node:fs is unauthorized in sandboxed candidate code",
          },
        ],
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("no_forbidden_imports");
      expect(result.rejectionReason).toContain("Forbidden module import");
    });

    it("fails gate if unauthorized internal APIs are invoked", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        staticFindings: [
          {
            severity: "error",
            category: "forbidden_api",
            message: "Direct process.exit() invocation is prohibited",
          },
        ],
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("no_forbidden_imports");
    });
  });

  describe("Gate 3: Manifest-Capability Parity Gate (manifest_capability_parity)", () => {
    it("fails gate if undeclared capabilities are accessed in code", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        staticFindings: [
          {
            severity: "error",
            category: "undeclared_capability",
            message:
              "Code uses context.brokers.net but no network capabilities are declared in manifest",
          },
        ],
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("manifest_capability_parity");
      expect(result.rejectionReason).toContain("Capabilities used in code do not match manifest");
    });
  });

  describe("Gate 4: Envelope Bounds Gate (envelope_bounds)", () => {
    it("fails gate if candidate requests write access in a read-only workspace envelope", () => {
      const manifest = createMockToolManifest({
        capabilities: {
          fs: {
            readPaths: ["/workspace"],
            writePaths: ["/workspace/output.txt"],
            allowWorkspaceRoot: true,
            allowTemp: false,
            denyPaths: [],
            maxFileSizeBytes: 1048576,
          },
          net: {
            allowOutbound: false,
            allowedDomains: [],
            allowedPorts: [],
            allowInsecureHttp: false,
            denyDomains: [],
            denyPrivateRanges: true,
          },
          command: {
            allowedCommands: [],
            allowEnvInheritance: false,
            denyCommands: [],
            allowPipes: false,
            maxExecutionTimeMs: 1000,
          },
          secrets: {
            allowedSecretNames: [],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
          limits: {
            maxConcurrentExecutions: 1,
            maxCpuUsagePercent: 100,
            maxMemoryMb: 128,
            maxExecutionTimeMs: 1000,
            maxOutputSizeBytes: 1048576,
          },
        },
      });

      const envelope = createMockEnvelope({
        fs: {
          readPaths: ["/workspace"],
          writePaths: [], // Read-only!
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 1048576,
        },
      });

      const validationResult = createMockValidationResult();

      const result = evaluator.evaluate({
        manifest,
        sourceCode: "export default {}",
        requiredCapabilities: manifest.capabilities,
        validationResult,
        envelope,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("envelope_bounds");
      expect(result.canRepair).toBe(false);
      expect(result.rejectionReason).toContain("read-only envelope");
    });

    it("fails gate if candidate requests disallowed network domains", () => {
      const manifest = createMockToolManifest({
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: [],
            allowWorkspaceRoot: false,
            allowTemp: false,
            denyPaths: [],
            maxFileSizeBytes: 1048576,
          },
          net: {
            allowOutbound: true,
            allowedDomains: ["unauthorized-domain.com"],
            allowedPorts: [443],
            allowInsecureHttp: false,
            denyDomains: [],
            denyPrivateRanges: true,
          },
          command: {
            allowedCommands: [],
            allowEnvInheritance: false,
            denyCommands: [],
            allowPipes: false,
            maxExecutionTimeMs: 1000,
          },
          secrets: {
            allowedSecretNames: [],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
          limits: {
            maxConcurrentExecutions: 1,
            maxCpuUsagePercent: 100,
            maxMemoryMb: 128,
            maxExecutionTimeMs: 1000,
            maxOutputSizeBytes: 1048576,
          },
        },
      });

      const envelope = createMockEnvelope({
        net: {
          allowOutbound: true,
          allowedDomains: ["api.allowed.com"],
          allowedPorts: [443],
          allowInsecureHttp: false,
          denyDomains: [],
          denyPrivateRanges: true,
        },
      });

      const validationResult = createMockValidationResult();

      const result = evaluator.evaluate({
        manifest,
        sourceCode: "export default {}",
        requiredCapabilities: manifest.capabilities,
        validationResult,
        envelope,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("envelope_bounds");
      expect(result.rejectionReason).toContain("not permitted by envelope");
    });

    it("fails gate if candidate requests access to denied filesystem paths", () => {
      const manifest = createMockToolManifest({
        capabilities: {
          fs: {
            readPaths: ["/etc/shadow"],
            writePaths: [],
            allowWorkspaceRoot: false,
            allowTemp: false,
            denyPaths: [],
            maxFileSizeBytes: 1048576,
          },
          net: {
            allowOutbound: false,
            allowedDomains: [],
            allowedPorts: [],
            allowInsecureHttp: false,
            denyDomains: [],
            denyPrivateRanges: true,
          },
          command: {
            allowedCommands: [],
            allowEnvInheritance: false,
            denyCommands: [],
            allowPipes: false,
            maxExecutionTimeMs: 1000,
          },
          secrets: {
            allowedSecretNames: [],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
          limits: {
            maxConcurrentExecutions: 1,
            maxCpuUsagePercent: 100,
            maxMemoryMb: 128,
            maxExecutionTimeMs: 1000,
            maxOutputSizeBytes: 1048576,
          },
        },
      });

      const envelope = createMockEnvelope({
        fs: {
          readPaths: ["/workspace"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: ["/etc"],
          maxFileSizeBytes: 1048576,
        },
      });

      const validationResult = createMockValidationResult();

      const result = evaluator.evaluate({
        manifest,
        sourceCode: "export default {}",
        requiredCapabilities: manifest.capabilities,
        validationResult,
        envelope,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("envelope_bounds");
      expect(result.rejectionReason).toContain("denied filesystem path");
    });
  });

  describe("Gate 5: Critical Security Findings Gate (no_critical_security_findings)", () => {
    it("fails gate if static analysis findings contain error severity", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        staticFindings: [
          {
            severity: "error",
            category: "static_flaw",
            message: "Dangerous dynamic code evaluation via eval() detected",
          },
        ],
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("no_critical_security_findings");
    });

    it("fails gate if static analysis warnings exceed policy limit", () => {
      const candidate = createMockCandidateRevision();
      const warnings = Array.from({ length: 15 }, (_, i) => ({
        severity: "warning" as const,
        category: "static_flaw" as const,
        message: `Potential flaw #${i}`,
      }));

      const validationResult = createMockValidationResult({
        staticFindings: warnings,
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("no_critical_security_findings");
      expect(result.rejectionReason).toContain("Too many static analysis warnings");
    });
  });

  describe("Gate 6: Generated Tests Passing Gate (generated_tests_passing)", () => {
    it("fails gate if any synthesized test cases failed", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        testReport: {
          suiteId: "suite-1",
          totalTests: 10,
          passed: 8,
          failed: 2,
          timeouts: 0,
          durationMs: 150,
          results: [
            {
              testId: "t-1",
              name: "division_by_zero_handling",
              testType: "edge_case",
              status: "fail",
              durationMs: 15,
              passed: false,
              error: "Expected ZeroDivisionError but received Infinity",
            },
          ],
        },
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("generated_tests_passing");
      expect(result.rejectionReason).toContain("2 of 10 generated test cases failed");
      expect(result.canRepair).toBe(true);
      expect(result.repairTargets?.some((t) => t.includes("division_by_zero_handling"))).toBe(true);
    });

    it("fails gate if test report has zero test cases", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        testReport: {
          suiteId: "suite-0",
          totalTests: 0,
          passed: 0,
          failed: 0,
          timeouts: 0,
          durationMs: 0,
          results: [],
        },
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("generated_tests_passing");
      expect(result.rejectionReason).toContain("contains zero test cases");
    });
  });

  describe("Gate 7: Replay Divergence Gate (forbidReplayDivergence)", () => {
    it("fails gate if replay status is terminal_divergence (non-repairable)", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult();
      const replayResult = createMockReplayResult({
        status: "terminal_divergence",
        passed: false,
        divergenceFindings: [
          {
            severity: "critical",
            category: "semantic_output_mismatch",
            scenarioId: "sc-1",
            message: "Fundamental semantic deviation from historical trace",
          },
        ],
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        replayResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("replay_divergence_check");
      expect(result.canRepair).toBe(false);
    });

    it("fails gate if critical invariant evaluation fails in a scenario", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult();
      const replayResult = createMockReplayResult({
        status: "pass",
        scenarioResults: [
          {
            scenarioId: "sc-1",
            scenarioName: "invariant_test_scenario",
            type: "identical_inputs",
            status: "pass",
            passed: true,
            executionTrace: { steps: [], totalDurationMs: 30, totalTokens: 50 },
            invariantEvaluations: [
              {
                invariantId: "inv-crit",
                invariantName: "database_state_consistency",
                type: "state_immutability",
                passed: false,
                severity: "critical",
                message: "Database state modified unexpectedly",
              },
            ],
            metricsComparison: {
              baselineStepCount: 2,
              candidateStepCount: 1,
              stepReductionCount: 1,
              baselineDurationMs: 100,
              candidateDurationMs: 30,
              latencyReductionMs: 70,
              baselineTokens: 500,
              candidateTokens: 100,
              tokenReductionCount: 400,
              baselineToolCalls: 2,
              candidateToolCalls: 1,
            },
            divergenceFindings: [],
            durationMs: 30,
            seed: "seed",
          },
        ],
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        replayResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("replay_divergence_check");
      expect(result.rejectionReason).toContain(
        "Critical replay invariant failed: database_state_consistency",
      );
    });
  });

  describe("Gate 8: Evidence Completeness Gate (requireEvidenceCompleteness)", () => {
    it("fails gate if validation result encountered an infrastructure fault", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult({
        status: "infrastructure_fail",
        passed: false,
      });

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("evidence_completeness");
      expect(result.rejectionReason).toContain("infrastructure failure");
    });

    it("fails gate if replay scenario count is below policy requirement for the risk tier", () => {
      const manifest = createMockToolManifest({
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: ["/workspace/out"],
            allowWorkspaceRoot: true,
            allowTemp: false,
            denyPaths: [],
            maxFileSizeBytes: 1048576,
          },
          net: {
            allowOutbound: false,
            allowedDomains: [],
            allowedPorts: [],
            allowInsecureHttp: false,
            denyDomains: [],
            denyPrivateRanges: true,
          },
          command: {
            allowedCommands: [],
            allowEnvInheritance: false,
            denyCommands: [],
            allowPipes: false,
            maxExecutionTimeMs: 1000,
          },
          secrets: {
            allowedSecretNames: [],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
          limits: {
            maxConcurrentExecutions: 1,
            maxCpuUsagePercent: 100,
            maxMemoryMb: 128,
            maxExecutionTimeMs: 1000,
            maxOutputSizeBytes: 1048576,
          },
        },
      }); // workspace_fs tier requires at least 2 replay scenarios

      const validationResult = createMockValidationResult();
      const replayResult = createMockReplayResult({
        totalScenarioCount: 1, // Only 1 scenario provided!
        passedScenarioCount: 1,
      });

      const result = evaluator.evaluate({
        manifest,
        sourceCode: "export default {}",
        requiredCapabilities: manifest.capabilities,
        validationResult,
        replayResult,
        policy,
      });

      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain("evidence_completeness");
      expect(result.rejectionReason).toContain("Insufficient replay evidence");
    });
  });

  describe("Successful Hard Gate Evaluation", () => {
    it("passes all gates cleanly when candidate is valid and safe", () => {
      const candidate = createMockCandidateRevision();
      const validationResult = createMockValidationResult();
      const replayResult = createMockReplayResult();
      const envelope = createMockEnvelope();

      const result = evaluator.evaluate({
        manifest: candidate.artifacts.manifest,
        sourceCode: candidate.artifacts.sourceCode,
        requiredCapabilities: candidate.artifacts.capabilities,
        validationResult,
        replayResult,
        envelope,
        policy,
      });

      expect(result.passed).toBe(true);
      expect(result.failedGates).toEqual([]);
      expect(result.rejectionReason).toBeUndefined();
      expect(result.gateResults.every((g) => g.passed)).toBe(true);
    });
  });
});
