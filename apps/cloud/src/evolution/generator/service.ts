import { randomUUID } from "node:crypto";
import {
  type CandidateState,
  type EvolutionCandidate,
  EvolutionCandidateSchema,
  type ToolManifest,
  hashCanonical,
} from "@tool-evolver/contracts";
import type { DatabasePool } from "../../db/client.js";
import type { InferenceService } from "../../models/service.js";
import type { InferenceProvenance, ModelUsage } from "../../models/types.js";
import type { ObjectStore } from "../../storage/object-store.js";
import { type TenantContext, TenantGuard } from "../../tenant.js";
import type { OpportunityDetection } from "../opportunity/types.js";
import { CapabilityMapper } from "./capability-mapper.js";
import { CodeGenerator } from "./code-generator.js";
import { CandidatePlanner } from "./planner.js";
import { RepairOrchestrator } from "./repair-orchestrator.js";
import { type CandidateFilter, CandidateRepository } from "./repositories/candidate-repository.js";
import { SchemaGenerator } from "./schema-generator.js";
import { DeterministicSelfReviewer } from "./self-reviewer.js";
import type {
  CandidateGenerationOptions,
  CandidateRevision,
  GeneratedArtifactSet,
  GenerationResult,
  ToolPlan,
} from "./types.js";
import { WorkflowGenerator } from "./workflow-generator.js";

/**
 * Options for configuring CandidateGenerationService.
 */
export interface CandidateGenerationServiceOptions {
  planner?: CandidatePlanner;
  codeGenerator?: CodeGenerator;
  selfReviewer?: DeterministicSelfReviewer;
  repairOrchestrator?: RepairOrchestrator;
  capabilityMapper?: CapabilityMapper;
  schemaGenerator?: SchemaGenerator;
  workflowGenerator?: WorkflowGenerator;
  inferenceService?: InferenceService;
  pool?: DatabasePool;
  objectStore?: ObjectStore;
  candidateRepo?: CandidateRepository;
}

/**
 * Service managing candidate planning, code generation, self-review, repair lineage, and PostgreSQL storage.
 */
export class CandidateGenerationService {
  private readonly planner: CandidatePlanner;
  private readonly codeGenerator: CodeGenerator;
  private readonly selfReviewer: DeterministicSelfReviewer;
  private readonly repairOrchestrator: RepairOrchestrator;
  private readonly schemaGenerator: SchemaGenerator;
  private readonly capabilityMapper: CapabilityMapper;
  private readonly workflowGenerator: WorkflowGenerator;
  private readonly inferenceService?: InferenceService;
  private readonly candidateRepo?: CandidateRepository;

  private readonly candidateStore: Map<
    string,
    { candidate: EvolutionCandidate; tenant: TenantContext }
  > = new Map();
  private readonly revisionStore: Map<string, CandidateRevision[]> = new Map();

  constructor(options: CandidateGenerationServiceOptions = {}) {
    this.inferenceService = options.inferenceService;
    this.schemaGenerator = options.schemaGenerator ?? new SchemaGenerator();
    this.capabilityMapper = options.capabilityMapper ?? new CapabilityMapper();
    this.workflowGenerator =
      options.workflowGenerator ?? new WorkflowGenerator(this.schemaGenerator);
    this.planner =
      options.planner ??
      new CandidatePlanner(this.schemaGenerator, this.capabilityMapper, this.inferenceService);
    this.codeGenerator =
      options.codeGenerator ??
      new CodeGenerator(this.schemaGenerator, this.workflowGenerator, this.inferenceService);
    this.selfReviewer = options.selfReviewer ?? new DeterministicSelfReviewer();
    this.repairOrchestrator =
      options.repairOrchestrator ?? new RepairOrchestrator(this.selfReviewer);

    if (options.candidateRepo) {
      this.candidateRepo = options.candidateRepo;
    } else if (options.pool) {
      this.candidateRepo = new CandidateRepository(options.pool, options.objectStore);
    }
  }

  /**
   * Generates, reviews, repairs, and persists an evolution candidate from an opportunity.
   */
  async generateCandidate(
    tenant: TenantContext,
    opportunity: OpportunityDetection,
    options: CandidateGenerationOptions = {},
  ): Promise<GenerationResult> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    const version = options.version ?? "1.0.0";
    const timestamp = new Date().toISOString();

    // 1. Structured Candidate Planning with Inference
    const plan: ToolPlan = await this.planner.planAsync(opportunity, {
      envelope: options.envelope,
      targetType: options.targetType,
      tenantId: tenant.workspaceId,
      inferenceService: this.inferenceService,
    });

