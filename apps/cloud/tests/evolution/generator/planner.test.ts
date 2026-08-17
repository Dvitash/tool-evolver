import { describe, expect, it } from "vitest";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import { createMockEnvelope, createMockOpportunity } from "./helpers.js";

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
      },
    });

    const plan = planner.plan(opp);

    expect(plan.targetType).toBe("single_tool");
    expect(plan.name).toBe("git_status_check");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].action).toBe("cmd.exec");
    expect(plan.steps[0].toolClass).toBe("command");
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
        inferredInputs: [{ name: "command", type: "string", description: "Command to run" }],
      },
    });

    const plan = planner.plan(opp, { envelope });

    expect(plan.capabilityRequirements.command.allowShellExecution).toBe(false);
  });
});
