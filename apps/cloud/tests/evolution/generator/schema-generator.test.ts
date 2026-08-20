import { describe, expect, it } from "vitest";
import { SchemaGenerator } from "../../../src/evolution/generator/schema-generator.js";
import type { VariableInputDefinition } from "../../../src/evolution/generator/types.js";

describe("SchemaGenerator", () => {
  const schemaGen = new SchemaGenerator();

  it("should derive MCP-compliant ToolParameterSchema with required and optional fields", () => {
    const inputs: VariableInputDefinition[] = [
      { name: "filePath", type: "string", description: "Target path", required: true },
      {
        name: "count",
        type: "number",
        description: "Max count",
        required: false,
        defaultValue: 10,
      },
      {
        name: "recursive",
        type: "boolean",
        description: "Recurse subdirectories",
        required: false,
      },
      { name: "tags", type: "array", description: "Tags list", required: true },
    ];

    const schema = schemaGen.deriveInputSchema(inputs);

    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["filePath", "tags"]);
    expect(schema.properties.filePath.type).toBe("string");
    expect(schema.properties.count.type).toBe("number");
    expect(schema.properties.count.default).toBe(10);
    expect(schema.properties.recursive.type).toBe("boolean");
    expect(schema.properties.tags.type).toBe("array");
  });

  it("should derive ToolOutputSchema with candidate output fields and intermediate step results", () => {
    const candidateOutput = {
      type: "object",
      properties: {
        totalLines: { type: "number" },
        matched: { type: "boolean" },
      },
    };

    const outputSchema = schemaGen.deriveOutputSchema(candidateOutput);

    expect(outputSchema.type).toBe("object");
    expect(outputSchema.properties?.totalLines).toBeDefined();
    expect(outputSchema.properties?.matched).toBeDefined();
  });

  it("should generate valid Zod source code for parameter schema", () => {
    const paramSchema = schemaGen.deriveInputSchema([
      { name: "query", type: "string", description: "Search query", required: true },
      {
        name: "limit",
        type: "number",
        description: "Max results",
        required: false,
        defaultValue: 50,
      },
    ]);

    const zodSource = schemaGen.generateZodSource(paramSchema);

    expect(zodSource).toContain("z.object(");
    expect(zodSource).toContain('"query": z.string()');
    expect(zodSource).toContain('"limit": z.number()');
    expect(zodSource).toContain(".default(50)");
    expect(zodSource).toContain(".strict()");
  });

  it("should generate valid Zod source code for output schema", () => {
    const outputSchema = schemaGen.deriveOutputSchema();
    const zodSource = schemaGen.generateOutputZodSource(outputSchema);

    expect(zodSource).toContain("z.object(");
    expect(zodSource).toContain('"success": z.boolean()');
    expect(zodSource).toContain(".strict()");
  });
});


