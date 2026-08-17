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
    expect(new Date(prov.finishedAt).getTime()).toBeGreaterThanOrEqual(new Date(prov.createdAt).getTime());
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
    fakeProvider.setMockResponse(
      (req) => req.userMessage.includes("Analyze metric"),
      { transformedMetric: "normalized_cpu", score: 98.6 },
    );

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
