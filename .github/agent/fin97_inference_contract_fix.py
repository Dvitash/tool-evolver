from pathlib import Path
import re


def edit(path: str, transform):
    p = Path(path)
    source = p.read_text()
    updated = transform(source)
    if updated == source:
        raise SystemExit(f"no change made to {path}")
    p.write_text(updated)


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        if new in source:
            return source
        raise SystemExit(f"missing marker: {label}")
    return source.replace(old, new, 1)


# Structured schema inference may enrich observed inputs, but it cannot invent new
# authority-bearing parameters or change their deterministic types/requiredness.
def patch_schema_generator(source: str) -> str:
    old = '''      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];

      for (const param of parsed.parameters) {
        properties[param.name] = {
          type: param.type,
          description: param.description,
          ...(param.defaultValue !== undefined ? { default: param.defaultValue } : {}),
          ...(param.enumValues ? { enum: param.enumValues } : {}),
        };
        if (param.required) {
          required.push(param.name);
        }
      }

      for (const obs of options.variableInputs) {
        if (!properties[obs.name]) {
          properties[obs.name] = {
            type: obs.type,
            description: obs.description,
            ...(obs.defaultValue !== undefined ? { default: obs.defaultValue } : {}),
          };
          if (obs.required) {
            required.push(obs.name);
          }
        }
      }'''
    new = '''      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];
      const inferredByName = new Map(parsed.parameters.map((param) => [param.name, param]));

      for (const observed of options.variableInputs) {
        const inferred = inferredByName.get(observed.name);
        properties[observed.name] = {
          type: observed.type,
          description: inferred?.description || observed.description,
          ...(observed.defaultValue !== undefined ? { default: observed.defaultValue } : {}),
          ...(inferred?.enumValues ? { enum: inferred.enumValues } : {}),
        };
        if (observed.required) required.push(observed.name);
      }'''
    return replace_once(source, old, new, "schema authority intersection")


edit("apps/cloud/src/evolution/generator/schema-generator.ts", patch_schema_generator)


# Explicit broker service/action/class always wins over incidental words in a model
# description. Lexical heuristics are only a fallback for otherwise-untyped compute plans.
def patch_code_generator(source: str) -> str:
    source = replace_once(
        source,
        '''      toolClass === "file_edit" ||
      name.includes("file") ||
      name.includes("read") ||
      name.includes("write") ||
      desc.includes("file")''',
        '''      toolClass === "file_edit" ||
      ((service === "" || service === "compute") &&
        !action.startsWith("cmd.") &&
        !action.startsWith("net.") &&
        (name.includes("file") ||
          name.includes("read") ||
          name.includes("write") ||
          desc.includes("file")))''',
        "filesystem lexical precedence",
    )
    source = replace_once(
        source,
        '''      name.includes("fetch") ||
      name.includes("http") ||
      name.includes("api") ||
      desc.includes("api")''',
        '''      ((service === "" || service === "compute") &&
        !action.startsWith("cmd.") &&
        (name.includes("fetch") ||
          name.includes("http") ||
          name.includes("api") ||
          desc.includes("api")))''',
        "network lexical precedence",
    )
    return source


edit("apps/cloud/src/evolution/generator/code-generator.ts", patch_code_generator)


