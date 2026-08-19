import { describe, expect, it } from "vitest";
import { createCandidateGenerationService } from "../../../src/evolution/generator/service.js";
import { FakeModelProvider, createInferenceService } from "../../../src/models/index.js";
import { createMockOpportunity, createMockTenant } from "./helpers.js";

function createCommandOpportunity() {
  const tenant = createMockTenant();
  return {
    tenant,
    opportunity: createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Git Status Checker",
        description: "Executes the observed immutable git status command",
        taskClass: "command",
        pattern: "vcs_command",
        confidenceScore: 0.95,
        priority: "high",
        suggestedToolName: "git_status_checker",
        commandProfiles: ["git status --porcelain"],
      },
    }),
  };
}

function createModelBackedService(allowDeterministicFallback: boolean) {
  const provider = new FakeModelProvider({ id: "broker-family-test-provider" });
  const inferenceService = createInferenceService();
  inferenceService.router.registerProvider(provider);
  return createCandidateGenerationService({
    inferenceService,
    allowDeterministicFallback,
  });
}

describe("Inference broker-family contract", () => {
  it("rejects a mismatched inferred broker implementation and uses deterministic synthesis when allowed", async () => {
    const { tenant, opportunity } = createCommandOpportunity();
    const service = createModelBackedService(true);

    const result = await service.generateCandidate(tenant, opportunity);

    expect(result.status).toBe("synthesized");
    expect(result.candidate.sourceCode).toContain("broker.cmd.exec");
    expect(result.candidate.sourceCode).not.toContain("broker.fs.writeFile");
  });

  it("fails closed when inferred code violates the planned broker family and fallback is disabled", async () => {
    const { tenant, opportunity } = createCommandOpportunity();
    const service = createModelBackedService(false);

    await expect(service.generateCandidate(tenant, opportunity)).rejects.toThrow(
      "capability-compatible tool source",
    );
  });
});
