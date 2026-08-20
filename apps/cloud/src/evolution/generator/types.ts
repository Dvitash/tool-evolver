import type { WorkflowContract } from "../opportunity/types.js";
import {
  CandidateTriggerReason,
  type CapabilityEnvelope,
  type CapabilityManifest,
  type EvolutionCandidate,
  type ToolManifest,
  type ToolOutputSchema,
  type ToolParameterSchema,
  type ToolRuntimeRequirement,
} from "@tool-evolver/contracts";
import { z } from "zod";
import type { InferenceService } from "../../models/service.js";

/**
 * Variable input definition derived from observed variable parameters.
 */
export interface VariableInputDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required: boolean;
  defaultValue?: unknown;
  examples?: unknown[];
}

/**
 * Invariant input definition for fixed/constant parameters.
 */
export interface InvariantInputDefinition {
  name: string;
  value: unknown;
  description?: string;
}

/**
 * Compensation action to rollback or clean up step execution on failure.
 */
export interface StepCompensation {
  action: string;
  inputs: Record<string, unknown>;
  service?: "fs" | "net" | "cmd" | "secret" | "compute" | string;
  description?: string;
  deterministicInverse?: boolean;
}

/**
 * Retry policy configuration for individual workflow steps.
 */
export interface StepRetryPolicy {
  maxRetries: number;
  backoffMs?: number;
  idempotent?: boolean;
}

/**
 * Individual step within a workflow step graph.
 */
export interface WorkflowStep {
  id: string;
  name: string;
  description?: string;
  toolClass: string;
  action: string;
  service?: "fs" | "net" | "cmd" | "secret" | "compute";
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown> | string[];
  outputVar?: string;
  dependsOn: string[];
  capabilities?: CapabilityManifest;
  capabilityRequirements?: CapabilityManifest;
  timeout?: number;
  timeoutMs?: number;
  compensation?: StepCompensation;
  retryPolicy?: StepRetryPolicy;
  failureBehavior?: "abort" | "continue" | "compensate" | "fail";
  onFailure?: "abort" | "continue" | "compensate" | "fail";
  condition?: string;
  coveredOperationIds?: string[];
}
/**
 * Single runtime requirement item.
 */
export interface ToolRuntimeRequirementItem {
  type: string;
  name: string;
  specifier: string;
  required: boolean;
  reason: string;
}

/**
 * High-level candidate plan derived from an opportunity.
 */
