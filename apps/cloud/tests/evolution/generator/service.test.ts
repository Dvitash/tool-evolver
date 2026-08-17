import { describe, expect, it } from "vitest";
import {
  CandidateGenerationService,
  createCandidateGenerationService,
} from "../../../src/evolution/generator/service.js";
import {
  createMockEnvelope,
  createMockOpportunity,
  createMockTenant,
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
    expect(result.revisions.length).toBeGreaterThanOrEqual(1);
    expect(result.activeRevision.selfReview.passed).toBe(true);

    // Query candidate
    const retrieved = await service.getCandidateById(tenant, result.candidate.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(result.candidate.id);

    // Query revisions
    const revisions = await service.getRevisionsByCandidateId(tenant, result.candidate.id);
    expect(revisions).toHaveLength(result.revisions.length);

    // Query active revision
    const activeRev = await service.getActiveRevision(tenant, result.candidate.id);
    expect(activeRev?.revisionId).toBe(result.activeRevision.revisionId);
  });

  it("should enforce tenant isolation when querying candidates and revisions", async () => {
    const tenantA = createMockTenant({ accountId: "acct-a", workspaceId: "ws-a" });
    const tenantB = createMockTenant({ accountId: "acct-b", workspaceId: "ws-b" });

    const opportunity = createMockOpportunity({
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
    });

    const result = await service.generateCandidate(tenantA, opportunity);

    // Tenant A can retrieve
    const foundA = await service.getCandidateById(tenantA, result.candidate.id);
    expect(foundA).not.toBeNull();

    // Tenant B cannot retrieve
    const foundB = await service.getCandidateById(tenantB, result.candidate.id);
    expect(foundB).toBeNull();

    // Tenant B cannot retrieve revisions
    const revsB = await service.getRevisionsByCandidateId(tenantB, result.candidate.id);
    expect(revsB).toHaveLength(0);
  });

  it("should list candidates filtered by workspace and optional state", async () => {
    service.clear();

    const tenant = createMockTenant();
    const opp1 = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Tool One",
        description: "Tool 1",
        taskClass: "compute",
        pattern: "compute",
        confidenceScore: 0.9,
        priority: "low",
        suggestedToolName: "tool_one",
      },
    });
    const opp2 = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Tool Two",
        description: "Tool 2",
        taskClass: "command",
        pattern: "command",
        confidenceScore: 0.85,
        priority: "medium",
        suggestedToolName: "tool_two",
      },
    });

    await service.generateCandidate(tenant, opp1);
    await service.generateCandidate(tenant, opp2);

    const all = await service.listCandidates(tenant);
    expect(all).toHaveLength(2);

    const synthesizedOnly = await service.listCandidates(tenant, { state: "synthesized" });
    expect(synthesizedOnly).toHaveLength(2);

    const approvedOnly = await service.listCandidates(tenant, { state: "approved" });
    expect(approvedOnly).toHaveLength(0);
  });

  it("should generate candidates constrained by capability envelope", async () => {
    const tenant = createMockTenant();
    const envelope = createMockEnvelope({
      command: {
        allowShellExecution: false,
        allowedBinaries: ["node"],
        allowedCommands: ["node -v"],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
    });

    const opp = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Safe Node Diagnostic",
        description: "Runs node version check",
        taskClass: "command",
        pattern: "command",
        confidenceScore: 0.9,
        priority: "low",
        suggestedToolName: "node_diag",
        inferredInputs: [{ name: "command", type: "string", description: "cmd" }],
      },
    });

    const result = await service.generateCandidate(tenant, opp, { envelope });

    expect(result.status).toBe("synthesized");
    expect(result.candidate.requiredCapabilities.command.allowShellExecution).toBe(false);
  });
});
