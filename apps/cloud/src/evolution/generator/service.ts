import { randomUUID } from "node:crypto";
import {
  type CandidateState,
  type EvolutionCandidate,
  EvolutionCandidateSchema,
  type ToolManifest,
  hashCanonical,
} from "@tool-evolver/contracts";
import type { TenantContext } from "../../tenant.js";
import type { OpportunityDetection } from "../opportunity/types.js";
import { CapabilityMapper } from "./capability-mapper.js";
import { CodeGenerator } from "./code-generator.js";
import { CandidatePlanner } from "./planner.js";
import { RepairOrchestrator } from "./repair-orchestrator.js";
import { SchemaGenerator } from "./schema-generator.js";
import { DeterministicSelfReviewer } from "./self-reviewer.js";
import type {
  CandidateGenerationOptions,
  CandidateRevision,
  GeneratedArtifactSet,
  GenerationResult,
} from "./types.js";
import { WorkflowGenerator } from "./workflow-generator.js";

export interface CandidateGenerationServiceOptions {
  planner?: CandidatePlanner;
  codeGenerator?: CodeGenerator;
  selfReviewer?: DeterministicSelfReviewer;
  repairOrchestrator?: RepairOrchestrator;
  capabilityMapper?: CapabilityMapper;
  schemaGenerator?: SchemaGenerator;
  workflowGenerator?: WorkflowGenerator;
}

/**
 * Service managing candidate planning, code generation, self-review, repair lineage, and storage.
 */
export class CandidateGenerationService {
  private readonly planner: CandidatePlanner;
  private readonly codeGenerator: CodeGenerator;
  private readonly selfReviewer: DeterministicSelfReviewer;
  private readonly repairOrchestrator: RepairOrchestrator;
  private readonly schemaGenerator: SchemaGenerator;
  private readonly capabilityMapper: CapabilityMapper;
  private readonly workflowGenerator: WorkflowGenerator;

  private readonly candidateStore: Map<
    string,
    { candidate: EvolutionCandidate; tenant: TenantContext }
  > = new Map();
  private readonly revisionStore: Map<string, CandidateRevision[]> = new Map();

  constructor(options: CandidateGenerationServiceOptions = {}) {
    this.schemaGenerator = options.schemaGenerator ?? new SchemaGenerator();
    this.capabilityMapper = options.capabilityMapper ?? new CapabilityMapper();
    this.workflowGenerator =
      options.workflowGenerator ?? new WorkflowGenerator(this.schemaGenerator);
    this.planner =
      options.planner ?? new CandidatePlanner(this.schemaGenerator, this.capabilityMapper);
    this.codeGenerator =
      options.codeGenerator ?? new CodeGenerator(this.schemaGenerator, this.workflowGenerator);
    this.selfReviewer = options.selfReviewer ?? new DeterministicSelfReviewer();
    this.repairOrchestrator =
      options.repairOrchestrator ?? new RepairOrchestrator(this.selfReviewer);
  }

