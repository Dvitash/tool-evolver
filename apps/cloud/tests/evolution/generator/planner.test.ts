import { describe, expect, it } from "vitest";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import { buildWorkflowCoverage, workflowCoverageDiagnostics } from "../../../src/evolution/generator/workflow-coverage.js";
import { createMockEnvelope, createMockOpportunity } from "./helpers.js";
import type { ToolOutputSchema } from "@tool-evolver/contracts";
import type { WorkflowContract } from "../../../src/evolution/opportunity/types.js";

function createGitFileAuditContract(): WorkflowContract {
  const operations = [
    { id: "op_0", order: 0, name: "command:git status --porcelain", toolClass: "vcs" as const, commandProfile: "git status --porcelain" },
    { id: "op_1", order: 1, name: "command:git diff --stat", toolClass: "vcs" as const, commandProfile: "git diff --stat" },
    { id: "op_2", order: 2, name: "command:git log --oneline -5", toolClass: "vcs" as const, commandProfile: "git log --oneline -5" },
    { id: "op_3", order: 3, name: "tool:read_file", toolClass: "file_read" as const },
    { id: "op_4", order: 4, name: "file_edit:update", toolClass: "file_edit" as const },
    { id: "op_5", order: 5, name: "command:git status --porcelain", toolClass: "vcs" as const, commandProfile: "git status --porcelain" },
  ];
  const outputRequirements = [
    { name: "op0_command_git_status_porcelain_result", sourceOperationId: "op_0", type: "object", required: true, description: "Output of command:git status --porcelain" },
    { name: "op1_command_git_diff_stat_result", sourceOperationId: "op_1", type: "object", required: true, description: "Output of command:git diff --stat" },
    { name: "op2_command_git_log_oneline_5_result", sourceOperationId: "op_2", type: "object", required: true, description: "Output of command:git log --oneline -5" },
    { name: "op3_tool_read_file_result", sourceOperationId: "op_3", type: "object", required: true, description: "Output of tool:read_file" },
    { name: "op4_file_edit_update_result", sourceOperationId: "op_4", type: "object", required: true, description: "Output of file_edit:update" },
    { name: "op5_command_git_status_porcelain_result", sourceOperationId: "op_5", type: "object", required: true, description: "Output of command:git status --porcelain" },
    { name: "commitSummary", sourceOperationId: "op_2", type: "string", required: true, description: "Commit summary" },
    { name: "filesChanged", sourceOperationId: "op_1", type: "number", required: true, description: "Files changed count" },
  ];
  return {
    version: 1,
    operations: operations as unknown as WorkflowContract["operations"],
    requiredInputs: [
      { name: "targetRepo", type: "string", description: "Target repository path", required: true },
      { name: "includeUntracked", type: "boolean", description: "Include untracked files", required: true },
    ],
    outputRequirements: outputRequirements as unknown as WorkflowContract["outputRequirements"],
    invariants: [
      "ordering: sequential op_0->op_5 must execute in observed order",
      "order:op_0->op_1->op_2->op_3->op_4->op_5",
      "structuralHash:hash-audit-123",
      "operationCount:6",
      "sideEffect: vcs reads working tree - requires git capability",
      "sideEffect: file_edit modifies filesystem - capability:write required",
      "workflowVersion:1",
    ],
    expensiveOperationIds: ["op_0", "op_5"],
    repeatedOperationIds: ["op_0", "op_5"],
  };
}

