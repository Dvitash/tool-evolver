import { describe, expect, it } from "vitest";
import { SchemaGenerator } from "../../../src/evolution/generator/schema-generator.js";
import { VariableInputDefinition } from "../../../src/evolution/generator/types.js";

describe("SchemaGenerator", () => {
  const schemaGen = new SchemaGenerator();

  it("should derive MCP-compliant ToolParameterSchema with required and optional fields", () => {
    const inputs: VariableInputDefinition[] = [
      { name: "filePath", type: "string", description: "Target path", required: true },
      { name: "count", type: "number", description: "Max count", required: false, defaultValue: 10 },
      { name: "recursive", type: "boolean", description: "Recurse subdirectories", required: false },
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
      { name: "limit", type: "number", description: "Max results", required: false, defaultValue: 50 },
    ]);

    const zodSource = schemaGen.generateZodSource(paramSchema);

    expect(zodSource).toContain("z.object(");
    expect(zodSource).toContain("\"query\": z.string()");
    expect(zodSource).toContain("\"limit\": z.number()");
    expect(zodSource).toContain(".default(50)");
    expect(zodSource).toContain(".strict()");
  });

  it("should generate valid Zod source code for output schema", () => {
    const outputSchema = schemaGen.deriveOutputSchema();
    const zodSource = schemaGen.generateOutputZodSource(outputSchema);

    expect(zodSource).toContain("z.object(");
    expect(zodSource).toContain("\"success\": z.boolean()");
    expect(zodSource).toContain(".strict()");
  });
});
