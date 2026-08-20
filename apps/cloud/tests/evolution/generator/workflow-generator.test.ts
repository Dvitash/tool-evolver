import { describe, expect, it } from "vitest";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import type { WorkflowStep } from "../../../src/evolution/generator/types.js";
import { buildWorkflowCoverage, workflowCoverageDiagnostics } from "../../../src/evolution/generator/workflow-coverage.js";
import { WorkflowGenerator } from "../../../src/evolution/generator/workflow-generator.js";
import type { WorkflowContract } from "../../../src/evolution/opportunity/types.js";
import { createMockOpportunity } from "./helpers.js";

describe("WorkflowGenerator", () => {
  const workflowGen = new WorkflowGenerator();
  const planner = new CandidatePlanner();

  it("should sort workflow steps in topological dependency order", () => {
    const steps: WorkflowStep[] = [
      {
        id: "step_3",
        name: "Test",
        toolClass: "command",
        action: "cmd.exec",
        inputs: {},
        dependsOn: ["step_2"],
      },
      {
        id: "step_1",
        name: "Read",
        toolClass: "file_read",
        action: "fs.readFile",
        inputs: {},
        dependsOn: [],
      },
      {
        id: "step_2",
        name: "Edit",
        toolClass: "file_edit",
        action: "fs.writeFile",
        inputs: {},
        dependsOn: ["step_1"],
      },
    ];

    const sorted = workflowGen.topologicalSort(steps);

    expect(sorted.map((s) => s.id)).toEqual(["step_1", "step_2", "step_3"]);
  });

  it("should detect and reject cyclic dependencies in workflow steps", () => {
    const steps: WorkflowStep[] = [
      {
        id: "step_a",
        name: "Step A",
        toolClass: "compute",
        action: "compute",
        inputs: {},
        dependsOn: ["step_b"],
      },
      {
        id: "step_b",
        name: "Step B",
        toolClass: "compute",
        action: "compute",
        inputs: {},
        dependsOn: ["step_a"],
      },
    ];

    expect(() => workflowGen.topologicalSort(steps)).toThrow(/Cyclic dependency detected/);
  });

  it("should generate a workflow definition object", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Clean and Build Workflow",
        description: "Cleans output directory and compiles source",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit -> command",
        confidenceScore: 0.9,
        priority: "high",
        suggestedToolName: "clean_and_build",
      },
    });

    const plan = planner.plan(opp, { targetType: "workflow" });
    const def = workflowGen.generateWorkflowDefinition(plan);

    expect(def.id).toBe(plan.id);
    expect(def.name).toBe("clean_and_build");
    expect(Array.isArray(def.steps)).toBe(true);
    expect((def.steps as unknown[]).length).toBe(plan.steps.length);
  });

  it("should generate orchestrating TypeScript source with compensation and progress tracking", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Format, Edit and Verify",
        description: "Multi-step workflow",
        taskClass: "multi_step",
        pattern: "file_read -> file_edit -> command",
        confidenceScore: 0.9,
        priority: "high",
        suggestedToolName: "format_edit_verify",
      },
    });

    const plan = planner.plan(opp, { targetType: "workflow" });
    const sourceCode = workflowGen.generateWorkflowSource(plan);

    expect(sourceCode).toContain(
      'import { defineTool, type ToolContext } from "@tool-evolver/runtime";',
    );
    expect(sourceCode).toContain("export const InputSchema =");
    expect(sourceCode).toContain("export const OutputSchema =");
    expect(sourceCode).toContain("export default defineTool<ToolInput, ToolOutput>(");
    expect(sourceCode).toContain("const compensationStack: Array<() => Promise<void>> = [];");
    expect(sourceCode).toContain("compensationStack.push(async () =>");
    expect(sourceCode).toContain("for (let i = compensationStack.length - 1; i >= 0; i--)");
    expect(sourceCode).toContain("await progress(");
    expect(sourceCode).toContain("await logger.info(");
  });

  it("should diagnose and repair missing later operations and outputs in contract plan", () => {
    const contract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "command:git status --porcelain", toolClass: "vcs", commandProfile: "git status --porcelain" },
        { id: "op_1", order: 1, name: "command:git diff --stat", toolClass: "vcs", commandProfile: "git diff --stat" },
        { id: "op_2", order: 2, name: "command:git log --oneline -5", toolClass: "vcs", commandProfile: "git log --oneline -5" },
        { id: "op_3", order: 3, name: "tool:read_file", toolClass: "file_read" },
      ],
      requiredInputs: [
        { name: "targetRepo", type: "string", description: "Target repo", required: true },
      ],
      outputRequirements: [
        { name: "op0_command_git_status_porcelain_result", sourceOperationId: "op_0", type: "object", required: true, description: "Output of op0" },
        { name: "op1_command_git_diff_stat_result", sourceOperationId: "op_1", type: "object", required: true, description: "Output of op1" },
        { name: "op2_command_git_log_oneline_5_result", sourceOperationId: "op_2", type: "object", required: true, description: "Output of op2" },
        { name: "op3_tool_read_file_result", sourceOperationId: "op_3", type: "object", required: true, description: "Output of op3" },
      ],
      invariants: ["ordering: sequential op_0->op_3 must execute in observed order"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };

    const opp = createMockOpportunity({
      classification: {
        title: "Git Audit",
        description: "Audits git and file",
        taskClass: "multi_step",
        pattern: "vcs -> vcs -> vcs -> file_read",
        confidenceScore: 0.95,
        priority: "high",
        workflowContract: contract,
      },
    });
    const basePlan = planner.plan(opp);
    // Simulate plan missing later operations and outputs (only first 2 ops)
    const plan = {
      ...basePlan,
      workflowContract: contract,
      steps: basePlan.steps.filter((s) => s.coveredOperationIds?.includes("op_0") || s.coveredOperationIds?.includes("op_1")),
      outputSchema: {
        type: "object",
        properties: {
          op0_command_git_status_porcelain_result: { type: "object", description: "Output of op0" },
          op1_command_git_diff_stat_result: { type: "object", description: "Output of op1" },
          success: { type: "boolean" },
          data: { type: "object" },
        },
        description: "Execution output",
      },
    } as unknown as typeof basePlan;
    // Ensure initial validation fails due to coverage
    const initialValidation = workflowGen.validateWorkflow(plan);
    expect(initialValidation.valid).toBe(false);
    const initialCoverage = buildWorkflowCoverage(contract, plan.steps, plan.outputSchema);
    expect(initialCoverage.uncoveredOperationIds).toEqual(expect.arrayContaining(["op_2", "op_3"]));
    expect(initialCoverage.uncoveredOutputNames).toEqual(expect.arrayContaining(["op2_command_git_log_oneline_5_result", "op3_tool_read_file_result"]));
    const diags = workflowCoverageDiagnostics(initialCoverage);
    expect(diags.some((d) => d.includes("op_2"))).toBe(true);
    expect(diags.some((d) => d.includes("op_3"))).toBe(true);

    // Repair should add exact missing coverage
    const result = workflowGen.repairWorkflow(plan, [], undefined, 5);
    expect(result.repaired).toBe(true);
    expect(result.remainingErrors).toBeUndefined();
    expect(result.appliedFixes.some((f) => f.includes("op_2"))).toBe(true);
    expect(result.appliedFixes.some((f) => f.includes("op_3"))).toBe(true);
    // Check exact missing operations were added
    const repairedCoverage = buildWorkflowCoverage(contract, result.plan.steps, result.plan.outputSchema);
    expect(repairedCoverage.uncoveredOperationIds).toHaveLength(0);
    expect(repairedCoverage.uncoveredOutputNames).toHaveLength(0);
    expect(repairedCoverage.complete).toBe(true);
    expect(result.plan.steps.some((s) => s.coveredOperationIds?.includes("op_2"))).toBe(true);
    expect(result.plan.steps.some((s) => s.coveredOperationIds?.includes("op_3"))).toBe(true);
    // Output schema now contains missing outputs
    const props = result.plan.outputSchema.properties as Record<string, unknown>;
    const dataProps = (props.data as Record<string, unknown> | undefined)?.properties as Record<string, unknown> | undefined;
    const hasOp2 = !!(props["op2_command_git_log_oneline_5_result"] || dataProps?.["op2_command_git_log_oneline_5_result"]);
    const hasOp3 = !!(props["op3_tool_read_file_result"] || dataProps?.["op3_tool_read_file_result"]);
    expect(hasOp2).toBe(true);
    expect(hasOp3).toBe(true);
    // Coverage persisted
    expect(result.plan.workflowCoverage).toBeDefined();
    expect(result.plan.workflowCoverage!.complete).toBe(true);
    // No warnings, only errors repaired
    const finalValidation = workflowGen.validateWorkflow(result.plan);
    expect(finalValidation.valid).toBe(true);
    expect(workflowCoverageDiagnostics(repairedCoverage)).toHaveLength(0);
  });

  it("should remain failed when maxIterations exhausted and coverage incomplete", () => {
    const contract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "command:git status --porcelain", toolClass: "vcs", commandProfile: "git status --porcelain" },
        { id: "op_1", order: 1, name: "command:git diff --stat", toolClass: "vcs", commandProfile: "git diff --stat" },
        { id: "op_2", order: 2, name: "command:git log --oneline -5", toolClass: "vcs", commandProfile: "git log --oneline -5" },
        { id: "op_3", order: 3, name: "tool:read_file", toolClass: "file_read" },
      ],
      requiredInputs: [{ name: "targetRepo", type: "string", description: "Target repo", required: true }],
      outputRequirements: [
        { name: "op0_command_git_status_porcelain_result", sourceOperationId: "op_0", type: "object", required: true, description: "Output of op0" },
        { name: "op1_command_git_diff_stat_result", sourceOperationId: "op_1", type: "object", required: true, description: "Output of op1" },
        { name: "op2_command_git_log_oneline_5_result", sourceOperationId: "op_2", type: "object", required: true, description: "Output of op2" },
        { name: "op3_tool_read_file_result", sourceOperationId: "op_3", type: "object", required: true, description: "Output of op3" },
      ],
      invariants: ["ordering: sequential op_0->op_3"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const opp = createMockOpportunity({
      classification: { title: "Git Audit", description: "Audit", taskClass: "multi_step", pattern: "vcs -> vcs -> vcs -> file_read", confidenceScore: 0.95, priority: "high", workflowContract: contract },
    });
    const basePlan = planner.plan(opp);
    const plan = {
      ...basePlan,
      workflowContract: contract,
      steps: basePlan.steps.filter((s) => s.coveredOperationIds?.includes("op_0")),
      outputSchema: {
        type: "object",
        properties: {
          op0_command_git_status_porcelain_result: { type: "object", description: "Output of op0" },
          success: { type: "boolean" },
          data: { type: "object" },
        },
        description: "Execution output",
      },
    } as unknown as typeof basePlan;

    // With maxIterations 1, only one operation and one output can be fixed per iteration, so 3 missing ops + 3 missing outputs need >1 iterations
    const result = workflowGen.repairWorkflow(plan, [], undefined, 1);
    expect(result.repaired).toBe(false);
    expect(result.remainingErrors).toBeDefined();
    expect(result.remainingErrors!.length).toBeGreaterThan(0);
    // Still has missing coverage diagnostics
    const coverageAfter = buildWorkflowCoverage(contract, result.plan.steps, result.plan.outputSchema);
    expect(coverageAfter.complete).toBe(false);
    expect(coverageAfter.uncoveredOperationIds.length).toBeGreaterThan(0);
    expect(workflowCoverageDiagnostics(coverageAfter).length).toBeGreaterThan(0);
    // Not all missing ops were added due to iteration bound
    expect(result.iterations).toBe(1);
  });

  it("should retain legacy repair behavior for plans without workflowContract", () => {
    const opp = createMockOpportunity({
      classification: { title: "Legacy Workflow", description: "Legacy", taskClass: "multi_step", pattern: "file_read -> file_edit -> command", confidenceScore: 0.9, priority: "medium" },
    });
    const plan = planner.plan(opp);
    // Introduce a cycle to trigger legacy repair
    const cyclicPlan = JSON.parse(JSON.stringify(plan)) as typeof plan;
    if (cyclicPlan.steps.length >= 2) {
      cyclicPlan.steps[0].dependsOn = [cyclicPlan.steps[1]!.id];
      cyclicPlan.steps[1]!.dependsOn = [cyclicPlan.steps[0].id];
    }
    const result = workflowGen.repairWorkflow(cyclicPlan, [], undefined, 3);
    // Legacy cycle repair should still work and not be affected by coverage
    expect(result.appliedFixes.some((f) => f.toLowerCase().includes("cyclic") || f.toLowerCase().includes("dependency"))).toBe(true);
    // No contract, so no coverage persisted
    expect(result.plan.workflowContract).toBeUndefined();
    expect(result.plan.workflowCoverage).toBeUndefined();
  });
});