export interface ToolPlan {
  id: string;
  planId?: string;
  opportunityId: string;
  workspaceId?: string;
  name: string;
  version?: string;
  description: string;
  targetType?: "pure_compute" | "brokered_tool" | "workflow" | string;
  action?: "create" | "modify" | "deprecate";
  intent?: string;
  workflowPattern?: string;
  variableInputs: VariableInputDefinition[];
  invariantInputs: InvariantInputDefinition[];
  inputSchema: ToolParameterSchema;
  outputSchema: ToolOutputSchema;
  steps: WorkflowStep[];
  capabilities: CapabilityManifest;
  capabilityRequirements: CapabilityManifest;
  runtime: ToolRuntimeRequirement;
  runtimeRequirements?: ToolRuntimeRequirementItem[];
  compensationPolicy?: {
    enabled: boolean;
    autoRollback: boolean;
  };
  workflowContract?: WorkflowContract;
  workflowCoverage?: WorkflowCoverage;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Deterministic coverage of a WorkflowContract by a ToolPlan.
 * Complete only when every contract operation and required output is represented.
 */
export interface WorkflowCoverage {
  operationCoverage: { operationId: string; stepIds: string[] }[];
  outputCoverage: { outputName: string; schemaPaths: string[]; sourceOperationIds: string[] }[];
  uncoveredOperationIds: string[];
  uncoveredOutputNames: string[];
  complete: boolean;
}


/**
 * Workflow validation output.
 */
export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Workflow repair output.
 */
export interface WorkflowRepairResult {
  plan: ToolPlan;
  repaired: boolean;
  iterations: number;
  appliedFixes: string[];
  remainingErrors?: string[];
}

/**
 * Generated test case for a synthesized tool.
 */
export interface GeneratedTestCase {
  name: string;
  description: string;
  code: string;
  testType: "unit" | "property" | "integration";
}

/**
 * Complete set of generated code and manifest artifacts for a candidate.
 */
export interface GeneratedArtifactSet {
  plan: ToolPlan;
  manifest: ToolManifest;
  capabilities: CapabilityManifest;
  sourceCode: string;
  workflowDefinition?: Record<string, unknown>;
  tests?: GeneratedTestCase[];
  generatedAt: string;
}

/**
 * Issue categories evaluated during self-review.
 */
export type SelfReviewCategory =
  | "ast"
  | "syntax"
  | "imports"
  | "broker"
  | "capabilities"
  | "schema"
  | "error_handling"
  | "cancellation"
  | "general";

/**
 * Issue detected during candidate self-review.
 */
export interface SelfReviewIssue {
  severity: "error" | "warning";
  category: SelfReviewCategory;
  message: string;
  fixHint?: string;
  nodeContext?: string;
}

/**
 * Verdict resulting from deterministic candidate self-review.
 */
export interface SelfReviewVerdict {
  passed: boolean;
  issues: SelfReviewIssue[];
  reviewedAt: string;
}

/**
 * Structural capability difference between revisions.
 */
export interface CapabilityDiff {
  hasChanges: boolean;
  isBroadening: boolean;
  fs: {
    addedReadPaths: string[];
    removedReadPaths: string[];
    addedWritePaths: string[];
    removedWritePaths: string[];
    workspaceRootChanged?: boolean;
    tempChanged?: boolean;
  };
  net: {
    addedHosts: string[];
    removedHosts: string[];
    addedUrls: string[];
    removedUrls: string[];
    addedMethods: string[];
    removedMethods: string[];
    outboundChanged?: boolean;
  };
  command: {
    addedCommands: string[];
    removedCommands: string[];
    shellChanged?: boolean;
  };
  secrets: {
    addedSecrets: string[];
    removedSecrets: string[];
    addedModes: string[];
    removedModes: string[];
  };
  summary: string[];
}

/**
 * Immutable candidate revision recording an iteration in the repair/evolution lineage.
 */
export interface CandidateRevision {
  revisionId: string;
  candidateId: string;
  revisionNumber: number;
  parentRevisionId?: string;
  artifacts: GeneratedArtifactSet;
  selfReview: SelfReviewVerdict;
  repairHistory: Array<{
    iteration: number;
    reason: string;
    fixedIssues: string[];
    timestamp: string;
  }>;
  capabilityDiff?: CapabilityDiff;
  storageUri?: string;
  provenance?: Record<string, unknown>;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  cost?: { promptCostUsd?: number; completionCostUsd?: number; totalCostUsd?: number };
  promptTemplateId?: string;
  promptTemplateVersion?: string;
  promptDigest?: string;
  modelProvider?: string;
  modelId?: string;
  requestId?: string;
  createdAt: string;
}

/**
 * Options for candidate planning.
 */
export interface CandidatePlanningOptions {
  envelope?: CapabilityEnvelope;
  targetType?: "single_tool" | "workflow";
  forceWorkflow?: boolean;
  version?: string;
  tenantId?: string;
  inferenceService?: InferenceService;
}

/**
 * Generation and repair options.
 */
export interface CandidateGenerationOptions {
  maxRepairIterations?: number;
  envelope?: CapabilityEnvelope;
  targetType?: "single_tool" | "workflow";
  version?: string;
  strictReview?: boolean;
  inferenceService?: InferenceService;
  /** External error-severity issues (e.g. validation findings) seeding the repair loop. */
  initialIssues?: SelfReviewIssue[];
}

/**
 * Result of candidate planning and generation.
 */
export interface GenerationResult {
  candidate: EvolutionCandidate;
  revisions: CandidateRevision[];
  activeRevision: CandidateRevision;
  status: "synthesized" | "failed" | "needs_repair";
  iterations: number;
  errors?: string[];
}