    // 2. Structured Schema Generation with Inference
    const derivedSchemas = await this.schemaGenerator.deriveSchemasAsync({
      toolName: plan.name,
      description: plan.description,
      variableInputs: plan.variableInputs,
      steps: plan.steps,
      workflowEvidence: opportunity.classification.description,
      tenantId: tenant.workspaceId,
      inferenceService: this.inferenceService,
    });
    plan.inputSchema = derivedSchemas.inputSchema;
    plan.outputSchema = derivedSchemas.outputSchema;

    // 3. Structured Code Generation with Inference
    const codeResult = await this.codeGenerator.generateSourceAsync(plan, {
      tenantId: tenant.workspaceId,
      inferenceService: this.inferenceService,
      workflowEvidence: opportunity.classification.description,
    });
    const sourceCode = codeResult.sourceCode;

    // 4. Construct initial ToolManifest with computed canonical digests
    const toolId = `tool_${hashCanonical({
      workspaceId: tenant.workspaceId,
      name: plan.name,
      version,
    }).slice(0, 16)}`;

    const runtimeReq = {
      runtime: "deno" as const,
      memoryLimitMb: plan.runtime.memoryLimitMb,
      timeoutMs: plan.runtime.timeoutMs,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    };

    const manifestDigest = hashCanonical({
      id: toolId,
      name: plan.name,
      version,
      description: plan.description,
      parameters: plan.inputSchema,
      outputSchema: plan.outputSchema,
      capabilities: plan.capabilityRequirements,
      runtime: runtimeReq,
    });

    const manifest: ToolManifest = {
      id: toolId,
      name: plan.name,
      version,
      description: plan.description,
      parameters: plan.inputSchema,
      outputSchema: plan.outputSchema,
      capabilities: plan.capabilityRequirements,
      runtime: runtimeReq,
      limits: {
        timeoutMs: plan.runtime.timeoutMs,
        maxMemoryBytes: plan.runtime.memoryLimitMb * 1024 * 1024,
        maxOutputBytes: 1048576,
        maxConcurrentInvocations: 4,
      },
      scope: "workspace",
      digest: manifestDigest,
      metadata: {
        ...plan.metadata,
        opportunityId: opportunity.id,
        structuralHash: opportunity.structuralHash,
      },
      createdAt: timestamp,
    };
    const initialArtifacts: GeneratedArtifactSet = {
      plan,
      manifest,
      capabilities: plan.capabilityRequirements,
      sourceCode,
      generatedAt: timestamp,
    };

    // 5. Compute deterministic Candidate ID based on opportunity identity and tenant
    const candidateId = `cand-${hashCanonical({
      workspaceId: tenant.workspaceId,
      opportunityId: opportunity.id,
      structuralHash: opportunity.structuralHash,
    }).slice(0, 16)}`;

    // 6. Perform Self-Review and Automated Repair Loop via RepairOrchestrator
    const repairResult = this.repairOrchestrator.orchestrate(
      initialArtifacts,
      candidateId,
      options,
    );
    const activeRevision = repairResult.activeRevision;
    const finalState: CandidateState = repairResult.success ? "synthesized" : "failed";

    // Attach inference provenance & metadata to active revision
    if (codeResult.provenance) {
      activeRevision.provenance = codeResult.provenance as Record<string, unknown>;
      activeRevision.promptTemplateId = codeResult.provenance.promptTemplateId;
      activeRevision.promptTemplateVersion = codeResult.provenance.promptTemplateVersion;
      activeRevision.promptDigest = codeResult.provenance.promptDigest;
      activeRevision.modelProvider = codeResult.provenance.providerId;
      activeRevision.modelId = codeResult.provenance.model;
      activeRevision.requestId = codeResult.provenance.requestId;
    }
    if (codeResult.usage) {
      activeRevision.usage = codeResult.usage;
    }

    // 7. Build EvolutionCandidate domain entity preserving deterministic opportunity metadata
    const candidate: EvolutionCandidate = EvolutionCandidateSchema.parse({
      id: candidateId,
      workspaceId: tenant.workspaceId,
      schemaVersion: "1.0.0",
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
      createdAt: opportunity.createdAt || timestamp,
      updatedAt: timestamp,
    });

    // 8. Persist in memory store
    this.candidateStore.set(candidateId, { candidate, tenant });
    this.revisionStore.set(candidateId, repairResult.revisions);