  /**
   * Generates a new evolution candidate from an OpportunityDetection entity.
   */
  async generateCandidate(
    tenant: TenantContext,
    opportunity: OpportunityDetection,
    options: CandidateGenerationOptions = {},
  ): Promise<GenerationResult> {
    const candidateId = `cand-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const version = options.version ?? "1.0.0";

    // 1. Plan candidate
    const plan = this.planner.plan(opportunity, {
      envelope: options.envelope,
      targetType: options.targetType,
    });

    // 2. Generate TypeScript source
    const sourceCode = this.codeGenerator.generateSource(plan);

    // 3. Construct ToolManifest
    const manifestDraft: Omit<ToolManifest, "digest"> = {
      id: `tool-${randomUUID()}`,
      name: plan.name,
      version,
      description: plan.description,
      parameters: plan.inputSchema,
      outputSchema: plan.outputSchema,
      runtime: plan.runtime,
      capabilities: plan.capabilityRequirements,
      limits: {
        timeoutMs: plan.runtime.timeoutMs,
        maxOutputBytes: plan.runtime.maxOutputSizeBytes,
        maxMemoryBytes: plan.runtime.memoryLimitMb * 1024 * 1024,
        maxConcurrentInvocations: 4,
      },
      scope: "workspace",
      metadata: {
        opportunityId: opportunity.id,
        candidateId,
        targetType: plan.targetType,
        intent: plan.intent,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const manifest: ToolManifest = {
      ...manifestDraft,
      digest: hashCanonical(manifestDraft),
    };

    // 4. Create initial artifact set
    const initialArtifacts: GeneratedArtifactSet = {
      plan,
      manifest,
      capabilities: plan.capabilityRequirements,
      sourceCode,
      workflowDefinition:
        plan.targetType === "workflow"
          ? this.workflowGenerator.generateWorkflowDefinition(plan)
          : undefined,
      generatedAt: timestamp,
    };

    // 5. Run bounded self-review and repair orchestration
    const repairResult = this.repairOrchestrator.orchestrate(
      initialArtifacts,
      candidateId,
      options,
    );

    const activeRevision = repairResult.activeRevision;
    const finalState: CandidateState = repairResult.success ? "synthesized" : "failed";

    // 6. Build EvolutionCandidate domain entity
    const candidate: EvolutionCandidate = EvolutionCandidateSchema.parse({
      id: candidateId,
      workspaceId: tenant.workspaceId,
      state: finalState,
      trigger: {
        reason: opportunity.triggerReason,
        evidenceEventIds:
          opportunity.evidenceEventIds.length > 0 ? opportunity.evidenceEventIds : [randomUUID()],
        sessionOccurrences: opportunity.occurrenceCount,
        detectedAt: opportunity.createdAt || timestamp,
        patternFrequency: opportunity.occurrenceCount,
      },
      proposedTool: activeRevision.artifacts.manifest,
      requiredCapabilities: activeRevision.artifacts.capabilities,
      sourceCode: activeRevision.artifacts.sourceCode,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // 7. Persist candidate and revisions
    this.candidateStore.set(candidateId, { candidate, tenant });
    this.revisionStore.set(candidateId, repairResult.revisions);

    return {
      candidate,
      revisions: repairResult.revisions,
      activeRevision,
      status: repairResult.success ? "synthesized" : "failed",
      iterations: repairResult.revisions.length,
      errors: activeRevision.selfReview.issues
        .filter((i) => i.severity === "error")
        .map((i) => i.message),
    };
  }

  /**
   * Retrieves a candidate by ID, ensuring tenant isolation.
   */
  async getCandidateById(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<EvolutionCandidate | null> {
    const entry = this.candidateStore.get(candidateId);
    if (!entry) return null;
    if (
      entry.tenant.accountId !== tenant.accountId ||
      entry.tenant.workspaceId !== tenant.workspaceId
    ) {
      return null;
    }
    return entry.candidate;
  }

  /**
   * Retrieves all revisions for a candidate, ensuring tenant isolation.
   */
  async getRevisionsByCandidateId(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<CandidateRevision[]> {
    const entry = this.candidateStore.get(candidateId);
    if (!entry) return [];
    if (
      entry.tenant.accountId !== tenant.accountId ||
      entry.tenant.workspaceId !== tenant.workspaceId
    ) {
      return [];
    }
    return this.revisionStore.get(candidateId) ?? [];
  }

  /**
   * Retrieves the active revision for a candidate.
   */
  async getActiveRevision(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<CandidateRevision | null> {
    const revisions = await this.getRevisionsByCandidateId(tenant, candidateId);
    if (revisions.length === 0) return null;
    return revisions[revisions.length - 1];
  }

  /**
   * Lists candidates for a workspace with optional status filter.
   */
  async listCandidates(
    tenant: TenantContext,
    filter?: { state?: CandidateState },
  ): Promise<EvolutionCandidate[]> {
    const result: EvolutionCandidate[] = [];
    for (const entry of this.candidateStore.values()) {
      if (
        entry.tenant.accountId === tenant.accountId &&
        entry.tenant.workspaceId === tenant.workspaceId
      ) {
        if (!filter?.state || entry.candidate.state === filter.state) {
          result.push(entry.candidate);
        }
      }
    }
    return result;
  }

  /**
   * Clears in-memory candidate and revision stores (for test isolation).
   */
  clear(): void {
    this.candidateStore.clear();
    this.revisionStore.clear();
  }
}

/**
 * Factory function creating a CandidateGenerationService instance.
 */
export function createCandidateGenerationService(
  options: CandidateGenerationServiceOptions = {},
): CandidateGenerationService {
  return new CandidateGenerationService(options);
}