describe("CandidatePlanner", () => {
  const planner = new CandidatePlanner();

  it("should generate a workflow ToolPlan from a multi-step opportunity", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Lint and Run Tests",
        description: "Runs linting across workspace files then executes test suite",
        taskClass: "multi_step",
        pattern: "file_read -> command -> command",
        confidenceScore: 0.95,
        priority: "high",
        suggestedToolName: "lint_and_test",
        inferredInputs: [
          { name: "targetDir", type: "string", description: "Target directory" },
          { name: "coverage", type: "boolean", description: "Enable coverage" },
        ],
      },
    });

    const plan = planner.plan(opp);

    expect(plan.id).toMatch(/^plan-/);
    expect(plan.opportunityId).toBe(opp.id);
    expect(plan.workspaceId).toBe(opp.workspaceId);
    expect(plan.targetType).toBe("workflow");
    expect(plan.name).toBe("lint_and_test");
    expect(plan.intent).toBe("Lint and Run Tests");
    expect(plan.variableInputs).toHaveLength(2);
    expect(plan.variableInputs[0].name).toBe("targetdir");
    expect(plan.variableInputs[1].name).toBe("coverage");
    expect(plan.invariantInputs).toHaveLength(1);
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(plan.capabilityRequirements).toBeDefined();
    expect(plan.runtime.runtime).toBe("node");
  });

  it("should generate a single_tool ToolPlan for atomic command execution", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Execute Git Status Check",
        description: "Executes git status check and formats clean files",
        taskClass: "command",
        pattern: "command",
        confidenceScore: 0.88,
        priority: "medium",
        suggestedToolName: "git_status_check",
        inferredInputs: [
          { name: "command", type: "string", description: "Git subcommand to execute" },
        ],
        commandProfiles: ["git status --porcelain"],
      },
    });

    const plan = planner.plan(opp);

    expect(plan.targetType).toBe("single_tool");
    expect(plan.name).toBe("git_status_check");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].action).toBe("cmd.exec");
    expect(plan.steps[0].toolClass).toBe("command");
    expect(plan.steps[0].inputs.command).toBe("git");
    expect(plan.steps[0].inputs.args).toEqual(["status", "--porcelain"]);
    expect(plan.variableInputs.some((input) => input.name === "command")).toBe(false);
  });

  it("should derive fallback variable inputs when inferred inputs are empty", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Read Config File",
        description: "Reads configuration file",
        taskClass: "file_read",
        pattern: "file_read",
        confidenceScore: 0.8,
        priority: "low",
        inferredInputs: [],
      },
    });

    const plan = planner.plan(opp);

    expect(plan.variableInputs).toHaveLength(1);
    expect(plan.variableInputs[0].name).toBe("path");
    expect(plan.steps[0].action).toBe("fs.readFile");
  });

  it("should apply envelope constraints during planning when envelope is provided", () => {
    const envelope = createMockEnvelope({
      command: {
        allowShellExecution: false,
        allowedBinaries: ["git", "node"],
        allowedCommands: ["git status"],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
    });

    const opp = createMockOpportunity({
      classification: {
        title: "Inspect Repository",
        description: "Inspects repository status",
        taskClass: "command",
        pattern: "command",
        confidenceScore: 0.9,
        priority: "high",
        suggestedToolName: "inspect_repo",
        commandProfiles: ["git status --porcelain"],
        inferredInputs: [{ name: "command", type: "string", description: "Command to run" }],
      },
    });

    const plan = planner.plan(opp, { envelope });

    expect(plan.capabilityRequirements.command.allowShellExecution).toBe(false);
  });

  it("should map every ordered WorkflowContract operation and output requirement with preserved ordering for git/file audit", () => {
    const contract = createGitFileAuditContract();
    const opp = createMockOpportunity({
      classification: {
        title: "Git File Audit",
        description: "Audits git history and file changes across repository",
        taskClass: "multi_step",
        pattern: "vcs -> vcs -> vcs -> file_read -> file_edit -> vcs",
        confidenceScore: 0.96,
        priority: "high",
        suggestedToolName: "git_file_audit",
        inferredInputs: [
          { name: "targetRepo", type: "string", description: "Target repository path" },
          { name: "includeUntracked", type: "boolean", description: "Include untracked files" },
        ],
        candidateOutputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            filesChanged: { type: "number", description: "Files changed count" },
          },
        },
        workflowContract: contract,
      },
    });

    const plan = planner.plan(opp);

    // Contract-bearing plan must populate both fields
    expect(plan.workflowContract).toBeDefined();
    expect(plan.workflowContract!.version).toBe(1);
    expect(plan.workflowContract!.operations).toHaveLength(contract.operations.length);
    expect(plan.workflowCoverage).toBeDefined();
    const coverage = plan.workflowCoverage!;

    // All operations covered
    expect(coverage.operationCoverage).toHaveLength(contract.operations.length);
    expect(coverage.uncoveredOperationIds).toHaveLength(0);
    expect(coverage.complete).toBe(true);

    // Each operation maps to at least one step with explicit coveredOperationIds
    for (const op of contract.operations) {
      const entry = coverage.operationCoverage.find((c) => c.operationId === op.id);
      expect(entry).toBeDefined();
      expect(entry!.stepIds.length).toBeGreaterThanOrEqual(1);
      // Step actually contains the mapping
      const coveringSteps = plan.steps.filter((s) => s.coveredOperationIds?.includes(op.id));
      expect(coveringSteps.length).toBeGreaterThanOrEqual(1);
    }

    // Ordering preserved: steps are ordered by contract order and cover in sequence
    const sortedOps = [...contract.operations].sort((a, b) => a.order - b.order);
    expect(plan.steps.length).toBeGreaterThanOrEqual(sortedOps.length);
    // 1:1 mapping expected
    expect(plan.steps).toHaveLength(sortedOps.length);
    for (let i = 0; i < sortedOps.length; i++) {
      const step = plan.steps[i]!;
      expect(step.coveredOperationIds).toBeDefined();
      expect(step.coveredOperationIds).toContain(sortedOps[i]!.id);
      // dependency chain preserves order
      if (i > 0) {
        expect(step.dependsOn).toContain(plan.steps[i - 1]!.id);
      }
    }
    // No collapse to first command: second operation must be represented, not just op_0
    const secondOpSteps = plan.steps.filter((s) => s.coveredOperationIds?.includes("op_1"));
    expect(secondOpSteps.length).toBe(1);
    expect(secondOpSteps[0]!.inputs.commandProfile || secondOpSteps[0]!.inputs.command).toBeDefined();

    // All required outputs mapped
    expect(coverage.outputCoverage.length).toBe(contract.outputRequirements.length);
    expect(coverage.uncoveredOutputNames).toHaveLength(0);
    for (const req of contract.outputRequirements) {
      const outCov = coverage.outputCoverage.find((c) => c.outputName === req.name);
      expect(outCov).toBeDefined();
      expect(outCov!.schemaPaths.length).toBeGreaterThan(0);
      expect(outCov!.sourceOperationIds).toContain(req.sourceOperationId);
      // Schema union: every required output must exist under canonical nested data schema
      const nested = ((plan.outputSchema.properties as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.properties as Record<string, unknown> | undefined;
      expect(nested?.[req.name]).toBeDefined();
    }

    // Not collapsed to generic inspect/transform/write
    const genericNames = ["Inspect Workspace / Read Preconditions", "Execute Main Transformation", "Persist / Verify Output"];
    const hasGenericCollapse = plan.steps.length === 3 && plan.steps.every((s, idx) => s.name === genericNames[idx]);
    expect(hasGenericCollapse).toBe(false);
  });

  it("should never drop required contract outputs when unioning inferred and contract schemas", () => {
    const contract = createGitFileAuditContract();
    const opp = createMockOpportunity({
      classification: {
        title: "Git File Audit With Extra Inferred Outputs",
        description: "Audit with inferred outputs union",
        taskClass: "multi_step",
        pattern: "vcs -> vcs -> vcs -> file_read -> file_edit -> vcs",
        confidenceScore: 0.95,
        priority: "high",
        inferredInputs: [{ name: "targetRepo", type: "string", description: "Target repo" }],
        candidateOutputSchema: {
          type: "object",
          properties: {
            inferredOnly: { type: "string", description: "Inferred field" },
            filesChanged: { type: "number" },
          },
        },
        workflowContract: contract,
      },
    });

    const plan = planner.plan(opp);

    const dataProps = (plan.outputSchema.properties as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined;
    const inner = (dataProps?.properties as Record<string, unknown> | undefined);
    // Inferred output preserved under canonical envelope
    expect(inner?.inferredOnly).toBeDefined();
    // All contract required outputs preserved (never dropped) in canonical nested data schema
    for (const req of contract.outputRequirements) {
      if (req.required) {
        expect(inner?.[req.name]).toBeDefined();
      }
    }
  });

  it("should diagnose uncovered outputs when required outputs are missing from schema", () => {
    const contract = createGitFileAuditContract();
    // Build coverage against a plan that is missing one required output
    const opp = createMockOpportunity({
      classification: {
        title: "Git File Audit",
        description: "Audit",
        taskClass: "multi_step",
        pattern: "vcs -> vcs -> vcs -> file_read -> file_edit -> vcs",
        confidenceScore: 0.96,
        priority: "high",
        workflowContract: contract,
      },
    });

    const plan = planner.plan(opp);
    const missingOutput = contract.outputRequirements.find((r) => r.required)!.name;
    const tamperedSchema: ToolOutputSchema = { type: "object", properties: {} } as unknown as ToolOutputSchema;
    const coverage = buildWorkflowCoverage(contract, plan.steps, tamperedSchema);
    expect(coverage.uncoveredOutputNames).toContain(missingOutput);
    expect(coverage.complete).toBe(false);
    const diags = workflowCoverageDiagnostics(coverage);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some((d) => d.includes(missingOutput))).toBe(true);
    expect(diags.some((d) => d.toLowerCase().includes("missing output"))).toBe(true);
  });

  it("should diagnose uncovered operations when a contract operation has no covering step", () => {
    const contract = createGitFileAuditContract();
    const opp = createMockOpportunity({
      classification: {
        title: "Git File Audit",
        description: "Audit",
        taskClass: "multi_step",
        pattern: "vcs -> vcs -> vcs -> file_read -> file_edit -> vcs",
        confidenceScore: 0.96,
        priority: "high",
        workflowContract: contract,
      },
    });
    const plan = planner.plan(opp);
    // Remove coverage for one operation
    const tamperedSteps = plan.steps.filter((s) => !s.coveredOperationIds?.includes("op_2"));
    const coverage = buildWorkflowCoverage(contract, tamperedSteps, plan.outputSchema);
    expect(coverage.uncoveredOperationIds).toContain("op_2");
    expect(coverage.complete).toBe(false);
    const diags = workflowCoverageDiagnostics(coverage);
    expect(diags.some((d) => d.includes("op_2"))).toBe(true);
    expect(diags.some((d) => d.toLowerCase().includes("missing operation"))).toBe(true);
  });

  it("should retain legacy planning behavior for opportunities without a workflowContract", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Legacy Lint",
        description: "Legacy workflow without contract",
        taskClass: "multi_step",
        pattern: "file_read -> command",
        confidenceScore: 0.9,
        priority: "medium",
        inferredInputs: [{ name: "path", type: "string", description: "Path" }],
        // no workflowContract
      },
    });

    const plan = planner.plan(opp);

    expect(plan.workflowContract).toBeUndefined();
    expect(plan.workflowCoverage).toBeUndefined();
    // Legacy still produces workflow steps (generic)
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(plan.targetType).toBe("workflow");
    // No coveredOperationIds on legacy steps
    for (const step of plan.steps) {
      expect(step.coveredOperationIds).toBeUndefined();
    }
  });

  it("should handle contract with single operation without collapsing and preserve async path", async () => {
    const contract: WorkflowContract = {
      version: 1,
      operations: [{ id: "op_0", order: 0, name: "tool:read_file", toolClass: "file_read" as const }],
      requiredInputs: [{ name: "path", type: "string", description: "Path", required: true }],
      outputRequirements: [{ name: "op0_tool_read_file_result", sourceOperationId: "op_0", type: "object", required: true }],
      invariants: ["ordering: sequential op_0->op_0 must execute in observed order"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const opp = createMockOpportunity({
      classification: {
        title: "Single Op Audit",
        description: "Single operation contract",
        taskClass: "file_read",
        pattern: "file_read",
        confidenceScore: 0.9,
        priority: "low",
        workflowContract: contract,
      },
    });

    const plan = await planner.planAsync(opp);

    expect(plan.workflowContract).toBeDefined();
    expect(plan.workflowCoverage).toBeDefined();
    expect(plan.workflowCoverage!.complete).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.coveredOperationIds).toEqual(["op_0"]);
    expect(plan.outputSchema.properties?.op0_tool_read_file_result).toBeDefined();
  });
});
