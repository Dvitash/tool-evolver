import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FakeModelProvider,
  SchemaValidationExhaustedError,
  StructuredOutputValidator,
  createInferenceService,
} from "../../src/models/index.js";

describe("Bounded Output Validation & Self-Repair", () => {
  it("should successfully self-repair malformed JSON output on first repair attempt", async () => {
    const fakeProvider = new FakeModelProvider({ id: "repair-provider" });
    let executionCount = 0;

    fakeProvider.setMockResponse(
      () => true,
      (req) => {
        executionCount++;
        if (executionCount === 1) {
          // Initial response is broken JSON
          return "```json\n{ opportunities: [ { id: 'broken', title: missing quote ...\n```";
        }
        // Repaired response is valid JSON
        return {
          opportunities: [
            {
              id: "opp_repaired_01",
              title: "Fixed via bounded repair",
              description: "Repaired JSON structure",
              taskClass: "opportunity_detection",
              pattern: "malformed_json_fix",
              confidenceScore: 0.99,
              evidence: ["Repaired on attempt 1"],
              priority: "medium",
            },
          ],
        };
      },
    );

    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const result = await service.infer({
      tenantId: "tenant-repair",
      taskClass: "opportunity_detection",
      promptTemplateId: "opportunity_detection",
      inputs: {
        sessionId: "s1",
        traceData: "trace",
        telemetrySummary: "summary",
      },
    });

    expect(executionCount).toBe(2); // 1 initial + 1 repair
    expect(result.provenance.repairAttempts).toBe(1);
    expect((result.output as any).opportunities[0].id).toBe("opp_repaired_01");
  });

  it("should successfully self-repair schema violations on second repair attempt", async () => {
    const fakeProvider = new FakeModelProvider({ id: "repair-provider-2" });
    let executionCount = 0;

    fakeProvider.setMockResponse(
      () => true,
      (req) => {
        executionCount++;
        if (executionCount === 1) {
          // Invalid schema: missing required 'opportunities' array
          return { error: "something else", invalidStructure: true };
        }
        if (executionCount === 2) {
          // Invalid schema: opportunities exists but elements missing confidenceScore and priority
          return {
            opportunities: [
              { id: "opp_half", title: "Missing fields" },
            ],
          };
        }
        // Attempt 3 (2nd repair): valid schema
        return {
          opportunities: [
            {
              id: "opp_valid_02",
              title: "Fully valid schema",
              description: "Repaired on 2nd repair cycle",
              taskClass: "opportunity_detection",
              pattern: "schema_recovery",
              confidenceScore: 0.88,
              evidence: ["Valid output"],
              priority: "high",
            },
          ],
        };
      },
    );

    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const result = await service.infer({
      tenantId: "tenant-repair-2",
      taskClass: "opportunity_detection",
      promptTemplateId: "opportunity_detection",
      inputs: {
        sessionId: "s1",
        traceData: "trace",
        telemetrySummary: "summary",
      },
    });

    expect(executionCount).toBe(3); // 1 initial + 2 repairs
    expect(result.provenance.repairAttempts).toBe(2);
    expect((result.output as any).opportunities[0].id).toBe("opp_valid_02");
  });

  it("should throw SchemaValidationExhaustedError when max repair attempts (2) are exhausted", async () => {
    const fakeProvider = new FakeModelProvider({ id: "hopeless-provider" });
    let executionCount = 0;

    fakeProvider.setMockResponse(
      () => true,
      () => {
        executionCount++;
        // Always return invalid schema
        return { completelyInvalid: "garbage", count: executionCount };
      },
    );

    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    await expect(
      service.infer({
        tenantId: "tenant-exhausted",
        taskClass: "opportunity_detection",
        promptTemplateId: "opportunity_detection",
        inputs: {
          sessionId: "s1",
          traceData: "trace",
          telemetrySummary: "summary",
        },
      }),
    ).rejects.toThrow(SchemaValidationExhaustedError);

    expect(executionCount).toBe(3); // 1 initial + 2 repair attempts = 3 total attempts
  });

  it("should accumulate token usage across initial request and repair attempts", async () => {
    const fakeProvider = new FakeModelProvider({ id: "usage-repair-provider" });
    let executionCount = 0;

    fakeProvider.setMockResponse(
      () => true,
      () => {
        executionCount++;
        if (executionCount === 1) {
          return "invalid json";
        }
        return {
          opportunities: [
            {
              id: "opp_usage_01",
              title: "Usage tracked",
              description: "Tracks tokens",
              taskClass: "opportunity_detection",
              pattern: "pattern",
              confidenceScore: 0.9,
              evidence: ["evidence"],
              priority: "low",
            },
          ],
        };
      },
    );

    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const result = await service.infer({
      tenantId: "tenant-usage",
      taskClass: "opportunity_detection",
      promptTemplateId: "opportunity_detection",
      inputs: {
        sessionId: "s1",
        traceData: "trace",
        telemetrySummary: "summary",
      },
    });

    expect(result.provenance.repairAttempts).toBe(1);
    expect(result.provenance.usage.totalTokens).toBeGreaterThan(0);
  });
});
