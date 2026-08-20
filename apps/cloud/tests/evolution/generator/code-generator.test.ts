import { describe, expect, it } from "vitest";
import { CodeGenerator } from "../../../src/evolution/generator/code-generator.js";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import type { InferenceService } from "../../../src/models/service.js";
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

    expect(source).toContain('broker.fs.readFile');
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

    expect(source).toContain('broker.fs.writeFile');
  });

  it("should generate TypeScript source for a command execution tool", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Run Git Command",
        description: "Executes the observed immutable git status command profile",
        taskClass: "command",
        pattern: "command",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "run_git_command",
        commandProfiles: ["git status --porcelain"],
        inferredInputs: [{ name: "command", type: "string", description: "Command to execute" }],
      },
    });

    const plan = planner.plan(opp, { targetType: "single_tool" });
    const source = codeGen.generateSource(plan);

    expect(source).toContain("await broker.cmd.exec(command, args);");
    expect(source).toContain('const command = "git";');
    expect(source).toContain('const args = ["status","--porcelain"];');
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

  it("retries on gate failure with feedback and succeeds on attempt 2", async () => {
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

    const calls: Array<{ promptTemplateId: string; inputs: Record<string, unknown> }> = [];
    let callCount = 0;
    const fakeInferenceService = {
      infer: async (req: { promptTemplateId: string; inputs: Record<string, unknown> }) => {
        calls.push(req);
        callCount++;
        if (callCount === 1) {
          return {
            output: {
              toolId: "tool_test",
              name: "fetch_remote_schema",
              version: "1.0.0",
              description: "test",
              schema: {},
              code: "function run() { return 42; }",
              runtimeRequirements: [],
            },
            provenance: {},
          };
        }
        return {
          output: {
            toolId: "tool_test",
            name: "fetch_remote_schema",
            version: "1.0.0",
            description: "test",
            schema: {},
            code: `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";
export const InputSchema = z.object({ url: z.string() });
export const OutputSchema = z.object({ data: z.unknown() });
export default defineTool(async (context: ToolContext<any>) => {
  const res = await context.broker.net.fetch(context.input.url);
  const data = await res.json();
  return { success: true, data };
});`,
            runtimeRequirements: [],
          },
          provenance: {},
        };
      },
    } as unknown as InferenceService;

    const result = await codeGen.generateSourceAsync(plan, {
      inferenceService: fakeInferenceService,
      allowDeterministicFallback: false,
    });

    expect(result.sourceCode).toContain("export default defineTool");
    expect(calls.length).toBe(2);
    expect(calls[0].inputs.feedback).toBe("");
    expect(calls[1].inputs.feedback).toContain("markersMissing");
  });

  it("throws after 3 attempts on repeated gate failure", async () => {
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

    const calls: Array<{ promptTemplateId: string; inputs: Record<string, unknown> }> = [];
    const fakeInferenceService = {
      infer: async (req: { promptTemplateId: string; inputs: Record<string, unknown> }) => {
        calls.push(req);
        return {
          output: {
            toolId: "tool_test",
            name: "fetch_remote_schema",
            version: "1.0.0",
            description: "test",
            schema: {},
            code: "function run() { return 42; }",
            runtimeRequirements: [],
          },
          provenance: {},
        };
      },
    } as unknown as InferenceService;

    await expect(
      codeGen.generateSourceAsync(plan, {
        inferenceService: fakeInferenceService,
        allowDeterministicFallback: false,
      }),
    ).rejects.toThrow("capability-compatible tool source");

    expect(calls.length).toBe(3);
    expect(calls[0].inputs.feedback).toBe("");
    expect(calls[1].inputs.feedback).toContain("markersMissing");
    expect(calls[2].inputs.feedback).toContain("markersMissing");
  });
});
