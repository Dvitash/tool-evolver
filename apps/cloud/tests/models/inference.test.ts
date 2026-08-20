import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FakeModelProvider,
  InferenceService,
  PromptRegistry,
  createInferenceService,
} from "../../src/models/index.js";

describe("Structured Inference Service & Provenance", () => {
  it("should execute schema-constrained inference returning validated output and complete provenance", async () => {
    const fakeProvider = new FakeModelProvider({ id: "mock-primary" });
    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const result = await service.infer({
      tenantId: "tenant-alpha",
      taskClass: "opportunity_detection",
      promptTemplateId: "opportunity_detection",
      inputs: {
        sessionId: "sess-12345",
        traceData: "Tool execution trace: read_file took 450ms, 12 repetitions",
        telemetrySummary: "Sequential read I/O latency spike detected",
      },
    });

    expect(result.requestId).toMatch(/^inf_/);
    expect(result.tenantId).toBe("tenant-alpha");
    expect(result.taskClass).toBe("opportunity_detection");
    expect(result.output).toBeDefined();
    expect(Array.isArray((result.output as any).opportunities)).toBe(true);
    expect((result.output as any).opportunities.length).toBeGreaterThan(0);

    const opportunity = (result.output as any).opportunities[0];
    expect(opportunity.id).toBeDefined();
    expect(opportunity.title).toBeDefined();
    expect(opportunity.confidenceScore).toBeGreaterThan(0);

    // Verify complete provenance
    const prov = result.provenance;
    expect(prov.requestId).toBe(result.requestId);
    expect(prov.tenantId).toBe("tenant-alpha");
    expect(prov.taskClass).toBe("opportunity_detection");
    expect(prov.providerId).toBe("mock-primary");
    expect(prov.providerName).toBe("Fake In-Memory Model Provider");
    expect(prov.promptTemplateId).toBe("opportunity_detection");
    expect(prov.promptTemplateVersion).toBe("1.0.0");
    expect(prov.promptDigest).toHaveLength(64);
    expect(prov.inputDigest).toHaveLength(64);
    expect(prov.schemaDigest).toHaveLength(64);
    expect(prov.cached).toBe(false);
    expect(prov.repairAttempts).toBe(0);
    expect(prov.usage.totalTokens).toBeGreaterThan(0);
    expect(prov.latencyMs).toBeGreaterThanOrEqual(0);
    expect(new Date(prov.createdAt).getTime()).toBeGreaterThan(0);
    expect(new Date(prov.finishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(prov.createdAt).getTime(),
    );
  });

  it("should support all 5 core task classes with default templates", async () => {
    const fakeProvider = new FakeModelProvider({ id: "mock-primary" });
    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const taskClasses = [
      {
        taskClass: "opportunity_detection" as const,
        templateId: "opportunity_detection",
        inputs: { sessionId: "s1", traceData: "trace", telemetrySummary: "summary" },
      },
      {
        taskClass: "candidate_planning" as const,
        templateId: "candidate_planning",
        inputs: { opportunityId: "opp-1", opportunityDetails: "details", currentManifest: "{}" },
      },
      {
        taskClass: "tool_synthesis" as const,
        templateId: "tool_synthesis",
        inputs: { planId: "plan-1", specification: "spec", existingCode: "// code" },
      },
      {
        taskClass: "test_generation" as const,
        templateId: "test_generation",
        inputs: { toolName: "tool-1", toolCode: "// code", toolSchema: "{}" },
      },
      {
        taskClass: "candidate_scoring" as const,
        templateId: "candidate_scoring",
        inputs: { candidateId: "cand-1", testResults: "all passed", benchmarkTelemetry: "{}" },
      },
    ];

    for (const item of taskClasses) {
      const response = await service.infer({
        tenantId: "tenant-core",
        taskClass: item.taskClass,
        promptTemplateId: item.templateId,
        inputs: item.inputs,
      });

      expect(response.taskClass).toBe(item.taskClass);
      expect(response.output).toBeDefined();
      expect(response.provenance.taskClass).toBe(item.taskClass);
    }
  });

  it("should support custom prompt templates and custom Zod output schemas", async () => {
    const registry = new PromptRegistry();
    const CustomSchema = z.object({
      transformedMetric: z.string(),
      score: z.number(),
    });

    registry.register({
      id: "custom_analyzer",
      version: "2.1.0",
      taskClass: "opportunity_detection",
      description: "Custom analyzer template",
      systemInstruction: "You are a custom metric transformer.",
      userTemplate: "Analyze metric {{metricName}} with value {{metricValue}}",
      outputSchema: CustomSchema,
    });

    const fakeProvider = new FakeModelProvider({ id: "mock-custom" });
    fakeProvider.setMockResponse((req) => req.userMessage.includes("Analyze metric"), {
      transformedMetric: "normalized_cpu",
      score: 98.6,
    });

    const service = createInferenceService({ promptRegistry: registry });
    service.router.registerProvider(fakeProvider);

    const result = await service.infer({
      tenantId: "tenant-custom",
      taskClass: "opportunity_detection",
      promptTemplateId: "custom_analyzer",
      promptTemplateVersion: "2.1.0",
      inputs: {
        metricName: "raw_cpu_usage",
        metricValue: "99.4%",
      },
      schema: CustomSchema,
    });

    expect(result.output).toEqual({
      transformedMetric: "normalized_cpu",
      score: 98.6,
    });
    expect(result.provenance.promptTemplateId).toBe("custom_analyzer");
    expect(result.provenance.promptTemplateVersion).toBe("2.1.0");
  });
});
describe("Contract-aware prompt generation and legacy compatibility", () => {
  it("schema_generation prompt includes every operation and required output when workflowContract provided", async () => {
    const registry = new PromptRegistry();
    const template = registry.get("schema_generation", "1.0.0");
    expect(template).toBeDefined();
    // contract with 2 ops and 2 outputs
    const workflowContract = {
      version: 1 as const,
      operations: [
        { id: "op_0", order: 0, name: "search:find", toolClass: "search" as const, commandProfile: "grep -r" },
        { id: "op_1", order: 1, name: "file_read:read", toolClass: "file_read" as const },
      ],
      requiredInputs: [
        { name: "query", type: "string", description: "search query", required: true },
        { name: "path", type: "string", description: "path", required: true },
      ],
      outputRequirements: [
        { name: "search_hits", sourceOperationId: "op_0", type: "array", required: true, description: "hits" },
        { name: "file_content", sourceOperationId: "op_1", type: "string", required: true, description: "content" },
      ],
      invariants: [],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const rendered = registry.render(template!, {
      toolName: "test_tool",
      description: "Test workflow",
      workflowEvidence: "evidence",
      observedVariables: JSON.stringify([{ name: "query", type: "string", description: "query", required: true }]),
      workflowContract: JSON.stringify(workflowContract),
      workflowOperations: JSON.stringify(workflowContract.operations),
      workflowOutputs: JSON.stringify(workflowContract.outputRequirements),
      workflowInputs: JSON.stringify(workflowContract.requiredInputs),
    } as any);
    // Must contain every operation name/id and every output name
    expect(rendered.userMessage).toContain("op_0");
    expect(rendered.userMessage).toContain("search:find");
    expect(rendered.userMessage).toContain("op_1");
    expect(rendered.userMessage).toContain("file_read:read");
    expect(rendered.userMessage).toContain("search_hits");
    expect(rendered.userMessage).toContain("file_content");
    // Also system instruction must demand coverage
    expect(template!.systemInstruction).toMatch(/WorkflowContract/);
    expect(template!.systemInstruction).toMatch(/required/i);
  });

  it("candidate_planning prompt includes every operation/output and enumerates coverage", async () => {
    const registry = new PromptRegistry();
    const template = registry.get("candidate_planning", "1.0.0");
    expect(template).toBeDefined();
    const workflowContract = {
      version: 1 as const,
      operations: [
        { id: "op_0", order: 0, name: "file_write:write" },
        { id: "op_1", order: 1, name: "command:exec" },
      ],
      requiredInputs: [{ name: "content", type: "string", description: "content", required: true }],
      outputRequirements: [
        { name: "write_status", sourceOperationId: "op_0", type: "boolean", required: true, description: "write" },
        { name: "exec_output", sourceOperationId: "op_1", type: "string", required: true, description: "exec" },
      ],
      invariants: [],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const rendered = registry.render(template!, {
      opportunityId: "opp-1",
      classification: JSON.stringify({ title: "Test", pattern: "file_write->command" }),
      opportunityDetails: "details",
      evidence: JSON.stringify(["e1"]),
      currentManifest: "{}",
      workflowContract: JSON.stringify(workflowContract),
      workflowOperations: JSON.stringify(workflowContract.operations),
      workflowOutputs: JSON.stringify(workflowContract.outputRequirements),
    } as any);
    expect(rendered.userMessage).toContain("op_0");
    expect(rendered.userMessage).toContain("file_write:write");
    expect(rendered.userMessage).toContain("exec_output");
    expect(rendered.userMessage).toContain("write_status");
    expect(template!.systemInstruction).toMatch(/coveredOperationIds/);
    expect(template!.systemInstruction).toMatch(/coverageRationale/);
  });

  it("legacy prompts without workflowContract remain valid and render without leftover placeholders", async () => {
    const registry = new PromptRegistry();
    const schemaTemplate = registry.get("schema_generation", "1.0.0")!;
    const candidateTemplate = registry.get("candidate_planning", "1.0.0")!;
    // Legacy render without workflowContract should not throw and not leave {{workflowContract}}
    const renderedSchema = registry.render(schemaTemplate, {
      toolName: "legacy_tool",
      description: "legacy",
      workflowEvidence: "evidence",
      observedVariables: "[]",
    } as any);
    expect(renderedSchema.userMessage).not.toContain("{{workflowContract}}");
    expect(renderedSchema.userMessage).toContain("legacy_tool");

    const renderedCandidate = registry.render(candidateTemplate, {
      opportunityId: "opp-legacy",
      classification: "{}",
      opportunityDetails: "details",
      evidence: "[]",
      currentManifest: "{}",
    } as any);
    expect(renderedCandidate.userMessage).not.toContain("{{workflowContract}}");
    expect(renderedCandidate.userMessage).toContain("opp-legacy");
  });

  it("legacy inference output schemas remain valid with new optional contract fields", async () => {
    const { SchemaGenerationOutputSchema, CandidatePlanningOutputSchema } = await import("../../src/models/prompt-registry.js");
    const legacySchemaGen = {
      toolName: "t",
      description: "d",
      parameters: [{ name: "p", type: "string" as const, description: "x", required: true }],
      outputSchema: { type: "object", description: "d", properties: {}, required: [] },
      // no coveredOutputNames
    };
    expect(() => SchemaGenerationOutputSchema.parse(legacySchemaGen)).not.toThrow();
    const legacyCandidate = {
      planId: "p1",
      targetToolName: "t",
      action: "create" as const,
      summary: "s",
      interfaceChanges: [],
      securityRisks: [],
      estimatedImpact: "low",
      // no coverageRationale or coveredOperationIds
    };
    expect(() => CandidatePlanningOutputSchema.parse(legacyCandidate)).not.toThrow();
    const withCoverage = {
      ...legacyCandidate,
      coverageRationale: "covers all ops",
      coveredOperationIds: ["op_0", "op_1"],
    };
    expect(() => CandidatePlanningOutputSchema.parse(withCoverage)).not.toThrow();
    const schemaWithCoverage = {
      ...legacySchemaGen,
      coveredOutputNames: ["out1", "out2"],
    };
    expect(() => SchemaGenerationOutputSchema.parse(schemaWithCoverage)).not.toThrow();
    expect(SchemaGenerationOutputSchema.parse(schemaWithCoverage).coveredOutputNames).toEqual(["out1", "out2"]);
  });

  it("SchemaGenerator includes workflowContract in inference prompt inputs and preserves strict validation", async () => {
    const registry = new PromptRegistry();
    const template = registry.get("schema_generation", "1.0.0")!;
    const workflowContract = {
      version: 1 as const,
      operations: [{ id: "op_0", order: 0, name: "tool:compute" }],
      requiredInputs: [{ name: "inputA", type: "string", description: "A", required: true }],
      outputRequirements: [{ name: "outputA", sourceOperationId: "op_0", type: "string", required: true, description: "out" }],
      invariants: [],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    let capturedInputs: any = null;
    const fakeInfer = {
      infer: async (req: any) => {
        capturedInputs = req.inputs;
        return {
          output: {
            toolName: req.inputs.toolName,
            description: req.inputs.description,
            parameters: [{ name: "inputA", type: "string", description: "inferred", required: true }],
            outputSchema: {
              type: "object",
              description: "Res",
              properties: { outputA: { type: "string", description: "out" } },
              required: ["outputA"],
            },
          },
          provenance: { requestId: "r", tenantId: req.tenantId, taskClass: req.taskClass, providerId: "mock", providerName: "Mock", promptTemplateId: req.promptTemplateId, promptTemplateVersion: "1.0.0", promptDigest: "a".repeat(64), inputDigest: "b".repeat(64), schemaDigest: "c".repeat(64), cached: false, repairAttempts: 0, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
        };
      },
    } as unknown as import("../../src/models/service.js").InferenceService;

    const { SchemaGenerator } = await import("../../src/evolution/generator/schema-generator.js");
    const gen = new SchemaGenerator();
    await gen.deriveSchemasAsync({
      toolName: "workflow_tool",
      description: "desc",
      variableInputs: [{ name: "inputA", type: "string", description: "A", required: true }],
      workflowContract,
      inferenceService: fakeInfer as never,
    });
    expect(capturedInputs).toBeDefined();
    expect(capturedInputs.workflowContract).toBeDefined();
    const parsedContract = JSON.parse(capturedInputs.workflowContract);
    expect(parsedContract.operations[0].id).toBe("op_0");
    expect(capturedInputs.workflowOperations).toContain("op_0");
    expect(capturedInputs.workflowOutputs).toContain("outputA");
    // Ensure strict validation would fail on missing required fields but passes with optional
    expect(() => registry.render(template, capturedInputs as any)).not.toThrow();
  });
});
