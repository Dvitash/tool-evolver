import { describe, expect, it } from "vitest";
import { hashCanonical } from "@tool-evolver/contracts";
import {
  type CandidateGenerationService,
  createCandidateGenerationService,
} from "../../../src/evolution/generator/service.js";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import {
  createMockEnvelope,
  createMockOpportunity,
  createMockTenant,
  createMockWorkflowContract,
  createMockOpportunityWithContract,
} from "./helpers.js";

describe("CandidateGenerationService (End-to-End)", () => {
  const service: CandidateGenerationService = createCandidateGenerationService();

  it("should generate a complete synthesized candidate from an eligible opportunity", async () => {
    const tenant = createMockTenant();
    const opportunity = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Clean and Rebuild Project",
        description: "Deletes build artifacts and runs compiler",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit -> command",
        confidenceScore: 0.94,
        priority: "high",
        suggestedToolName: "clean_and_rebuild",
      },
    });

    const result = await service.generateCandidate(tenant, opportunity);

    expect(result.status).toBe("synthesized");
    expect(result.candidate).toBeDefined();
    expect(result.candidate.id).toMatch(/^cand-/);
    expect(result.candidate.workspaceId).toBe(tenant.workspaceId);
    expect(result.candidate.state).toBe("synthesized");
    expect(result.candidate.proposedTool.name).toBe("clean_and_rebuild");
    expect(result.candidate.proposedTool.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.candidate.sourceCode).toContain("export default defineTool");
    expect(result.candidate.trigger.reason).toBe(opportunity.triggerReason);

    // Revisions
    expect(result.revisions).toHaveLength(1);
    expect(result.activeRevision).toBeDefined();
    expect(result.activeRevision.artifacts.plan.name).toBe("clean_and_rebuild");
    expect(result.activeRevision.selfReview.passed).toBe(true);

    const fetched = await service.getCandidateById(tenant, result.candidate.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(result.candidate.id);
    const fetchedRevs = await service.getRevisionsByCandidateId(tenant, result.candidate.id);
    expect(fetchedRevs).toHaveLength(1);
    const activeRev = await service.getActiveRevision(tenant, result.candidate.id);
    expect(activeRev?.revisionId).toBe(result.activeRevision.revisionId);
  });

  it("should enforce tenant isolation when querying candidates and revisions", async () => {
    const tenantA = createMockTenant({ accountId: "acct-a", workspaceId: "ws-a" });
    const tenantB = createMockTenant({ accountId: "acct-b", workspaceId: "ws-b" });

    const opportunityA = createMockOpportunity({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
    });
    const resultA = await service.generateCandidate(tenantA, opportunityA);

    // Tenant B should not see tenant A's candidate
    const fetchedByB = await service.getCandidateById(tenantB, resultA.candidate.id);
    expect(fetchedByB).toBeNull();
    const revsByB = await service.getRevisionsByCandidateId(tenantB, resultA.candidate.id);
    expect(revsByB).toHaveLength(0);
    const activeByB = await service.getActiveRevision(tenantB, resultA.candidate.id);
    expect(activeByB).toBeNull();

    // Tenant A can still see own candidate
    const fetchedByA = await service.getCandidateById(tenantA, resultA.candidate.id);
    expect(fetchedByA).not.toBeNull();
  });

  it("should list candidates filtered by workspace and optional state", async () => {
    const tenant = createMockTenant({ accountId: "acct-list", workspaceId: "ws-list" });

    const opp1 = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: { suggestedToolName: "tool_one" },
    });
    const opp2 = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: { suggestedToolName: "tool_two" },
    });

    await service.generateCandidate(tenant, opp1);
    await service.generateCandidate(tenant, opp2);

    const all = await service.listCandidates(tenant);
    expect(all).toHaveLength(2);
    const synthesizedOnly = await service.listCandidates(tenant, { state: "synthesized" });
    expect(synthesizedOnly).toHaveLength(2);
    const failedOnly = await service.listCandidates(tenant, { state: "failed" });
    expect(failedOnly).toHaveLength(0);
  });

  it("should generate candidates constrained by capability envelope", async () => {
    const tenant = createMockTenant();
    const opportunity = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
    });
    const envelope = createMockEnvelope({
      fs: { readPaths: ["/tmp"], writePaths: [] },
      command: { allowedCommands: [] },
    });

    const opp = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "File Writer",
        description: "Writes files to disk",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit",
      },
    });

    const result = await service.generateCandidate(tenant, opp, { envelope });

    expect(result.status).toBe("synthesized");
    expect(result.candidate.requiredCapabilities.command.allowShellExecution).toBe(false);
  });

  // === WorkflowContract coverage tests ===

  it("should retain exact workflowContract and complete coverage in final plan/artifacts", async () => {
    const tenant = createMockTenant({ accountId: "acct-wc-1", workspaceId: "ws-wc-1" });
    const contract = createMockWorkflowContract();
    const opportunity = createMockOpportunityWithContract(
      {},
      {
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        classification: {
          title: "Workflow coverage retention",
          description: "End-to-end workflow with contract",
          taskClass: "multi_step",
          pattern: "file_read -> file_edit -> test_runner",
        },
      },
    );
    // Ensure opportunity uses our contract (createMockOpportunityWithContract already does, but override to be explicit)
    opportunity.classification.workflowContract = contract;

    const freshService = createCandidateGenerationService();
    const result = await freshService.generateCandidate(tenant, opportunity);

    expect(result.status).toBe("synthesized");
    const plan = result.activeRevision.artifacts.plan;
    expect(plan.workflowContract).toBeDefined();
    expect(plan.workflowContract).toEqual(contract);
    expect(plan.workflowCoverage).toBeDefined();
    expect(plan.workflowCoverage!.complete).toBe(true);
    expect(plan.workflowCoverage!.uncoveredOperationIds).toEqual([]);
    expect(plan.workflowCoverage!.uncoveredOutputNames).toEqual([]);
    // Operation coverage should have an entry per contract operation
    expect(plan.workflowCoverage!.operationCoverage).toHaveLength(contract.operations.length);
    for (const op of contract.operations) {
      const cov = plan.workflowCoverage!.operationCoverage.find((c) => c.operationId === op.id);
      expect(cov).toBeDefined();
      expect(cov!.stepIds.length).toBeGreaterThan(0);
    }
    // Output coverage per required output
    expect(plan.workflowCoverage!.outputCoverage).toHaveLength(contract.outputRequirements.length);
    for (const out of contract.outputRequirements) {
      const cov = plan.workflowCoverage!.outputCoverage.find((c) => c.outputName === out.name);
      expect(cov).toBeDefined();
      expect(cov!.schemaPaths.length).toBeGreaterThan(0);
      expect(cov!.sourceOperationIds).toContain(out.sourceOperationId);
    }
    // Steps must be annotated with coveredOperationIds
    for (const step of plan.steps) {
      expect(step.coveredOperationIds).toBeDefined();
    }
    // Also ensure plan.outputSchema contains required outputs (never dropped)
    for (const out of contract.outputRequirements) {
      expect(plan.outputSchema.properties).toHaveProperty(out.name);
    }
  });

  it("should keep complete coverage metadata after repairs", async () => {
    const tenant = createMockTenant({ accountId: "acct-wc-2", workspaceId: "ws-wc-2" });
    const contract = createMockWorkflowContract();
    const opportunity = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Repair coverage preservation",
        description: "Workflow that will trigger repair but keep coverage",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit -> test_runner",
        workflowContract: contract,
      },
    });

    const freshService = createCandidateGenerationService();
    const result = await freshService.generateCandidate(tenant, opportunity);

    expect(result.status).toBe("synthesized");
    // All revisions should have complete coverage recomputed after each repair
    for (const rev of result.revisions) {
      const cov = rev.artifacts.plan.workflowCoverage;
      expect(cov).toBeDefined();
      expect(cov!.complete).toBe(true);
      expect(cov!.uncoveredOperationIds).toEqual([]);
      expect(cov!.uncoveredOutputNames).toEqual([]);
      // Contract retained in every revision
      expect(rev.artifacts.plan.workflowContract).toEqual(contract);
    }
    // Active revision also complete
    expect(result.activeRevision.artifacts.plan.workflowCoverage!.complete).toBe(true);
  });

  it("should produce different hashes when contract coverage changes", async () => {
    const tenant = createMockTenant({ accountId: "acct-wc-3", workspaceId: "ws-wc-3" });

    const contractA = createMockWorkflowContract();
    const contractB = createMockWorkflowContract({
      operations: [
        ...createMockWorkflowContract().operations,
        { id: "op_extra", order: 3, name: "extra search", toolClass: "search" as const },
      ],
      outputRequirements: [
        ...createMockWorkflowContract().outputRequirements,
        { name: "extraOutput", sourceOperationId: "op_extra", type: "string", required: true, description: "Extra output" },
      ],
    });

    // Use same opportunity id and structuralHash to isolate hash difference to contract coverage
    const baseId = "opp-hash-test-123";
    const baseHash = "hash-abc-123";

    const oppA = createMockOpportunity({
      id: baseId,
      structuralHash: baseHash,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Hash A",
        description: "Contract A",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit -> test_runner",
        workflowContract: contractA,
      },
    });

    const oppB = createMockOpportunity({
      id: baseId,
      structuralHash: baseHash,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Hash B",
        description: "Contract B with extra operation",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit -> test_runner -> search",
        workflowContract: contractB,
      },
    });

    const serviceA = createCandidateGenerationService();
    const serviceB = createCandidateGenerationService();

    const resultA = await serviceA.generateCandidate(tenant, oppA);
    const resultB = await serviceB.generateCandidate(tenant, oppB);

    expect(resultA.status).toBe("synthesized");
    expect(resultB.status).toBe("synthesized");

    // Coverage differs
    expect(resultA.activeRevision.artifacts.plan.workflowCoverage!.operationCoverage).toHaveLength(contractA.operations.length);
    expect(resultB.activeRevision.artifacts.plan.workflowCoverage!.operationCoverage).toHaveLength(contractB.operations.length);

    // Hashes must change when contract coverage changes — check manifest digest and candidate id and coverage hash
    expect(resultA.candidate.proposedTool.digest).not.toBe(resultB.candidate.proposedTool.digest);
    expect(resultA.candidate.id).not.toBe(resultB.candidate.id);

    const coverageHashA = hashCanonical(resultA.activeRevision.artifacts.plan.workflowCoverage);
    const coverageHashB = hashCanonical(resultB.activeRevision.artifacts.plan.workflowCoverage);
    expect(coverageHashA).not.toBe(coverageHashB);

    // Also ensure outputSchema differs due to extra output
    expect(resultA.activeRevision.artifacts.plan.outputSchema.properties).not.toEqual(
      resultB.activeRevision.artifacts.plan.outputSchema.properties,
    );
    expect(resultB.activeRevision.artifacts.plan.outputSchema.properties).toHaveProperty("extraOutput");
  });

  it("should fail clearly when contract coverage remains incomplete after repair exhausts", async () => {
    const tenant = createMockTenant({ accountId: "acct-wc-4", workspaceId: "ws-wc-4" });
    const contract = createMockWorkflowContract();

    const opportunity = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Incomplete coverage failure",
        description: "Will be forced incomplete",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit -> test_runner",
        workflowContract: contract,
      },
    });

    // Create a planner that deliberately omits multiple operations/outputs to force incomplete coverage beyond bounded repair (max 3)
    class IncompletePlanner extends CandidatePlanner {
      async planAsync(opp: typeof opportunity, options: unknown) {
        const plan = await super.planAsync(opp, options as never);
        // Force incomplete beyond repair bound: keep only first step and wipe outputs
        if (plan.steps.length > 1) {
          plan.steps = plan.steps.slice(0, 1);
          // Keep only first operation covered, leave others uncovered
        } else if (plan.steps.length === 1) {
          for (const s of plan.steps) {
            s.coveredOperationIds = [];
          }
        }
        // Wipe all contract outputs from schema to require multiple repair iterations (exceeds maxRepairIterations=3)
        const props = plan.outputSchema.properties as unknown as Record<string, unknown>;
        if (props) {
          // Clear top-level contract outputs, keep envelope
          for (const key of Object.keys(props)) {
            if (!["success", "data", "error", "stepResults"].includes(key)) {
              delete props[key];
            }
          }
          const dataProp = props.data as unknown as Record<string, unknown> | undefined;
          if (dataProp && typeof dataProp === "object" && dataProp !== null && "properties" in dataProp) {
            const dataProps = (dataProp as { properties: Record<string, unknown> }).properties;
            if (dataProps && typeof dataProps === "object") {
              for (const k of Object.keys(dataProps)) {
                delete dataProps[k];
              }
            }
          }
        }
        // Do not recompute coverage here — service will recompute and detect incomplete
        return plan;
      }
    }

    const incompleteService = createCandidateGenerationService({
      planner: new IncompletePlanner(),
    });

    const result = await incompleteService.generateCandidate(tenant, opportunity, {
      maxRepairIterations: 1,
    } as never);

    // Must not be returned as successful synthesized
    expect(result.status).not.toBe("synthesized");
    expect(["failed", "needs_repair"]).toContain(result.status);
    const cov = result.activeRevision.artifacts.plan.workflowCoverage;
    expect(cov).toBeDefined();
    expect(cov!.complete).toBe(false);
    expect(cov!.uncoveredOperationIds.length).toBeGreaterThan(0);
    // Errors should contain coverage diagnostics
    expect(result.errors).toBeDefined();
    expect(result.errors!.join(" ")).toMatch(/Missing operation coverage|Missing output coverage/);
    // Candidate state should be failed, not synthesized
    expect(result.candidate.state).toBe("failed");
  });

  it("should keep legacy opportunities without workflowContract compatible", async () => {
    const tenant = createMockTenant({ accountId: "acct-legacy", workspaceId: "ws-legacy" });
    const opportunity = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      // No workflowContract in classification — legacy
      classification: {
        title: "Legacy no contract",
        description: "Old opportunity without contract",
        taskClass: "single_tool",
        pattern: "file_read",
      },
    });
    // Ensure no contract
    delete (opportunity.classification as unknown as Record<string, unknown>).workflowContract;

    const freshService = createCandidateGenerationService();
    const result = await freshService.generateCandidate(tenant, opportunity);

    expect(result.status).toBe("synthesized");
    expect(result.activeRevision.artifacts.plan.workflowContract).toBeUndefined();
    expect(result.activeRevision.artifacts.plan.workflowCoverage).toBeUndefined();
    expect(result.candidate.proposedTool.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
