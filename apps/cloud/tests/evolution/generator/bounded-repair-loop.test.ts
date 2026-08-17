import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../../src/db/client.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  CandidateGenerationService,
  CandidatePlanner,
  CandidateRepository,
  CapabilityMapper,
  CodeGenerator,
  DeterministicSelfReviewer,
  RepairOrchestrator,
  SchemaGenerator,
} from "../../../src/evolution/generator/index.js";
import type { GeneratedArtifactSet } from "../../../src/evolution/generator/types.js";
import { FakeModelProvider, InferenceService } from "../../../src/models/index.js";
import { createMockEnvelope, createMockOpportunity, createMockTenant } from "./helpers.js";

describe("Bounded Inference Repair Loop [REM-010]", () => {
  async function setupEnvironment() {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);

    const fakeProvider = new FakeModelProvider("mock-repair-llm", "Mock Repair LLM");
    const inferenceService = new InferenceService();
    inferenceService.router.registerProvider(fakeProvider);

    const tenant = createMockTenant({
      accountId: "acct-repair-123",
      workspaceId: "ws-repair-456",
    });

    const candidateRepo = new CandidateRepository(pool);
    const capabilityMapper = new CapabilityMapper();
    const schemaGenerator = new SchemaGenerator();
    const planner = new CandidatePlanner(capabilityMapper, schemaGenerator);
    const codeGenerator = new CodeGenerator(schemaGenerator);
    const selfReviewer = new DeterministicSelfReviewer(capabilityMapper);
    const repairOrchestrator = new RepairOrchestrator(selfReviewer, capabilityMapper);

    const service = new CandidateGenerationService({
      inferenceService,
      pool,
      candidateRepo,
      planner,
      codeGenerator,
      selfReviewer,
      repairOrchestrator,
      capabilityMapper,
      schemaGenerator,
    });

    return {
      pool,
      tenant,
      service,
      fakeProvider,
      inferenceService,
      candidateRepo,
      selfReviewer,
      repairOrchestrator,
      capabilityMapper,
      planner,
      codeGenerator,
    };
  }

  it("should create immutable revisions with parent lineage and capability diffs during repair", async () => {
    const { planner, repairOrchestrator } = await setupEnvironment();

    const opportunity = createMockOpportunity();
    const plan = planner.plan(opportunity);

    // Initial broken artifacts with forbidden imports and raw secret read
    const brokenCode = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import fs from "node:fs";
import { z } from "zod";

export const InputSchema = z.object({
  path: z.string().describe("Path"),
});

export const OutputSchema = z.object({
  success: z.boolean(),
});

export default defineTool({
  name: ${JSON.stringify(plan.name)},
  description: "Broken tool",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input, context) => {
    const raw = getSecret("API_KEY");
    return { success: true };
  },
});`;

    const initialArtifacts: GeneratedArtifactSet = {
      plan,
      manifest: {
        id: "tool_broken",
        name: plan.name,
        version: "1.0.0",
        description: plan.description,
        parameters: plan.inputSchema,
        outputSchema: plan.outputSchema,
        runtime: plan.runtime,
        capabilities: {
          ...plan.capabilities,
          secrets: {
            allowedSecretNames: ["API_KEY"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
        },
        limits: {
          timeoutMs: 30000,
          maxOutputBytes: 1048576,
          maxMemoryBytes: 134217728,
          maxConcurrentInvocations: 4,
        },
        scope: "workspace",
        digest: "hash_init",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      capabilities: {
        ...plan.capabilities,
        secrets: {
          allowedSecretNames: ["API_KEY"],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
      },
      sourceCode: brokenCode,
      generatedAt: new Date().toISOString(),
    };

    const repairResult = await repairOrchestrator.orchestrateAsync(
      initialArtifacts,
      "cand-repair-001",
      { maxRepairIterations: 3 },
    );

    expect(repairResult.success).toBe(true);
    expect(repairResult.revisions.length).toBeGreaterThanOrEqual(2);

    // Verify revision 1 (broken)
    const rev1 = repairResult.revisions[0];
    expect(rev1.revisionNumber).toBe(1);
    expect(rev1.parentRevisionId).toBeUndefined();
    expect(rev1.selfReview.passed).toBe(false);
    expect(rev1.selfReview.issues.some((i) => i.category === "imports")).toBe(true);

    // Verify revision 2 (repaired)
    const rev2 = repairResult.revisions[1];
    expect(rev2.revisionNumber).toBe(2);
    expect(rev2.parentRevisionId).toBe(rev1.revisionId);
    expect(rev2.selfReview.passed).toBe(true);
    expect(rev2.repairHistory.length).toBeGreaterThanOrEqual(1);

    // Source code must have stripped illegal imports
    expect(rev2.artifacts.sourceCode).not.toContain('from "node:fs"');
    expect(rev2.artifacts.sourceCode).not.toContain("getSecret(");
  });

  it("should enforce capability monotonicity and never broaden permissions beyond workspace envelope", async () => {
    const { planner, repairOrchestrator } = await setupEnvironment();

    const envelope = createMockEnvelope({
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: [],
        allowedBinaries: [],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
    });

    const opportunity = createMockOpportunity();
    const plan = planner.plan(opportunity, { envelope });

    // Initial code attempts to access unbrokered net and command
    const brokenCode = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  path: z.string().describe("Path"),
});

export const OutputSchema = z.object({
  success: z.boolean(),
});

export default defineTool({
  name: "unauthorized_tool",
  description: "Attempts out-of-envelope operations",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input, context: ToolContext) => {
    const logger = context.logger;
    await logger.info("Executing");
    try {
      const res = await context.broker.net.fetch("https://malicious.example.com");
      return { success: true };
    } catch (error) {
      await logger.error("Failed", { error: String(error) });
      throw error;
    }
  },
});`;

    const initialArtifacts: GeneratedArtifactSet = {
      plan,
      manifest: {
        id: "tool_unauth",
        name: "unauthorized_tool",
        version: "1.0.0",
        description: "Attempts out-of-envelope operations",
        parameters: plan.inputSchema,
        outputSchema: plan.outputSchema,
        runtime: plan.runtime,
        capabilities: plan.capabilities,
        limits: {
          timeoutMs: 30000,
          maxOutputBytes: 1048576,
          maxMemoryBytes: 134217728,
          maxConcurrentInvocations: 4,
        },
        scope: "workspace",
        digest: "hash_unauth",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      capabilities: plan.capabilities,
      sourceCode: brokenCode,
      generatedAt: new Date().toISOString(),
    };

    const repairResult = await repairOrchestrator.orchestrateAsync(
      initialArtifacts,
      "cand-repair-envelope",
      { envelope, maxRepairIterations: 3 },
    );

    // Repaired revisions must NEVER have net.allowOutbound = true because envelope forbids it
    for (const rev of repairResult.revisions) {
      expect(rev.artifacts.capabilities.net.allowOutbound).toBe(false);
      expect(rev.artifacts.capabilities.command.allowShellExecution).toBe(false);
    }
  });

  it("should terminate with durable rejected state when repair iterations are exhausted", async () => {
    const { tenant, service, fakeProvider } = await setupEnvironment();

    fakeProvider.registerMockResponse(
      (req) =>
        req.schemaName === "tool_synthesis" || req.systemInstruction.includes("Code Synthesizer"),
      () => ({
        toolId: "tool_unfixable",
        name: "forbidden_net_tool",
        version: "1.0.0",
        description: "Requests forbidden outbound network",
        schema: { type: "object", properties: { url: { type: "string" } } },
        code: `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export default defineTool({
  name: "forbidden_net_tool",
  description: "Forbidden network tool",
  inputSchema: z.object({ url: z.string() }),
  handler: async (input: { url: string }, context: ToolContext) => {
    const res = await context.broker.net.fetch(input.url);
    return { success: true, data: await res.json() };
  },
});`,
        runtimeRequirements: ["deno:net"],
      }),
    );

    const opportunity = createMockOpportunity({
      id: "opp_unfixable_001",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      triggerReason: "repeated_pattern",
      classification: {
        title: "Unfixable Contradictory Tool",
        description: "Requests contradictory capabilities strictly forbidden by envelope",
        taskClass: "network",
        pattern: "http_forbidden",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "forbidden_net_tool",
        inferredInputs: [{ name: "url", type: "string", description: "URL" }],
      },
    });

    const strictEnvelope = createMockEnvelope({
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
    });

    const result = await service.generateCandidate(tenant, opportunity, {
      envelope: strictEnvelope,
      maxRepairIterations: 3,
    });

    expect(result.status).toBe("needs_repair");
    expect(result.candidate.state).toBe("rejected");
    expect(result.candidate.rejectionReason).toContain("Capability envelope violation");

    // Revisions must be bounded by maxRepairIterations
    expect(result.revisions.length).toBeLessThanOrEqual(3);
  });

  it("should support inference-driven repair with structured findings", async () => {
    const { tenant, service, fakeProvider } = await setupEnvironment();

    // Register a mock response for tool_repair prompt
    fakeProvider.registerMockResponse(
      (req) => req.schemaName === "tool_repair" || req.systemInstruction.includes("Repair Engine"),
      () => ({
        toolId: "tool_repaired_by_model",
        name: "math_calculator",
        version: "1.0.1",
        code: `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  values: z.array(z.number()).describe("Numbers to compute"),
});

export const OutputSchema = z.object({
  success: z.boolean(),
  data: z.record(z.unknown()),
});

export type ToolInput = z.infer<typeof InputSchema>;
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>({
  name: "math_calculator",
  description: "Calculates mathematical summary",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: ToolInput, context: ToolContext): Promise<ToolOutput> => {
    const { logger, progress } = context;
    await progress(0, "Starting");
    await logger.info("Calculating numbers");
    try {
      const count = input.values.length;
      const sum = input.values.reduce((a, b) => a + b, 0);
      await progress(100, "Done", "complete");
      await logger.info("Calculation complete");
      return { success: true, data: { count, sum } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await logger.error("Calculation failed", { error: msg });
      throw new Error(\`Execution error: \${msg}\`);
    }
  },
});`,
        fixedIssues: ["Wrapped in defineTool", "Added logger error handling"],
        explanation: "Fixed handler structure and added error logging",
      }),
    );

    const opportunity = createMockOpportunity({
      classification: {
        title: "Calculate Numbers",
        description: "Calculates sum of values",
        taskClass: "compute",
        pattern: "compute_sum",
        confidenceScore: 0.95,
        priority: "medium",
        suggestedToolName: "math_calculator",
        inferredInputs: [{ name: "values", type: "array", description: "Numbers" }],
      },
    });

    const genResult = await service.generateCandidate(tenant, opportunity);
    expect(genResult.status).toBe("synthesized");
    expect(genResult.candidate.state).toBe("synthesized");
    expect(genResult.activeRevision.selfReview.passed).toBe(true);
  });
});
