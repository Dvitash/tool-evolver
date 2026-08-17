import type {
  CapabilityEnvelope,
  CapabilityManifest,
  EvolutionCandidate,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { CandidateRevision } from "../generator/types.js";

/**
 * Validation verdict status for a candidate evolution revision.
 */
export type ValidationStatus = "pass" | "repairable_fail" | "terminal_fail" | "infrastructure_fail";

/**
 * Category of a static analysis finding.
 */
export type StaticFindingCategory =
  | "forbidden_import"
  | "forbidden_api"
  | "undeclared_capability"
  | "broker_manifest_mismatch"
  | "static_flaw"
  | "schema_mismatch"
  | "syntax_error";

/**
 * Detailed finding produced by AST and static code analysis.
 */
export interface StaticAnalysisFinding {
  severity: "error" | "warning";
  category: StaticFindingCategory;
  message: string;
  location?: {
    line: number;
    column: number;
  };
  fixHint?: string;
  nodeContext?: string;
}

/**
 * Granular code coverage metrics from sandbox test execution.
 */
export interface CoverageReport {
  statementCount: number;
  coveredStatements: number;
  statementCoveragePercent: number;
  branchCount: number;
  coveredBranches: number;
  branchCoveragePercent: number;
  functionCount: number;
  coveredFunctions: number;
  functionCoveragePercent: number;
  uncoveredLines?: number[];
}

/**
 * Test case category.
 */
export type TestType =
  | "schema_boundary"
  | "happy_path"
  | "edge_case"
  | "error_mode"
  | "idempotency"
  | "property"
  | "unit"
  | "custom";

/**
 * Deterministic broker fake configuration for a test case scenario.
 */
export interface MockBrokerScenario {
  fs?: {
    files?: Record<string, string>;
    readOnly?: boolean;
    simulateErrors?: Record<string, "ENOENT" | "EACCES">;
  };
  net?: {
    routes?: Record<
      string,
      {
        status: number;
        body: unknown;
        headers?: Record<string, string>;
      }
    >;
    simulateTimeout?: boolean;
    simulateNetworkError?: boolean;
  };
  cmd?: {
    commands?: Record<
      string,
      {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      }
    >;
    simulateFailure?: boolean;
  };
  secrets?: {
    values?: Record<string, string>;
    denyAccess?: boolean;
  };
}

/**
 * Synthesized test case definition.
 */
export interface SynthesizedTestCase {
  id: string;
  name: string;
  description: string;
  testType: TestType;
  input: Record<string, unknown>;
  expectedOutcome: "success" | "validation_error" | "execution_error";
  expectedErrorSubstring?: string;
  mockBrokerConfig?: MockBrokerScenario;
  timeoutMs?: number;
  isPropertyBased?: boolean;
  propertyVariations?: Array<Record<string, unknown>>;
}

/**
 * Synthesized test suite containing deterministic and LLM-assisted test cases.
 */
export interface SynthesizedTestSuite {
  suiteId: string;
  toolId: string;
  toolName: string;
  cases: SynthesizedTestCase[];
  synthesizedAt: string;
  llmAssisted: boolean;
}

/**
 * Individual test case execution result.
 */
export interface TestCaseResult {
  testId: string;
  name: string;
  testType: TestType;
  status: "pass" | "fail" | "timeout" | "error";
  durationMs: number;
  passed: boolean;
  input?: unknown;
  actualOutput?: unknown;
  error?: string;
  logs?: Array<{ level: string; message: string; timestamp?: string }>;
  assertionsPassed?: number;
  assertionsFailed?: number;
}

/**
 * Comprehensive test execution report for a synthesized test suite.
 */
export interface TestExecutionReport {
  suiteId: string;
  totalTests: number;
  passed: number;
  failed: number;
  timeouts: number;
  durationMs: number;
  results: TestCaseResult[];
  coverage?: CoverageReport;
}

/**
 * Actionable repair guidance formulated when validation results in `repairable_fail`.
 */
export interface StructuredRepairFeedback {
  canRepair: boolean;
  suggestedFixes: string[];
  findings: StaticAnalysisFinding[];
  failedTestSummaries: string[];
  recommendedChanges: {
    capabilities?: Partial<CapabilityManifest>;
    codePatches?: string[];
    schemaAdjustments?: Record<string, unknown>;
  };
}

/**
 * End-to-end result of candidate validation.
 */
export interface CandidateValidationResult {
  candidateId: string;
  revisionId?: string;
  status: ValidationStatus;
  passed: boolean;
  staticFindings: StaticAnalysisFinding[];
  typecheckPassed: boolean;
  typecheckErrors?: string[];
  testReport?: TestExecutionReport;
  coverage?: CoverageReport;
  repairFeedback?: StructuredRepairFeedback;
  validatedAt: string;
  durationMs: number;
}

/**
 * Options configuring candidate validation execution.
 */
export interface CandidateValidationOptions {
  skipLlmTestSynthesis?: boolean;
  coverageThresholdPercent?: number;
  timeoutMs?: number;
  maxExecutionTimeMs?: number;
  envelope?: CapabilityEnvelope;
  strictSecurity?: boolean;
}

/**
 * Flexible input parameter for CandidateValidationService.
 */
export type CandidateValidationTarget =
  | EvolutionCandidate
  | CandidateRevision
  | {
      id?: string;
      candidateId?: string;
      revisionId?: string;
      manifest: ToolManifest;
      sourceCode: string;
      requiredCapabilities?: CapabilityManifest;
      workflowDefinition?: Record<string, unknown>;
    };
