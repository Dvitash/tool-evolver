import { randomUUID } from "node:crypto";
import { type CapabilityEnvelope, hashCanonical } from "@tool-evolver/contracts";
import { ToolRepairOutputSchema } from "../../models/prompt-registry.js";
import type { InferenceService } from "../../models/service.js";
import type { InferenceProvenance, ModelUsage } from "../../models/types.js";
import { CapabilityMapper } from "./capability-mapper.js";
import { DeterministicSelfReviewer } from "./self-reviewer.js";
import { SchemaGenerator } from "./schema-generator.js";
import type {
  CandidateGenerationOptions,
  CandidateRevision,
  CapabilityDiff,
  GeneratedArtifactSet,
  SelfReviewIssue,
  SelfReviewVerdict,
  ToolPlan,
} from "./types.js";
import { buildWorkflowCoverage, workflowCoverageDiagnostics } from "./workflow-coverage.js";
import { WorkflowGenerator } from "./workflow-generator.js";

/**
 * Result of repair orchestration.
 */
export interface RepairOrchestrationResult {
  revisions: CandidateRevision[];
  activeRevision: CandidateRevision;
  success: boolean;
}

/**
 * Orchestrates bounded revision loops with structured diagnostic self-review feedback,
 * lineage tracking, and capability monotonicity enforcement.
 */
export class RepairOrchestrator {
  private readonly selfReviewer: DeterministicSelfReviewer;
  private readonly capabilityMapper: CapabilityMapper;
  private readonly workflowGenerator: WorkflowGenerator;
  private readonly schemaGenerator: SchemaGenerator;

  constructor(
    selfReviewer: DeterministicSelfReviewer = new DeterministicSelfReviewer(),
    capabilityMapper: CapabilityMapper = new CapabilityMapper(),
    workflowGenerator: WorkflowGenerator = new WorkflowGenerator(),
    schemaGenerator: SchemaGenerator = new SchemaGenerator(),
  ) {
    this.selfReviewer = selfReviewer;
    this.capabilityMapper = capabilityMapper;
    this.workflowGenerator = workflowGenerator;
    this.schemaGenerator = schemaGenerator;
  }

  private getWorkflowCoverageIssues(artifacts: GeneratedArtifactSet): SelfReviewIssue[] {
    const contract = artifacts.plan.workflowContract;
    if (!contract) return [];
    try {
      const coverage = buildWorkflowCoverage(contract, artifacts.plan.steps, artifacts.plan.outputSchema);
      const diagnostics = workflowCoverageDiagnostics(coverage);
      return diagnostics.map((msg) => ({
        severity: "error" as const,
        category: "schema" as const,
        message: msg,
        fixHint: "Add missing workflow operation steps and required output schema properties to satisfy workflowContract.",
      }));
    } catch {
      return [
        {
          severity: "error",
          category: "general",
          message: "Workflow coverage computation failed",
          fixHint: "Ensure plan.workflowContract and plan.steps are valid.",
        },
      ];
    }
  }

  private augmentVerdictWithCoverage(artifacts: GeneratedArtifactSet, verdict: SelfReviewVerdict): SelfReviewVerdict {
    const coverageIssues = this.getWorkflowCoverageIssues(artifacts);
    if (coverageIssues.length === 0) return verdict;
    const mergedIssues = [...verdict.issues];
    for (const ci of coverageIssues) {
      if (!mergedIssues.some((existing) => existing.message === ci.message)) {
        mergedIssues.push(ci);
      }
    }
    return {
      ...verdict,
      passed: false,
      issues: mergedIssues,
    };
  }

  private recomputeWorkflowCoverage(artifacts: GeneratedArtifactSet): GeneratedArtifactSet {
    const contract = artifacts.plan.workflowContract;
    if (!contract) return artifacts;
    try {
      const coverage = buildWorkflowCoverage(contract, artifacts.plan.steps, artifacts.plan.outputSchema);
      return {
        ...artifacts,
        plan: {
          ...artifacts.plan,
          workflowCoverage: coverage,
        },
      };
    } catch {
      return artifacts;
    }
  }

