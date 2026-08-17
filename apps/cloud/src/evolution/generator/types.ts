import {
  CandidateTriggerReason,
  CapabilityEnvelope,
  CapabilityManifest,
  EvolutionCandidate,
  ToolManifest,
  ToolParameterSchema,
  ToolOutputSchema,
  ToolRuntimeRequirement,
} from "@tool-evolver/contracts";
import { z } from "zod";

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
  description?: string;
}

/**
 * Retry policy configuration for individual workflow steps.
 */
export interface StepRetryPolicy {
  maxRetries: number;
  backoffMs?: number;
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
  inputs: Record<string, unknown>;
  dependsOn: string[];
  outputVar?: string;
  compensation?: StepCompensation;
  retryPolicy?: StepRetryPolicy;
  condition?: string;
}

/**
 * High-level candidate plan derived from an opportunity.
 */
export interface ToolPlan {
  id: string;
  opportunityId: string;
  workspaceId: string;
  targetType: "single_tool" | "workflow";
  intent: string;
  name: string;
  description: string;
  variableInputs: VariableInputDefinition[];
  invariantInputs: InvariantInputDefinition[];
  inputSchema: ToolParameterSchema;
  outputSchema: ToolOutputSchema;
  steps: WorkflowStep[];
  capabilityRequirements: CapabilityManifest;
  runtime: ToolRuntimeRequirement;
  metadata: Record<string, unknown>;
  createdAt: string;
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
  | "imports"
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
  createdAt: string;
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
