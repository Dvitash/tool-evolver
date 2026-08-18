import { describe, expect, it } from "vitest";
import { CodeGenerator } from "../../../src/evolution/generator/code-generator.js";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import { createMockOpportunity } from "./helpers.js";

describe("CodeGenerator", () => {
  const planner = new CandidatePlanner();
  const codeGen = new CodeGenerator();

  it("should generate TypeScript source for a pure compute tool", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Compute Statistical Distribution",
        description: "Computes summary statistics on numerical arrays",
        taskClass: "compute",
        pattern: "compute",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "compute_statistics",
        inferredInputs: [{ name: "values", type: "array", description: "Array of numbers" }],
      },
    });

    const plan = planner.plan(opp, { targetType: "single_tool" });
    const source = codeGen.generateSource(plan);

    expect(source).toContain(
      'import { defineTool, type ToolContext } from "@tool-evolver/runtime";',
    );
    expect(source).toContain('import { z } from "zod";');
    expect(source).toContain("export const InputSchema =");
    expect(source).toContain("export const OutputSchema =");
    expect(source).toContain("export default defineTool<ToolInput, ToolOutput>(");
    expect(source).toContain("await progress(0,");
    expect(source).toContain("await logger.info(");
    expect(source).toContain("success: true");
  });

  it("should generate TypeScript source for a filesystem read tool", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Read Workspace File",
        description: "Reads file content from workspace",
        taskClass: "file_read",
        pattern: "file_read",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "read_workspace_file",
        inferredInputs: [{ name: "path", type: "string", description: "Target file path" }],
      },
    });

    const plan = planner.plan(opp, { targetType: "single_tool" });
    const source = codeGen.generateSource(plan);

    expect(source).toContain('await broker.fs.readFile(filePath, "utf-8");');
  });

  it("should generate TypeScript source for a filesystem write tool", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Write Configuration",
        description: "Writes configuration to disk",
        taskClass: "file_edit",
        pattern: "file_edit",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "write_config",
        inferredInputs: [
          { name: "path", type: "string", description: "Target file path" },
          { name: "content", type: "string", description: "File content" },
        ],
      },
    });

    const plan = planner.plan(opp, { targetType: "single_tool" });
    const source = codeGen.generateSource(plan);

    expect(source).toContain("await broker.fs.writeFile(filePath, content);");
  });

  it("should generate TypeScript source for a command execution tool", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Run Git Command",
        description: "Executes git commands",
        taskClass: "command",
        pattern: "command",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "run_git_command",
        inferredInputs: [{ name: "command", type: "string", description: "Command to execute" }],
      },
    });

    const plan = planner.plan(opp, { targetType: "single_tool" });
    const source = codeGen.generateSource(plan);

    expect(source).toContain("await broker.cmd.exec(command, args);");
    expect(source).toContain("if (res.exitCode !== 0)");
    expect(source).toContain("failed with exit code");
  });

  it("should generate TypeScript source for a network tool", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Fetch Remote Schema",
        description: "Fetches remote JSON schema over HTTPS",
        taskClass: "network",
        pattern: "net.fetch",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "fetch_remote_schema",
        inferredInputs: [{ name: "url", type: "string", description: "Remote URL" }],
      },
    });

    const plan = planner.plan(opp, { targetType: "single_tool" });
    const source = codeGen.generateSource(plan);

    expect(source).toContain("await broker.net.fetch(url);");
    expect(source).toContain("await response.json();");
  });
});