# Make the OpenAI-compatible process fixture honor response_format.json_schema.name.
# This ensures the real-process path tests structured inference rather than accidental
# substring routing and deterministic fallback.
def patch_mock_inference(source: str) -> str:
    start_marker = '''          // Deterministically generate tool candidate or structured response
          const isOpportunity =
            promptText.includes("opportunity") || promptText.includes("analyze");
          const isTestSynthesis = promptText.includes("test") || promptText.includes("spec");

          let assistantContent = "";
          if (isOpportunity) {'''
    end_marker = '''          const responsePayload = {'''
    start = source.find(start_marker)
    end = source.find(end_marker, start)
    if start < 0 or end < 0:
        if "const schemaName =" in source and "tool_synthesis" in source:
            return source
        raise SystemExit("mock inference routing region not found")

    replacement = '''          const responseFormat = parsedObj.response_format as
            | { json_schema?: { name?: string } }
            | undefined;
          const schemaName = responseFormat?.json_schema?.name ?? "";

          const parseJsonSection = (label: string): Record<string, unknown> | undefined => {
            const marker = `${label}:`;
            const markerIndex = promptText.indexOf(marker);
            if (markerIndex < 0) return undefined;
            const tail = promptText.slice(markerIndex + marker.length);
            const firstBrace = tail.indexOf("{");
            if (firstBrace < 0) return undefined;
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let index = firstBrace; index < tail.length; index++) {
              const char = tail[index]!;
              if (inString) {
                if (escaped) escaped = false;
                else if (char === "\\\\") escaped = true;
                else if (char === '"') inString = false;
                continue;
              }
              if (char === '"') inString = true;
              else if (char === "{") depth++;
              else if (char === "}") {
                depth--;
                if (depth === 0) {
                  try {
                    return JSON.parse(tail.slice(firstBrace, index + 1)) as Record<string, unknown>;
                  } catch {
                    return undefined;
                  }
                }
              }
            }
            return undefined;
          };

          let structuredOutput: Record<string, unknown>;
          if (schemaName.includes("opportunity_detection")) {
            structuredOutput = {
              opportunities: [
                {
                  id: "opp_http_001",
                  title: "Inspect Git Working Tree Status",
                  description: "Repeated immutable git status inspection workflow.",
                  taskClass: "vcs",
                  pattern: "vcs_git_status_porcelain",
                  confidenceScore: 0.95,
                  evidence: ["repeated sessions"],
                  priority: "high",
                },
              ],
            };
          } else if (schemaName.includes("candidate_planning")) {
            const classification = parseJsonSection("Classification");
            structuredOutput = {
              planId: "plan_http_001",
              targetToolName:
                (classification?.suggestedToolName as string | undefined) ?? "git_status_checker",
              action: "create",
              summary: "Create a tool from the persisted deterministic opportunity.",
              interfaceChanges: [],
              securityRisks: ["Command execution is restricted to the observed immutable profile."],
              estimatedImpact: "Eliminates a repeated multi-step workflow.",
              suggestedInputs: [],
            };
          } else if (schemaName.includes("schema_generation")) {
            const observedMatch = promptText.match(/Observed Variables:\\n(\\[[\\s\\S]*?\\])\\n/i);
            let observed: Array<Record<string, unknown>> = [];
            if (observedMatch?.[1]) {
              try {
                const parsedObserved = JSON.parse(observedMatch[1]);
                if (Array.isArray(parsedObserved)) observed = parsedObserved;
              } catch {
                observed = [];
              }
            }
            structuredOutput = {
              toolName: "git_status_checker",
              description: "Schema derived only from observed variables.",
              parameters: observed.map((value) => ({
                name: String(value.name ?? "input"),
                type: String(value.type ?? "string"),
                description: String(value.description ?? "Observed input"),
                required: value.required !== false,
              })),
              outputSchema: {
                type: "object",
                description: "Command execution result",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "object" },
                },
                required: ["success"],
              },
            };
          } else if (schemaName.includes("tool_synthesis")) {
            const specification = parseJsonSection("Specification") ?? {};
            const toolName = String(specification.name ?? "generated_tool");
            const description = String(specification.description ?? "Generated tool");
            const steps = Array.isArray(specification.steps)
              ? (specification.steps as Array<Record<string, unknown>>)
              : [];
            const commandStep = steps.find(
              (step) => step.service === "cmd" || String(step.action ?? "").startsWith("cmd."),
            );
            const stepInputs =
              commandStep?.inputs && typeof commandStep.inputs === "object"
                ? (commandStep.inputs as Record<string, unknown>)
                : {};
            const command = String(stepInputs.command ?? "git");
            const args = Array.isArray(stepInputs.args)
              ? stepInputs.args.filter((value): value is string => typeof value === "string")
              : [];
            const code = commandStep
              ? `import { defineTool, type ToolContext } from "@tool-evolver/runtime";\nimport { z } from "zod";\nexport const InputSchema = z.object({}).strict();\nexport const OutputSchema = z.object({ success: z.boolean(), data: z.record(z.unknown()).optional() }).strict();\ntype ToolInput = z.infer<typeof InputSchema>;\ntype ToolOutput = z.infer<typeof OutputSchema>;\nexport default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {\n  const { broker, logger, progress } = context;\n  await progress(0, "Starting execution");\n  await logger.info("Executing tool", { toolName: ${JSON.stringify(toolName)} });\n  const result = await broker.cmd.exec(${JSON.stringify(command)}, ${JSON.stringify(args)});\n  if (result.exitCode !== 0) throw new Error(\`Command failed with exit code \\${result.exitCode}: \\${result.stderr}\`);\n  await progress(100, "Execution finished", "complete");\n  return { success: true, data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } };\n});`
              : `import { defineTool, type ToolContext } from "@tool-evolver/runtime";\nimport { z } from "zod";\nexport const InputSchema = z.object({ input: z.unknown().optional() }).strict();\nexport const OutputSchema = z.object({ success: z.boolean(), data: z.record(z.unknown()).optional() }).strict();\ntype ToolInput = z.infer<typeof InputSchema>;\ntype ToolOutput = z.infer<typeof OutputSchema>;\nexport default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {\n  return { success: true, data: { input: context.input.input } };\n});`;
            structuredOutput = {
              toolId: `tool_${toolName}`,
              name: toolName,
              version: "1.0.0",
              description,
              schema: specification.inputSchema ?? { type: "object", properties: {} },
              code,
              runtimeRequirements: ["deno:runtime"],
            };
          } else if (schemaName.includes("test_generation")) {
            structuredOutput = {
              suiteId: "suite_http_001",
              targetTool: "generated_tool",
              unitTests: [
                {
                  name: "executes valid input",
                  description: "Validates the generated tool happy path.",
                  code: "Deno.test('executes', () => {});",
                },
              ],
              propertyTests: [],
              edgeCases: ["broker failure"],
            };
          } else if (schemaName.includes("tool_repair")) {
            structuredOutput = {
              toolId: "tool_repaired_http",
              name: "repaired_tool",
              version: "1.0.1",
              code: "",
              fixedIssues: [],
              explanation: "No repair supplied by deterministic HTTP fixture.",
            };
          } else {
            structuredOutput = { status: "success" };
          }

          const assistantContent = JSON.stringify(structuredOutput);

'''
    return source[:start] + replacement + source[end:]


