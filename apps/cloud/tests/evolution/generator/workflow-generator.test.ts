import { describe, expect, it } from "vitest";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import { WorkflowStep } from "../../../src/evolution/generator/types.js";
import { WorkflowGenerator } from "../../../src/evolution/generator/workflow-generator.js";
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

    expect(sourceCode).toContain("import { defineTool, type ToolContext } from \"@tool-evolver/runtime\";");
    expect(sourceCode).toContain("export const InputSchema =");
    expect(sourceCode).toContain("export const OutputSchema =");
    expect(sourceCode).toContain("export default defineTool<ToolInput, ToolOutput>(");
    expect(sourceCode).toContain("const compensationStack: Array<() => Promise<void>> = [];");
    expect(sourceCode).toContain("compensationStack.push(async () =>");
    expect(sourceCode).toContain("for (let i = compensationStack.length - 1; i >= 0; i--)");
    expect(sourceCode).toContain("await progress(");
    expect(sourceCode).toContain("await logger.info(");
  });
});