describe("contract-aware schema generation - deterministic merge", () => {
  it("repairs missing required outputs omitted by model via deterministic merge", async () => {
    const contract = {
      version: 1 as const,
      operations: [
        { id: "op_0", order: 0, name: "search:find" },
        { id: "op_1", order: 1, name: "file_read:read" },
      ],
      requiredInputs: [
        { name: "query", type: "string", description: "search query", required: true },
      ],
      outputRequirements: [
        { name: "op0_search_result", sourceOperationId: "op_0", type: "object", required: true, description: "Search output" },
        { name: "op1_file_content", sourceOperationId: "op_1", type: "string", required: true, description: "File content" },
        { name: "final_summary", sourceOperationId: "op_1", type: "string", required: true, description: "Summary" },
      ],
      invariants: [],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    // Model omits final_summary and op1_file_content
    const inferenceService = {
      infer: async () => ({
        output: {
          toolName: "workflow_tool",
          description: "test",
          parameters: [{ name: "query", type: "string", description: "query", required: true }],
          outputSchema: {
            type: "object",
            description: "Result",
            properties: {
              op0_search_result: { type: "object", description: "inferred search" },
              // missing op1_file_content and final_summary
            },
            required: ["op0_search_result"],
          },
        },
        provenance: {},
      }),
    } as unknown as import("../../../src/models/service.js").InferenceService;
    const generator = new SchemaGenerator();
    const result = await generator.deriveSchemasAsync({
      toolName: "workflow_tool",
      description: "test",
      variableInputs: [{ name: "query", type: "string", description: "search query", required: true }],
      workflowContract: contract,
      inferenceService: inferenceService as never,
    });
    const dataProps = (result.outputSchema.properties?.data as any)?.properties as Record<string, unknown>;
    expect(dataProps.op0_search_result).toBeDefined();
    expect(dataProps.op1_file_content).toBeDefined();
    expect(dataProps.final_summary).toBeDefined();
    expect((dataProps.op1_file_content as any).type).toBe("string");
    // Required outputs are represented by property presence, not a `required` array
    expect((result.outputSchema as any).required).toBeUndefined();
  });

  it("conflicting inferred fields cannot erase required contract outputs and preserves contract requiredness", async () => {
    const contract = {
      version: 1 as const,
      operations: [{ id: "op_0", order: 0, name: "compute:transform" }],
      requiredInputs: [],
      outputRequirements: [
        { name: "must_have", sourceOperationId: "op_0", type: "string", required: true, description: "Required output" },
      ],
      invariants: [],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const inferenceService = {
      infer: async () => ({
        output: {
          toolName: "t",
          description: "d",
          parameters: [],
          outputSchema: {
            type: "object",
            description: "Result",
            properties: {
              must_have: { type: "number", description: "inferred as number - conflict" },
              extra_inferred: { type: "string", description: "extra" },
            },
            required: [], // model incorrectly omits required
          },
        },
        provenance: {},
      }),
    } as unknown as import("../../../src/models/service.js").InferenceService;
    const generator = new SchemaGenerator();
    const result = await generator.deriveSchemasAsync({
      toolName: "t",
      description: "d",
      variableInputs: [],
      workflowContract: contract,
      inferenceService: inferenceService as never,
    });
    const dataProps = (result.outputSchema.properties?.data as any)?.properties as Record<string, unknown>;
    // Must still have must_have and preserve inferred compatible schema (type number retained conservatively)
    expect(dataProps.must_have).toBeDefined();
    // Extra inferred field should remain (union)
    expect(dataProps.extra_inferred).toBeDefined();
    // Contract requiredness represented by property presence, conservative type preservation
    expect((dataProps.must_have as any).type).toBe("number");
    expect((result.outputSchema as any).required).toBeUndefined();
  });

  it("includes requiredInputs from contract even when variableInputs missing them", async () => {
    const contract = {
      version: 1 as const,
      operations: [{ id: "op_0", order: 0, name: "file_read:read" }],
      requiredInputs: [
        { name: "filePath", type: "string", description: "Target", required: true },
        { name: "encoding", type: "string", description: "Encoding", required: true },
      ],
      outputRequirements: [],
      invariants: [],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const inferenceService = {
      infer: async () => ({
        output: {
          toolName: "t",
          description: "d",
          parameters: [{ name: "filePath", type: "string", description: "inferred", required: true }],
          outputSchema: { type: "object", properties: {}, required: [] },
        },
        provenance: {},
      }),
    } as unknown as import("../../../src/models/service.js").InferenceService;
    const generator = new SchemaGenerator();
    const result = await generator.deriveSchemasAsync({
      toolName: "t",
      description: "d",
      variableInputs: [{ name: "filePath", type: "string", description: "Target", required: true }],
      workflowContract: contract,
      inferenceService: inferenceService as never,
    });
    expect(result.inputSchema.properties.filePath).toBeDefined();
    expect(result.inputSchema.properties.encoding).toBeDefined();
    expect(result.inputSchema.required).toEqual(expect.arrayContaining(["filePath", "encoding"]));
  });

  it("fallback without inference still merges contract outputs deterministically", () => {
    const contract = {
      version: 1 as const,
      operations: [{ id: "op_0", order: 0, name: "test:run" }],
      requiredInputs: [],
      outputRequirements: [
        { name: "test_result", sourceOperationId: "op_0", type: "object", required: true, description: "Test outcome" },
      ],
      invariants: [],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const generator = new SchemaGenerator();
    const out = generator.deriveOutputSchema(undefined, undefined, undefined, contract);
    const data = (out.properties?.data as any);
    expect(data.properties.test_result).toBeDefined();
    expect((out as any).required).toBeUndefined();
  });
});

describe("structured schema authority intersection", () => {
  it("ignores model-invented inputs that were not observed", async () => {
    const inferenceService = {
      infer: async () => ({
        output: {
          toolName: "safe_tool",
          description: "safe",
          parameters: [{ name: "path", type: "string", description: "invented", required: true }],
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