edit("fixtures/e2e/src/process-harness.ts", patch_mock_inference)


# Regression coverage: inferred schemas cannot add an unobserved authority-bearing field.
def add_schema_test(source: str) -> str:
    marker = '''  describe("SchemaGenerator", () => {'''
    if marker not in source:
        # The current suite may not use nested describe; append a focused top-level case.
        addition = '''

describe("structured schema authority intersection", () => {
  it("ignores model-invented inputs that were not observed", async () => {
    const inferenceService = {
      infer: async () => ({
        output: {
          toolName: "safe_tool",
          description: "safe",
          parameters: [
            { name: "path", type: "string", description: "invented", required: true },
          ],
          outputSchema: { type: "object", properties: {} },
        },
        provenance: {},
      }),
    };
    const generator = new SchemaGenerator();
    const result = await generator.deriveSchemasAsync({
      toolName: "safe_tool",
      description: "safe",
      variableInputs: [],
      inferenceService: inferenceService as never,
    });
    expect(result.inputSchema.properties).toEqual({});
    expect(result.inputSchema.required).toEqual([]);
  });
});
'''
        if "structured schema authority intersection" not in source:
            return source + addition
        return source
    return source


edit("apps/cloud/tests/evolution/generator/schema-generator.test.ts", add_schema_test)

print("FIN-001 structured inference contracts aligned")
