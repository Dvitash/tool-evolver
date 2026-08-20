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

  it("should keep read then git status in order with correct command only on git and no cross-assignment or fallback", () => {
    const contract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "tool:read_file", toolClass: "file_read" as const, filePath: "src/a.ts", targetPaths: ["src/a.ts"] },
        { id: "op_1", order: 1, name: "command:git status --porcelain", toolClass: "vcs" as const, commandProfile: "git status --porcelain", args: ["status", "--porcelain"] },
      ],
      requiredInputs: [{ name: "targetPaths", type: "array", description: "Target file or directory paths to operate on.", required: true }],
      outputRequirements: [
        { name: "op0_tool_read_file_result", sourceOperationId: "op_0", type: "object", required: true },
        { name: "op1_command_git_status_porcelain_result", sourceOperationId: "op_1", type: "object", required: true },
      ],
      invariants: ["ordering: sequential op_0->op_1 must execute in observed order", "order:op_0->op_1"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const opp = createMockOpportunity({
      classification: {
        title: "Read then Git",
        description: "Read file then check git status",
        taskClass: "multi_step",
        pattern: "file_read -> vcs",
        confidenceScore: 0.95,
        priority: "high",
        inferredInputs: [{ name: "targetPaths", type: "array", description: "Target paths" }],
        workflowContract: contract,
      },
    });
    const plan = planner.plan(opp);
    expect(plan.steps).toHaveLength(2);
    // Preserve order and deterministic IDs
    expect(plan.steps[0]!.id).toBe("step_op_0");
    expect(plan.steps[1]!.id).toBe("step_op_1");
    expect(plan.steps[0]!.coveredOperationIds).toEqual(["op_0"]);
    expect(plan.steps[1]!.coveredOperationIds).toEqual(["op_1"]);
    expect(plan.steps[0]!.dependsOn).toEqual([]);
    expect(plan.steps[1]!.dependsOn).toContain("step_op_0");
    // Read step must NOT have git command (cross-assignment fails test)
    expect(plan.steps[0]!.inputs.command).toBeUndefined();
    expect(plan.steps[0]!.inputs.commandProfile).toBeUndefined();
    expect(plan.steps[0]!.inputs.path ?? (plan.steps[0]!.inputs as Record<string, unknown>).targetPaths).toBeDefined();
    const readPath = (plan.steps[0]!.inputs.path ?? (plan.steps[0]!.inputs as Record<string, unknown>).targetPaths) as string;
    expect(String(readPath).toLowerCase()).toContain("targetpaths");
    expect(String(readPath)).not.toBe("./data.txt");
    // Git step must have correct command only on git
    expect(plan.steps[1]!.inputs.command).toBe("git");
    expect(plan.steps[1]!.inputs.args).toEqual(["status", "--porcelain"]);
    expect(plan.steps[1]!.inputs.commandProfile).toBe("git status --porcelain");
    // No fallback paths on either step
    for (const step of plan.steps) {
      const pathVal = (step.inputs.path ?? step.inputs.targetPaths ?? "") as string;
      if (typeof pathVal === "string") {
        expect(pathVal).not.toBe("./data.txt");
        expect(pathVal).not.toBe("${input.input}");
      }
      // Ensure no step uses fallback content without variable
      if ("content" in step.inputs) {
        const contentVal = step.inputs.content as string;
        expect(contentVal).not.toBe("./data.txt");
      }
    }
    // Coverage complete and deterministic
    expect(plan.workflowCoverage?.complete).toBe(true);
    expect(plan.workflowCoverage?.uncoveredOperationIds).toHaveLength(0);
  });

  it("should consume targetPaths for multi-path file workflows for both scalar and array inputs without fallback", () => {
    // Array input case
    const arrayContract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "tool:read_file", toolClass: "file_read" as const, filePath: "src/one.ts", targetPaths: ["src/one.ts", "src/two.ts"] },
        { id: "op_1", order: 1, name: "file_edit:update", toolClass: "file_edit" as const, filePath: "src/two.ts", targetPaths: ["src/one.ts", "src/two.ts"] },
      ],
      requiredInputs: [{ name: "targetPaths", type: "array", description: "Target file or directory paths to operate on.", required: true }],
      outputRequirements: [
        { name: "op0_tool_read_file_result", sourceOperationId: "op_0", type: "object", required: true },
        { name: "op1_file_edit_update_result", sourceOperationId: "op_1", type: "object", required: true },
      ],
      invariants: ["ordering: sequential op_0->op_1 must execute in observed order"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const arrayOpp = createMockOpportunity({
      classification: {
        title: "Multi-path Edit",
        description: "Edit multiple files",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit",
        confidenceScore: 0.9,
        priority: "high",
        inferredInputs: [{ name: "targetPaths", type: "array", description: "Target paths" }],
        workflowContract: arrayContract,
      },
    });
    const arrayPlan = planner.plan(arrayOpp);
    for (const step of arrayPlan.steps) {
      const pathVal = (step.inputs.path ?? step.inputs.targetPaths) as string;
      expect(String(pathVal).toLowerCase()).toContain("targetpaths");
      expect(String(pathVal)).not.toBe("./data.txt");
      expect(String(pathVal)).not.toBe("${input.input}");
    }
    expect(arrayPlan.workflowCoverage?.complete).toBe(true);

    // Scalar input case (single targetPath as string)
    const scalarContract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "tool:read_file", toolClass: "file_read" as const, filePath: "src/single.ts", targetPaths: ["src/single.ts"] },
      ],
      requiredInputs: [{ name: "targetPaths", type: "string", description: "Target file or directory path to operate on.", required: true }],
      outputRequirements: [{ name: "op0_tool_read_file_result", sourceOperationId: "op_0", type: "object", required: true }],
      invariants: ["ordering: sequential op_0->op_0 must execute in observed order"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const scalarOpp = createMockOpportunity({
      classification: {
        title: "Single-path Read",
        description: "Read single file with scalar targetPaths",
        taskClass: "file_read",
        pattern: "file_read",
        confidenceScore: 0.9,
        priority: "high",
        inferredInputs: [{ name: "targetPaths", type: "string", description: "Target path" }],
        workflowContract: scalarContract,
      },
    });
    const scalarPlan = planner.plan(scalarOpp);
    expect(scalarPlan.steps).toHaveLength(1);
    const scalarPath = (scalarPlan.steps[0]!.inputs.path ?? scalarPlan.steps[0]!.inputs.targetPaths) as string;
    expect(String(scalarPath).toLowerCase()).toContain("targetpaths");
    expect(String(scalarPath)).not.toBe("./data.txt");
    expect(scalarPlan.workflowCoverage?.complete).toBe(true);
  });

  it("should fail on cross-assignment or fallback paths if mis-bound", () => {
    // This test explicitly asserts that a buggy planner that cross-assigns or uses fallback would fail.
    // We construct a contract with read + git and verify the plan does NOT exhibit those bugs.
    const contract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "tool:read_file", toolClass: "file_read" as const, filePath: "src/b.ts" },
        { id: "op_1", order: 1, name: "command:git diff --stat", toolClass: "vcs" as const, commandProfile: "git diff --stat", args: ["diff", "--stat"] },
      ],
      requiredInputs: [{ name: "targetPaths", type: "array", description: "Target paths", required: true }],
      outputRequirements: [
        { name: "op0_tool_read_file_result", sourceOperationId: "op_0", type: "object", required: true },
        { name: "op1_command_git_diff_stat_result", sourceOperationId: "op_1", type: "object", required: true },
      ],
      invariants: ["ordering: sequential op_0->op_1"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const opp = createMockOpportunity({
      classification: {
        title: "Read then Diff",
        description: "Read then diff",
        taskClass: "multi_step",
        pattern: "file_read -> vcs",
        confidenceScore: 0.9,
        priority: "high",
        workflowContract: contract,
      },
    });
    const plan = planner.plan(opp);
    // Cross-assignment check: read must not have command, git must have diff not status
    expect(plan.steps[0]!.inputs.command).toBeUndefined();
    expect(plan.steps[0]!.inputs.commandProfile).toBeUndefined();
    expect(plan.steps[1]!.inputs.command).toBe("git");
    expect(plan.steps[1]!.inputs.args).toEqual(["diff", "--stat"]);
    expect(plan.steps[1]!.inputs.commandProfile).toBe("git diff --stat");
    // Fallback check: no step should use ./data.txt or bare input.input when targetPaths required
    for (const step of plan.steps) {
      const inputsStr = JSON.stringify(step.inputs);
      expect(inputsStr).not.toContain("./data.txt");
      // If targetPaths is required input, file step must reference it, not missing input.input for path
      if (step.toolClass === "filesystem") {
        const pathVal = String(step.inputs.path ?? step.inputs.targetPaths ?? "");
        expect(String(pathVal).toLowerCase()).toContain("targetpaths");
        expect(pathVal).not.toBe("${input.input}");
      }
    }
  });

  it("should keep composite command profiles on one operation without displacing later command and no profile loss", () => {
    const contract = {
      version: 1,
      operations: [
        {
          id: "op_0",
          order: 0,
          name: "command:git",
          toolClass: "vcs" as const,
          commandProfiles: ["git status --porcelain", "git diff --stat"],
          commandProfile: "git status --porcelain",
          args: ["status", "--porcelain"],
        },
        {
          id: "op_1",
          order: 1,
          name: "command:npm test",
          toolClass: "test_runner" as const,
          commandProfiles: ["npm test"],
          commandProfile: "npm test",
          args: ["test"],
        },
      ],
      requiredInputs: [{ name: "targetRepo", type: "string", description: "repo", required: true }],
      outputRequirements: [
        { name: "op0_git_result", sourceOperationId: "op_0", type: "object", required: true },
        { name: "op1_npm_result", sourceOperationId: "op_1", type: "object", required: true },
      ],
      invariants: ["ordering: sequential op_0->op_1", "order:op_0->op_1"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    } as unknown as WorkflowContract;
    const opp = createMockOpportunity({
      classification: {
        title: "Composite then npm",
        description: "Composite git then npm",
        taskClass: "multi_step",
        pattern: "command -> command",
        confidenceScore: 0.9,
        priority: "high",
        workflowContract: contract,
      },
    });
    const plan = planner.plan(opp);
    // Preserve both origins/order and no Displacement: one step per originating operation
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.id).toBe("step_op_0");
    expect(plan.steps[1]!.id).toBe("step_op_1");
    expect(plan.steps[0]!.coveredOperationIds).toEqual(["op_0"]);
    expect(plan.steps[1]!.coveredOperationIds).toEqual(["op_1"]);
    expect(plan.steps[0]!.dependsOn).toEqual([]);
    expect(plan.steps[1]!.dependsOn).toContain("step_op_0");

    // Composite stays on one operation as commandProfiles array, no cross-assignment
    const op0Inputs = plan.steps[0]!.inputs as Record<string, unknown>;
    const op1Inputs = plan.steps[1]!.inputs as Record<string, unknown>;
    expect(op0Inputs.commandProfiles).toBeDefined();
    expect(op0Inputs.commandProfiles).toEqual(["git status --porcelain", "git diff --stat"]);
    expect(op0Inputs.commandProfile).toBe("git status --porcelain");
    expect(op1Inputs.commandProfiles).toEqual(["npm test"]);
    expect(op1Inputs.commandProfile).toBe("npm test");
    // No cross-assignment: op0 must not contain npm, op1 must not contain git diff
    expect((op0Inputs.commandProfiles as string[])).not.toContain("npm test");
    expect((op1Inputs.commandProfiles as string[])).not.toContain("git diff --stat");

    // No profile loss: all three profiles accounted for
    const allProfiles = plan.steps.flatMap((s) => {
      const cps = (s.inputs as Record<string, unknown>).commandProfiles as string[] | undefined;
      if (cps) return cps;
      const cp = (s.inputs as Record<string, unknown>).commandProfile as string | undefined;
      return cp ? [cp] : [];
    });
    // Note: step 0 batches both git profiles, step 1 has npm; flatMap will duplicate git profiles if we flatten both steps' arrays.
    // Instead check per-operation preservation: op0's array has 2, op1's has 1
    expect(op0Inputs.commandProfiles).toHaveLength(2);
    expect(op1Inputs.commandProfiles).toHaveLength(1);
    expect(plan.workflowCoverage).toBeDefined();
    expect(plan.workflowCoverage!.complete).toBe(true);
  });
});