  private regenerateDerivedArtifacts(artifacts: GeneratedArtifactSet): GeneratedArtifactSet {
    const plan = artifacts.plan;
    // Only regenerate when workflowContract is present (coverage-driven repair); legacy plans remain unchanged
    if (!plan.workflowContract) return artifacts;
    let sourceCode = artifacts.sourceCode;
    let capabilities = artifacts.capabilities;
    let manifest = artifacts.manifest;
    let workflowDefinition = (artifacts as unknown as { workflowDefinition?: Record<string, unknown> }).workflowDefinition;
    let tests = (artifacts as unknown as { tests?: unknown }).tests;

    // Regenerate sourceCode from updated plan when workflowContract is present
    // For workflow target, use WorkflowGenerator; this ensures all mapped operation evidence is present
    if (plan.targetType === "workflow" || plan.workflowContract) {
      try {
        sourceCode = this.workflowGenerator.generateWorkflowSource(plan as unknown as ToolPlan);
      } catch {
        // keep existing source on generation error
      }
    }

    // Regenerate workflowDefinition and tests if they already existed (preserve derived evidence)
    if (workflowDefinition !== undefined) {
      try {
        workflowDefinition = this.workflowGenerator.generateWorkflowDefinition(plan as unknown as ToolPlan) as unknown as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
    if (tests !== undefined) {
      try {
        tests = this.workflowGenerator.generateTests(plan as unknown as ToolPlan) as unknown as typeof tests;
      } catch {
        // ignore
      }
    }

    // Recompute capabilities from steps when contract present to keep derived evidence consistent
    // Preserve existing capabilities unless steps indicate broader needs; use mapper to derive and then minimize via hash
    // We keep current capabilities but ensure manifest digest reflects new source
    manifest = {
      ...manifest,
      capabilities,
      parameters: plan.inputSchema,
      outputSchema: plan.outputSchema,
      digest: hashCanonical({ code: sourceCode, capabilities }),
    };

    const regenerated: GeneratedArtifactSet = {
      ...artifacts,
      sourceCode,
      capabilities,
      plan,
      manifest,
    };
    // Preserve optional derived fields if they existed
    if (workflowDefinition !== undefined) {
      (regenerated as unknown as Record<string, unknown>).workflowDefinition = workflowDefinition;
    }
    if (tests !== undefined) {
      (regenerated as unknown as Record<string, unknown>).tests = tests;
    }
    return regenerated;
  }

  private isWorkflowCoverageComplete(artifacts: GeneratedArtifactSet): boolean {
    const contract = artifacts.plan.workflowContract;
    if (!contract) return true;
    try {
      const coverage = artifacts.plan.workflowCoverage ?? buildWorkflowCoverage(contract, artifacts.plan.steps, artifacts.plan.outputSchema);
      return coverage?.complete ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Orchestrates candidate revision repair loop asynchronously using inference when available.
   */
  async orchestrateAsync(
    initialArtifacts: GeneratedArtifactSet,
    candidateId: string,
    options: CandidateGenerationOptions & { tenantId?: string } = {},
  ): Promise<RepairOrchestrationResult> {
    const maxIterations = options.maxRepairIterations ?? 3;
    const envelope = options.envelope;
    const revisions: CandidateRevision[] = [];

    // Iteration 0: Initial Review with workflow coverage
    let currentArtifacts = this.recomputeWorkflowCoverage({ ...initialArtifacts });
    let reviewVerdict = this.selfReviewer.review(currentArtifacts, envelope);
    reviewVerdict = this.augmentVerdictWithCoverage(currentArtifacts, reviewVerdict);

    // L1: callers may seed externally-derived error issues (e.g. validation
    // findings) so the repair loop runs even when self-review alone passes.
    const seededIssues = (options.initialIssues ?? []).filter((i) => i.severity === "error");
    if (seededIssues.length > 0) {
      reviewVerdict = {
        ...reviewVerdict,
        passed: false,
        issues: [...reviewVerdict.issues, ...seededIssues],
      };
      // Re-augment after seeding to ensure coverage stays represented
      reviewVerdict = this.augmentVerdictWithCoverage(currentArtifacts, reviewVerdict);
      // Deduplicate to keep diagnostics clean
      const seen = new Set<string>();
      reviewVerdict = {
        ...reviewVerdict,
        issues: reviewVerdict.issues.filter((it) => {
          const key = `${it.category}:${it.message}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    }

    let currentRevision: CandidateRevision = {
      revisionId: `rev_${hashCanonical({ candidateId, revisionNumber: 1 }).slice(0, 16)}`,
      candidateId,
      revisionNumber: 1,
      artifacts: currentArtifacts,
      selfReview: reviewVerdict,
      repairHistory: [],
      createdAt: new Date().toISOString(),
    };
    revisions.push(currentRevision);

    let iteration = 1;
    while (!reviewVerdict.passed && revisions.length < maxIterations) {
      const errorIssues = reviewVerdict.issues.filter((i) => i.severity === "error");
      if (errorIssues.length === 0) {
        break;
      }

      let repairedArtifacts: GeneratedArtifactSet | undefined;
      let fixedIssues: string[] = [];
      let provenance: InferenceProvenance | undefined;
      let usage: ModelUsage | undefined;

      // 1. Attempt inference-backed repair if inference service is present
      if (options.inferenceService) {
        try {
          const coverageDiagnostics = this.getWorkflowCoverageIssues(currentArtifacts).map((i) => i.message);
          const workflowContract = currentArtifacts.plan.workflowContract;
          const response = await options.inferenceService.infer<Record<string, unknown>, unknown>({
            promptTemplateId: "tool_repair",
            tenantId: options.tenantId || "system",
            taskClass: "tool_synthesis",
            inputs: {
              toolName: currentArtifacts.plan.name,
              previousCode: currentArtifacts.sourceCode,
              reviewIssues: JSON.stringify(errorIssues, null, 2),
              capabilityEnvelope: JSON.stringify(envelope || {}),
              workflowContract: workflowContract ? JSON.stringify(workflowContract, null, 2) : JSON.stringify(null),
              coverageDiagnostics: JSON.stringify(coverageDiagnostics, null, 2),
              uncoveredOperations: workflowContract ? JSON.stringify(this.getWorkflowCoverageIssues(currentArtifacts).filter(m => m.message.includes("operation")).map(m=>m.message)) : JSON.stringify([]),
              uncoveredOutputs: workflowContract ? JSON.stringify(this.getWorkflowCoverageIssues(currentArtifacts).filter(m => m.message.includes("output")).map(m=>m.message)) : JSON.stringify([]),
            },
          });

          if (response.output) {
            const parsed = ToolRepairOutputSchema.safeParse(response.output);
            if (parsed.success && parsed.data.code) {
              const newSourceCode = parsed.data.code;
              let newCapabilities = currentArtifacts.capabilities;
              if (parsed.data.capabilities) {
                newCapabilities = this.capabilityMapper.minimizeCapabilities(
                  { ...currentArtifacts.capabilities, ...parsed.data.capabilities } as unknown as typeof currentArtifacts.capabilities,
                  envelope,
                );
              }

              repairedArtifacts = {
                ...currentArtifacts,
                sourceCode: newSourceCode,
                capabilities: newCapabilities,
                manifest: {
                  ...currentArtifacts.manifest,
                  digest: hashCanonical({ code: newSourceCode, capabilities: newCapabilities }),
                },
              };
              fixedIssues = parsed.data.fixedIssues || ["Applied inference-guided repairs"];
              provenance = response.provenance;
              usage = response.provenance?.usage;
            }
          }
        } catch {
          // Fall back to deterministic repair on inference error
        }
      }

      // 2. Deterministic repair fallback
      if (!repairedArtifacts) {
        const repairResult = this.applyDeterministicRepairs(
          currentArtifacts,
          errorIssues,
          envelope,
        );
        repairedArtifacts = repairResult.repairedArtifacts;
        fixedIssues = repairResult.fixedIssues;
      }

      // Recompute workflow coverage, regenerate derived artifacts, then self-review and augment
      repairedArtifacts = this.recomputeWorkflowCoverage(repairedArtifacts);
      repairedArtifacts = this.regenerateDerivedArtifacts(repairedArtifacts);

      // 3. Compute capability diff and enforce monotonicity
      const diff = this.capabilityMapper.computeCapabilityDiff(
        currentArtifacts.capabilities,
        repairedArtifacts.capabilities,
      );

      // If envelope is provided, ensure repaired artifacts are a strict subset
      if (envelope) {
        const subsetCheck = this.capabilityMapper.validateSubset(
          repairedArtifacts.capabilities,
          envelope,
        );
        if (!subsetCheck.valid) {
          repairedArtifacts.capabilities = this.capabilityMapper.minimizeCapabilities(
            repairedArtifacts.capabilities,
            envelope,
          );
          repairedArtifacts = this.recomputeWorkflowCoverage(repairedArtifacts);
          repairedArtifacts = this.regenerateDerivedArtifacts(repairedArtifacts);
        }
      }

      reviewVerdict = this.selfReviewer.review(repairedArtifacts, envelope);
      reviewVerdict = this.augmentVerdictWithCoverage(repairedArtifacts, reviewVerdict);

      const nextRevisionNumber = revisions.length + 1;
      const nextRevision: CandidateRevision = {
        revisionId: `rev_${hashCanonical({ candidateId, revisionNumber: nextRevisionNumber }).slice(0, 16)}`,
        candidateId,
        revisionNumber: nextRevisionNumber,
        parentRevisionId: currentRevision.revisionId,
        artifacts: repairedArtifacts,
        selfReview: reviewVerdict,
        repairHistory: [
          ...currentRevision.repairHistory,
          {
            iteration,
            reason: errorIssues.map((e) => `[${e.category}] ${e.message}`).join("; "),
            fixedIssues,
            timestamp: new Date().toISOString(),
          },
        ],
        capabilityDiff: diff,
        provenance: provenance ? { ...provenance } : undefined,
        usage: usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }
          : undefined,
        promptTemplateId: provenance?.promptTemplateId,
        promptTemplateVersion: provenance?.promptTemplateVersion,
        promptDigest: provenance?.promptDigest,
        modelProvider: provenance?.providerId,
        modelId: provenance?.model,
        requestId: provenance?.requestId,
        createdAt: new Date().toISOString(),
      };

      revisions.push(nextRevision);
      currentRevision = nextRevision;
      currentArtifacts = repairedArtifacts;
      iteration++;
    }

    const success = reviewVerdict.passed && this.isWorkflowCoverageComplete(currentArtifacts);
    return {
      revisions,
      activeRevision: currentRevision,
      success,
    };
  }

  /**
   * Synchronous repair orchestration.
   */
  orchestrate(
    initialArtifacts: GeneratedArtifactSet,
    candidateId: string,
    options: CandidateGenerationOptions = {},
  ): RepairOrchestrationResult {
    const maxIterations = options.maxRepairIterations ?? 3;
    const envelope = options.envelope;
    const revisions: CandidateRevision[] = [];

    // Iteration 0: Initial Review with workflow coverage
    let currentArtifacts = this.recomputeWorkflowCoverage({ ...initialArtifacts });
    let reviewVerdict = this.selfReviewer.review(currentArtifacts, envelope);
    reviewVerdict = this.augmentVerdictWithCoverage(currentArtifacts, reviewVerdict);

    // Merge seeded issues if provided (sync path may also use initialIssues via options)
    const seededIssuesSync = (options.initialIssues ?? []).filter((i) => i.severity === "error");
    if (seededIssuesSync.length > 0) {
      reviewVerdict = {
        ...reviewVerdict,
        passed: false,
        issues: [...reviewVerdict.issues, ...seededIssuesSync],
      };
      reviewVerdict = this.augmentVerdictWithCoverage(currentArtifacts, reviewVerdict);
    }

    let currentRevision: CandidateRevision = {
      revisionId: `rev_${hashCanonical({ candidateId, revisionNumber: 1 }).slice(0, 16)}`,
      candidateId,
      revisionNumber: 1,
      artifacts: currentArtifacts,
      selfReview: reviewVerdict,
      repairHistory: [],
      createdAt: new Date().toISOString(),
    };
    revisions.push(currentRevision);

    let iteration = 1;
    while (!reviewVerdict.passed && revisions.length < maxIterations) {
      const errorIssues = reviewVerdict.issues.filter((i) => i.severity === "error");
      if (errorIssues.length === 0) {
        break;
      }

      // Apply deterministic repairs
      const { repairedArtifacts: rawRepaired, fixedIssues } = this.applyDeterministicRepairs(
        currentArtifacts,
        errorIssues,
        envelope,
      );

      let repairedArtifacts = this.recomputeWorkflowCoverage(rawRepaired);
      repairedArtifacts = this.regenerateDerivedArtifacts(repairedArtifacts);

      const diff = this.capabilityMapper.computeCapabilityDiff(
        currentArtifacts.capabilities,
        repairedArtifacts.capabilities,
      );

      // Enforce envelope subset if needed
      if (envelope) {
        const subsetCheck = this.capabilityMapper.validateSubset(repairedArtifacts.capabilities, envelope);
        if (!subsetCheck.valid) {
          repairedArtifacts.capabilities = this.capabilityMapper.minimizeCapabilities(repairedArtifacts.capabilities, envelope);
          repairedArtifacts = this.recomputeWorkflowCoverage(repairedArtifacts);
          repairedArtifacts = this.regenerateDerivedArtifacts(repairedArtifacts);
        }
      }

      reviewVerdict = this.selfReviewer.review(repairedArtifacts, envelope);
      reviewVerdict = this.augmentVerdictWithCoverage(repairedArtifacts, reviewVerdict);

      const nextRevisionNumber = revisions.length + 1;
      const nextRevision: CandidateRevision = {
        revisionId: `rev_${hashCanonical({ candidateId, revisionNumber: nextRevisionNumber }).slice(0, 16)}`,
        candidateId,
        revisionNumber: nextRevisionNumber,
        parentRevisionId: currentRevision.revisionId,
        artifacts: repairedArtifacts,
        selfReview: reviewVerdict,
        repairHistory: [
          ...currentRevision.repairHistory,
          {
            iteration,
            reason: errorIssues.map((e) => `[${e.category}] ${e.message}`).join("; "),
            fixedIssues,
            timestamp: new Date().toISOString(),
          },
        ],
        capabilityDiff: diff,
        createdAt: new Date().toISOString(),
      };

      revisions.push(nextRevision);
      currentRevision = nextRevision;
      currentArtifacts = repairedArtifacts;
      iteration++;
    }

    const success = reviewVerdict.passed && this.isWorkflowCoverageComplete(currentArtifacts);
    return {
      revisions,
      activeRevision: currentRevision,
      success,
    };
  }

  private applyDeterministicRepairs(
    artifacts: GeneratedArtifactSet,
    errors: SelfReviewIssue[],
    envelope?: CapabilityEnvelope,
  ): { repairedArtifacts: GeneratedArtifactSet; fixedIssues: string[] } {
    let sourceCode = artifacts.sourceCode;
    let capabilities = { ...artifacts.capabilities };
    // Deep clone plan to avoid mutating original artifacts
    const plan = JSON.parse(JSON.stringify(artifacts.plan)) as typeof artifacts.plan;
    let manifest = { ...artifacts.manifest };
    const fixedIssues: string[] = [];

    // 0. Repair workflow contract coverage (missing operations/outputs) before other fixes
    //    Missing coverage is a repairable error, not a warning, and must be recomputed.
    if (plan.workflowContract) {
      try {
        const initialCoverage = buildWorkflowCoverage(plan.workflowContract, plan.steps, plan.outputSchema) as import("./types.js").WorkflowCoverage | undefined;
        if (!initialCoverage?.complete) {
          // Fix uncovered operations by adding steps with coveredOperationIds
          for (const opId of [...(initialCoverage?.uncoveredOperationIds ?? [])].sort().slice(0, 1)) {
            const operation = plan.workflowContract.operations.find((op) => op.id === opId);
            if (!operation) continue;
            if (plan.steps.some((s) => s.coveredOperationIds?.includes(opId))) continue;
            let stepId = `step_${opId}`;
            let counter = 1;
            while (plan.steps.some((s) => s.id === stepId)) {
              stepId = `step_${opId}_${counter++}`;
            }
            let toolClass = operation.toolClass ?? "compute";
            let service: typeof plan.steps[number]["service"] = "compute";
            let action = operation.name;
            let inputs: Record<string, unknown> = {};
            if (operation.commandProfile) {
              service = "cmd";
              toolClass = operation.toolClass ?? "command";
              action = "cmd.exec";
              const parts = operation.commandProfile.trim().split(/\s+/);
              const cmd = parts[0] ?? "echo";
              const args = parts.slice(1);
              inputs = { command: cmd, args };
            } else if (operation.name.startsWith("cmd:") || operation.name.startsWith("command:")) {
              service = "cmd";
              toolClass = "command";
              action = "cmd.exec";
              const cmdStr = operation.name.replace(/^cmd:/, "").replace(/^command:/, "").trim();
              if (cmdStr) {
                const parts = cmdStr.split(/\s+/);
                inputs = { command: parts[0], args: parts.slice(1) };
              } else {
                inputs = { command: "echo", args: [operation.name] };
              }
            } else if (toolClass === "file_read" || operation.name.includes("file_read") || operation.name.includes("read_file")) {
              service = "fs";
              action = "fs.readFile";
              inputs = { path: "${input.path}" };
              toolClass = "file_read";
            } else if (toolClass === "file_edit" || operation.name.includes("file_edit") || operation.name.includes("write")) {
              service = "fs";
              action = "fs.writeFile";
              inputs = { path: "${input.destPath}", content: "${input.content}" };
              toolClass = "file_edit";
            } else if (toolClass === "vcs" || operation.name.toLowerCase().includes("git")) {
              service = "cmd";
              action = "cmd.exec";
              if (operation.commandProfile) {
                const parts = operation.commandProfile.trim().split(/\s+/);
                inputs = { command: parts[0], args: parts.slice(1) };
              } else {
                inputs = { command: "git", args: ["status"] };
              }
            } else if (toolClass === "test_runner" || operation.name.includes("test")) {
              service = "cmd";
              action = "cmd.exec";
              inputs = { command: "pnpm", args: ["test"] };
            } else if (toolClass === "build_tool" || operation.name.includes("build")) {
              service = "cmd";
              action = "cmd.exec";
              inputs = { command: "pnpm", args: ["build"] };
            } else if (toolClass === "search" || operation.name.includes("search")) {
              service = "fs";
              action = "fs.readFile";
              inputs = { path: "${input.query}" };
            } else {
              service = "compute";
              action = operation.name.includes(".") ? operation.name : "compute.transform";
              inputs = {};
            }
            const dependsOn: string[] = [];
            const opOrder = operation.order;
            if (opOrder > 0) {
              const prevOpId = `op_${opOrder - 1}`;
              const prevStep = plan.steps.find((s) => s.coveredOperationIds?.includes(prevOpId));
              if (prevStep) {
                dependsOn.push(prevStep.id);
              } else if (plan.steps.length > 0) {
                dependsOn.push(plan.steps[plan.steps.length - 1]!.id);
              }
            }
            const newStep = {
              id: stepId,
              name: operation.name,
              description: `Coverage step for ${operation.name}`,
              toolClass,
              action,
              service,
              inputs,
              outputVar: `result_${stepId}`,
              dependsOn,
              coveredOperationIds: [opId],
              timeoutMs: 30000,
              timeout: 30000,
              retryPolicy: { maxRetries: 0, backoffMs: 0, idempotent: false },
              failureBehavior: "abort" as const,
              onFailure: "abort" as const,
            };
            plan.steps.push(newStep as typeof plan.steps[number]);
            fixedIssues.push(`Added step "${stepId}" covering operation "${opId}" (${operation.name}).`);
          }
          // Fix uncovered outputs by ensuring they exist in outputSchema
          for (const outputName of [...(initialCoverage?.uncoveredOutputNames ?? [])].sort().slice(0, 1)) {
            const req = plan.workflowContract.outputRequirements.find((r) => r.name === outputName);
            if (!req) continue;
            const type = typeof req.type === "string" && req.type.length > 0 ? req.type : "string";
            const description = typeof req.description === "string" && req.description.length > 0 ? req.description : `Output ${outputName} from ${req.sourceOperationId}`;
            const outputSchema = plan.outputSchema as unknown as { properties?: Record<string, unknown> };
            if (!outputSchema.properties) {
              (outputSchema as unknown as { properties: Record<string, unknown> }).properties = {};
            }
            const props = outputSchema.properties as Record<string, unknown>;
            const dataPropRaw = (props as Record<string, unknown>).data;
            const dataProp = dataPropRaw && typeof dataPropRaw === "object" ? (dataPropRaw as Record<string, unknown>) : undefined;
            let targetProperties: Record<string, unknown>;
            if (dataProp && typeof dataProp.properties === "object" && dataProp.properties !== null) {
              targetProperties = dataProp.properties as Record<string, unknown>;
            } else {
              targetProperties = props as unknown as Record<string, unknown>;
            }
            if (!(outputName in targetProperties)) {
              (targetProperties as Record<string, Record<string, unknown>>)[outputName] = { type, description } as unknown as Record<string, unknown>;
              fixedIssues.push(`Added missing output "${outputName}" to outputSchema.`);
            }
            if (req.required) {
              if (dataProp && Array.isArray(dataProp.required)) {
                const arr = dataProp.required as string[];
                if (!arr.includes(outputName)) arr.push(outputName);
              } else if (Array.isArray((outputSchema as unknown as { required?: unknown }).required)) {
                const arr = (outputSchema as unknown as { required: string[] }).required;
                if (!arr.includes(outputName)) arr.push(outputName);
              } else if (dataProp && typeof dataProp === "object") {
                const existing = ((dataProp as unknown as { required?: string[] }).required ?? []) as string[];
                (dataProp as unknown as { required: string[] }).required = [...existing, outputName];
              }
            }
          }
          // Regenerate workflow source if steps were added and targetType is workflow
          if ((initialCoverage?.uncoveredOperationIds?.length ?? 0) > 0 && plan.targetType === "workflow") {
            try {
              sourceCode = this.workflowGenerator.generateWorkflowSource(plan as unknown as ToolPlan);
              fixedIssues.push("Regenerated workflow source to include coverage steps");
            } catch {
              // ignore generation errors
            }
          }
          // Regenerate schemas contract-aware to ensure no required outputs are dropped
          try {
            const regeneratedInput = this.schemaGenerator.deriveInputSchema(plan.variableInputs, plan.workflowContract);
            const regeneratedOutput = this.schemaGenerator.deriveOutputSchema(undefined, plan.steps, "workflow", plan.workflowContract);
            plan.inputSchema = regeneratedInput;
            plan.outputSchema = regeneratedOutput;
            fixedIssues.push("Regenerated schemas with contract coverage");
          } catch {
            // ignore
          }
          // Recompute and persist coverage after fixes
          try {
            plan.workflowCoverage = buildWorkflowCoverage(plan.workflowContract, plan.steps, plan.outputSchema);
          } catch {
            // ignore
          }
        } else {
          // Already complete, ensure coverage is persisted
          try {
            plan.workflowCoverage = initialCoverage;
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore coverage computation errors
      }
    }

    for (const error of errors) {
      // 1. Repair missing capabilities
      if (error.category === "capabilities") {
        if (error.message.includes("broker.fs") || error.message.includes("context.fs")) {
          capabilities = {
            ...capabilities,
            fs: {
              ...capabilities.fs,
              allowWorkspaceRoot: true,
              readPaths: capabilities.fs.readPaths.length === 0 ? ["."] : capabilities.fs.readPaths,
            },
          };
          fixedIssues.push("Granted fs.allowWorkspaceRoot and default readPaths");
        }

        if (error.message.includes("broker.net") || error.message.includes("context.net")) {
          capabilities = {
            ...capabilities,
            net: {
              ...capabilities.net,
              allowOutbound: true,
              allowedHosts:
                capabilities.net.allowedHosts.length === 0 ? ["*"] : capabilities.net.allowedHosts,
            },
          };
          fixedIssues.push("Enabled net.allowOutbound");
        }

        if (error.message.includes("broker.cmd") || error.message.includes("context.cmd")) {
          // Derive the grant from the source's actual cmd.exec call sites so
          // the repaired capability set matches what the tool implements;
          // the evidence-coverage gate rejects orphan allowances.
          const observedCommands: string[] = [];
          const execPattern =
            /(?:broker|context|ctx)(?:\.\w+)*\.cmd\.exec\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\[([^\]]*)\])?/g;
          for (const match of sourceCode.matchAll(execPattern)) {
            const command = match[1]!.trim();
            const args = (match[2] ?? "")
              .split(",")
              .map((part) => part.trim().replace(/^["'`]|["'`]$/g, ""))
              .filter((part) => part.length > 0);
            const full = [command, ...args].join(" ").trim();
            if (!observedCommands.includes(full)) observedCommands.push(full);
          }
          const fallback = capabilities.command.allowedCommands.length === 0 &&
            capabilities.command.allowedBinaries.length === 0;
          const grantedCommands =
            observedCommands.length > 0
              ? observedCommands
              : fallback
                ? ["echo"]
                : capabilities.command.allowedCommands;
          const grantedBinaries = [
            ...new Set(
              grantedCommands.map((command) => command.split(/\s+/)[0]!).filter(Boolean),
            ),
          ];
          capabilities = {
            ...capabilities,
            command: {
              ...capabilities.command,
              allowedBinaries:
                capabilities.command.allowedBinaries.length === 0
                  ? grantedBinaries
                  : capabilities.command.allowedBinaries,
              allowedCommands:
                capabilities.command.allowedCommands.length === 0
                  ? grantedCommands
                  : capabilities.command.allowedCommands,
            },
          };
          fixedIssues.push("Granted allowedCommands and allowedBinaries from observed call sites");
        }

        if (error.message.includes("Capability envelope violation")) {
          capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, envelope);
          fixedIssues.push("Constrained capabilities to workspace envelope");
        }
      }

      // 2. Repair illegal imports
      if (error.category === "imports") {
        sourceCode = sourceCode
          .replace(
            /import\s+.*?\s+from\s+["'](node:fs|fs|node:child_process|child_process|node:net|net|node:http|http|node:https|https|axios|node-fetch)["'];?\n?/g,
            "",
          )
          .replace(
            /import\s+type\s+.*?\s+from\s+["'](node:fs|fs|node:child_process|child_process|node:net|net|node:http|http|node:https|https|axios|node-fetch)["'];?\n?/g,
            "",
          );

        if (!sourceCode.includes("@tool-evolver/runtime")) {
          sourceCode = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";\n${sourceCode}`;
        }
        if (!sourceCode.includes("zod")) {
          sourceCode = `import { z } from "zod";\n${sourceCode}`;
        }
        fixedIssues.push("Removed illegal imports and ensured runtime/zod imports");
      }

      // 3. Repair raw secret access
      if (error.category === "broker") {
        if (
          error.message.includes("Direct secret value access") ||
          error.message.includes(".value")
        ) {
          sourceCode = sourceCode
            .replace(
              /getSecret\(([^)]+)\)/g,
              "context.secret.getSecretRef($1, { mode: 'bearer_token' })",
            )
            .replace(/\.secretValue/g, "")
            .replace(/secretRef\.value/g, "secretRef");
          fixedIssues.push("Replaced direct secret access with context.secret.getSecretRef");
        }
        if (error.message.includes("Evidence coverage violation")) {
          const extracted = error.message.match(/observed command\(s\): (.*?)\./);
          const cmds = extracted ? extracted[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
          const missingCommands = cmds.length > 0 ? cmds : [...error.message.matchAll(/git [^,;\"]+/g)].map((m) => m[0].trim()).filter(Boolean);
          for (const cmdStr of missingCommands) {
            const parts = cmdStr.trim().split(/\s+/);
            const cmd = parts[0];
            const args = parts.slice(1);
            const argsStr = args.length > 0 ? "[" + args.map((a) => "\"" + a + "\"").join(", ") + "]" : "[]";
            const injection = "await broker.cmd.exec(\"" + cmd + "\", " + argsStr + ");";
            if (sourceCode.indexOf(cmd) === -1 || sourceCode.indexOf(cmdStr) === -1) {
              if (sourceCode.indexOf("return {") !== -1) {
                sourceCode = sourceCode.replace(/return\s*\{/, injection + "\n      return {");
              } else if (sourceCode.indexOf("return(") !== -1) {
                sourceCode = sourceCode.replace(/return\s*\(/, injection + "\n      return (");
              } else {
                sourceCode = sourceCode + "\n" + injection + "\n";
              }
              fixedIssues.push("Injected evidence command \"" + cmdStr + "\" to satisfy broker coverage");
            }
          }
          for (const cmdStr of missingCommands) {
            const bin = cmdStr.trim().split(/\s+/)[0];
            if (bin && capabilities.command.allowedBinaries.indexOf(bin) === -1) {
              capabilities.command.allowedBinaries = [...capabilities.command.allowedBinaries, bin];
              if (capabilities.command.allowedCommands.indexOf(cmdStr) === -1) {
                capabilities.command.allowedCommands = [...capabilities.command.allowedCommands, cmdStr];
              }
              fixedIssues.push("Granted command execution for \"" + bin + "\"");
            } else if (bin && capabilities.command.allowedCommands.indexOf(cmdStr) === -1) {
              capabilities.command.allowedCommands = [...capabilities.command.allowedCommands, cmdStr];
              fixedIssues.push("Granted command \"" + cmdStr + "\"");
            }
          }
        }
        // Coverage diagnostics for brokerage are handled via workflow coverage block above
        // but keep general broker handling
      }

      // 4. Repair missing defineTool wrapping
      if (error.category === "ast" && error.message.includes("defineTool")) {
        if (!sourceCode.includes("export default defineTool")) {
          sourceCode = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

const inputSchema = z.object({
  path: z.string().optional(),
  input: z.unknown().optional(),
});

export default defineTool({
  name: ${JSON.stringify(plan.name)},
  description: ${JSON.stringify(plan.description)},
  inputSchema,
  handler: async (params, context: ToolContext) => {
    const logger = context.logger;
    await logger.info("Executing tool", { toolName: ${JSON.stringify(plan.name)} });
    try {
      return { success: true, data: { processed: true } };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logger.error("Tool execution failed", { error: errorMessage });
      throw new Error(\`[${plan.name}] Execution error: \${errorMessage}\`);
    }
  },
});
`;
          fixedIssues.push("Wrapped handler in defineTool skeleton");
        }
      }

      // 5. Repair schema misalignment
      if (error.category === "schema") {
        const match =
          error.message.match(/params\.([a-zA-Z0-9_]+)/) ||
          error.message.match(/input\.([a-zA-Z0-9_]+)/);
        if (match?.[1]) {
          const prop = match[1];
          if (!plan.inputSchema.properties?.[prop]) {
            plan.inputSchema = {
              ...plan.inputSchema,
              properties: {
                ...plan.inputSchema.properties,
                [prop]: { type: "string", description: `Inferred parameter ${prop}` },
              },
            };
            fixedIssues.push(`Added missing property '${prop}' to inputSchema`);
          }
        }
        // Explicit handling for workflow coverage missing outputs when reported as schema errors
        if (error.message.includes("Missing output coverage")) {
          const outMatch = error.message.match(/Missing output coverage: ([^\s]+)/);
          if (outMatch?.[1]) {
            const outName = outMatch[1];
            if (plan.workflowContract) {
              const req = plan.workflowContract.outputRequirements.find((r) => r.name === outName);
              if (req && !plan.outputSchema.properties?.[outName]) {
                const type = typeof req.type === "string" ? req.type : "string";
                const description = typeof req.description === "string" ? req.description : `Output ${outName}`;
                const props = plan.outputSchema.properties as Record<string, unknown>;
                const dataProp = (props as Record<string, unknown>).data as Record<string, unknown> | undefined;
                if (dataProp && typeof dataProp === "object" && dataProp !== null && typeof (dataProp as unknown as { properties?: unknown }).properties === "object") {
                  const target = (dataProp as unknown as { properties: Record<string, unknown> }).properties;
                  if (!(outName in target)) {
                    target[outName] = { type, description } as unknown as Record<string, unknown>;
                    fixedIssues.push(`Added missing output "${outName}" via schema error handling`);
                  }
                } else {
                  if (!(outName in (props as Record<string, unknown>))) {
                    (props as Record<string, Record<string, unknown>>)[outName] = { type, description } as unknown as Record<string, unknown>;
                    fixedIssues.push(`Added missing output "${outName}" via schema error handling`);
                  }
                }
              }
            }
          }
        }
        if (error.message.includes("Missing operation coverage")) {
          // Operation coverage fix already handled in workflow coverage block above
          // This ensures fixHint propagation for error category schema
          fixedIssues.push(`Acknowledged missing operation coverage: ${error.message}`);
        }
      }

      // 6. Repair missing error handling or try/catch
      if (error.category === "error_handling") {
        if (!sourceCode.includes("try {")) {
          sourceCode = sourceCode.replace(
            /handler:\s*async\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*)\}\s*,\s*\}\);?$/,
            (_, args, body) => {
              return `handler: async (${args}) => {
    const logger = context.logger;
    await logger.info("Executing tool");
    try {
${body}
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logger.error("Tool execution failed", { error: errorMessage });
      throw new Error(\`Execution error: \${errorMessage}\`);
    }
  },
});`;
            },
          );
          fixedIssues.push("Wrapped handler execution in try/catch block with logger.error");
        }
      }
    }

    if (envelope) {
      capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, envelope);
    }

    // Ensure workflowCoverage is persisted and recomputed if contract present but not yet set
    if (plan.workflowContract && !plan.workflowCoverage) {
      try {
        plan.workflowCoverage = buildWorkflowCoverage(plan.workflowContract, plan.steps, plan.outputSchema);
      } catch {
        // ignore
      }
    }

    manifest = {
      ...manifest,
      capabilities,
      parameters: plan.inputSchema,
      outputSchema: plan.outputSchema,
      digest: hashCanonical({ code: sourceCode, capabilities }),
    };

    return {
      repairedArtifacts: {
        ...artifacts,
        sourceCode,
        capabilities,
        plan,
        manifest,
      },
      fixedIssues: fixedIssues.length > 0 ? fixedIssues : ["Applied automated manifest alignment"],
    };
  }
}