    // 9. Persist in PostgreSQL repository if available
    if (this.candidateRepo) {
      for (const rev of repairResult.revisions) {
        await this.candidateRepo.saveRevision(tenant, rev);
      }
      await this.candidateRepo.saveCandidate(tenant, candidate, {
        activeRevision,
        provenance: {
          opportunityId: opportunity.id,
          structuralHash: opportunity.structuralHash,
          promptTemplateId: activeRevision.promptTemplateId,
          promptTemplateVersion: activeRevision.promptTemplateVersion,
          modelProvider: activeRevision.modelProvider,
          modelId: activeRevision.modelId,
          requestId: activeRevision.requestId,
          usage: activeRevision.usage,
        },
      });
    }

    return {
      candidate,
      revisions: repairResult.revisions,
      activeRevision,
      status: finalState === "synthesized" ? "synthesized" : "needs_repair",
      iterations: repairResult.revisions.length,
      errors: repairResult.activeRevision.selfReview.passed
        ? undefined
        : repairResult.activeRevision.selfReview.issues.map((i: { message: string }) => i.message),
    };
  }
  /**
   * Retrieves a candidate by ID, querying PostgreSQL repository or in-memory fallback.
   */
  async getCandidateById(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<EvolutionCandidate | null> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    if (this.candidateRepo) {
      const persisted = await this.candidateRepo.getCandidateById(tenant, candidateId);
      if (persisted) return persisted;
    }

    const record = this.candidateStore.get(candidateId);
    if (!record) {
      return null;
    }

    if (record.tenant.workspaceId !== tenant.workspaceId) {
      return null;
    }

    return record.candidate;
  }

  /**
   * Alias for getCandidateById.
   */
  async getCandidate(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<EvolutionCandidate | null> {
    return this.getCandidateById(tenant, candidateId);
  }

  /**
   * Retrieves all revisions for a candidate.
   */
  async getRevisionsByCandidateId(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<CandidateRevision[]> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    if (this.candidateRepo) {
      const persisted = await this.candidateRepo.listRevisions(tenant, candidateId);
      if (persisted.length > 0) return persisted;
    }

    const record = this.candidateStore.get(candidateId);
    if (!record || record.tenant.workspaceId !== tenant.workspaceId) {
      return [];
    }

    return this.revisionStore.get(candidateId) ?? [];
  }

  /**
   * Alias for getRevisionsByCandidateId.
   */
  async getRevisions(tenant: TenantContext, candidateId: string): Promise<CandidateRevision[]> {
    return this.getRevisionsByCandidateId(tenant, candidateId);
  }

  /**
   * Retrieves a single revision by ID.
   */
  async getRevisionById(
    tenant: TenantContext,
    revisionId: string,
  ): Promise<CandidateRevision | null> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    if (this.candidateRepo) {
      const persisted = await this.candidateRepo.getRevisionById(tenant, revisionId);
      if (persisted) return persisted;
    }

    for (const revisions of this.revisionStore.values()) {
      const found = revisions.find((r) => r.revisionId === revisionId);
      if (found) {
        const parentCandidate = this.candidateStore.get(found.candidateId);
        if (parentCandidate && parentCandidate.tenant.workspaceId === tenant.workspaceId) {
          return found;
        }
      }
    }

    return null;
  }

  /**
   * Alias for getRevisionById.
   */
  async getRevision(tenant: TenantContext, revisionId: string): Promise<CandidateRevision | null> {
    return this.getRevisionById(tenant, revisionId);
  }

  /**
   * Retrieves the active revision for a candidate.
   */
  async getActiveRevision(
    tenant: TenantContext,
    candidateId: string,
  ): Promise<CandidateRevision | null> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    if (this.candidateRepo) {
      const persisted = await this.candidateRepo.getActiveRevision(tenant, candidateId);
      if (persisted) return persisted;
    }

    const revisions = await this.getRevisionsByCandidateId(tenant, candidateId);
    if (revisions.length === 0) return null;
    return revisions[revisions.length - 1];
  }

  /**
   * Lists all candidates for a tenant.
   */
  async listCandidates(
    tenant: TenantContext,
    filter: CandidateFilter = {},
  ): Promise<EvolutionCandidate[]> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    if (this.candidateRepo) {
      return this.candidateRepo.listCandidates(tenant, filter);
    }
    const result: EvolutionCandidate[] = [];
    for (const { candidate, tenant: storedTenant } of this.candidateStore.values()) {
      if (storedTenant.workspaceId === tenant.workspaceId) {
        if (filter.state && candidate.state !== filter.state) {
          continue;
        }
        result.push(candidate);
      }
    }
    return result;
  }

  /**
   * Clears internal candidate and revision stores (useful for test isolation).
   */
  clearStores(): void {
    this.candidateStore.clear();
    this.revisionStore.clear();
  }

  clear(): void {
    this.clearStores();
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
