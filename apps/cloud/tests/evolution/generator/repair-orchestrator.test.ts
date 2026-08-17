import { describe, expect, it } from "vitest";
import { CodeGenerator } from "../../../src/evolution/generator/code-generator.js";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import { RepairOrchestrator } from "../../../src/evolution/generator/repair-orchestrator.js";
import { GeneratedArtifactSet } from "../../../src/evolution/generator/types.js";
import { createMockOpportunity } from "./helpers.js";

describe("RepairOrchestrator", () => {
  const planner = new CandidatePlanner();
  const codeGen = new CodeGenerator();
  const orchestrator = new RepairOrchestrator();

  it("should return a single revision when initial artifacts pass self-review immediately", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Compute Total",
        description: "Sums numbers",
        taskClass: "compute",
        pattern: "compute",
        confidenceScore: 0.9,
        priority: "low",
        suggestedToolName: "compute_total",
      },
    });

    const plan = planner.plan(opp, { targetType: "single_tool" });
    const sourceCode = codeGen.generateSource(plan);

    const artifacts: GeneratedArtifactSet = {
      plan,
      manifest: {
        id: "tool-123",
        name: plan.name,
        version: "1.0.0",
        description: plan.description,
        parameters: plan.inputSchema,
        outputSchema: plan.outputSchema,
        runtime: plan.runtime,
        capabilities: plan.capabilityRequirements,
        limits: { timeoutMs: 30000, maxOutputBytes: 1048576, maxMemoryBytes: 134217728, maxConcurrentInvocations: 4 },
        scope: "workspace",
        digest: "hash-123",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      capabilities: plan.capabilityRequirements,
      sourceCode,
      generatedAt: new Date().toISOString(),
    };

    const result = orchestrator.orchestrate(artifacts, "cand-123");

    expect(result.success).toBe(true);
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0].revisionNumber).toBe(1);
    expect(result.revisions[0].parentRevisionId).toBeUndefined();
    expect(result.activeRevision.revisionNumber).toBe(1);
  });

  it("should repair capability deficiencies and produce parent-linked revision 2", () => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);

    // Source code calls broker.cmd.exec and broker.fs.readFile
    const sourceCode = `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({ path: z.string() }).strict();
export const OutputSchema = z.object({ success: z.boolean() }).strict();

export default defineTool(async (context: ToolContext) => {
  const { logger, broker, progress } = context;
  await progress(0, "start");
  await logger.info("executing");
  try {
    const data = await broker.fs.readFile("test.txt", "utf-8");
    const cmdRes = await broker.cmd.exec("git", ["status"]);
    await progress(100, "done");
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error("failed", { msg });
    throw new Error(msg);
  }
});
`;

    // Empty capabilities in initial artifacts
    const emptyCapabilities = {
      fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 1048576 },
      net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https"] as ("https")[], allowLocalhost: false, denyPrivateRanges: true },
      command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
      secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
      limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
    };

    const artifacts: GeneratedArtifactSet = {
      plan,
      manifest: {
        id: "tool-123",
        name: plan.name,
        version: "1.0.0",
        description: plan.description,
        parameters: plan.inputSchema,
        outputSchema: plan.outputSchema,
        runtime: plan.runtime,
        capabilities: emptyCapabilities,
        limits: { timeoutMs: 30000, maxOutputBytes: 1048576, maxMemoryBytes: 134217728, maxConcurrentInvocations: 4 },
        scope: "workspace",
        digest: "hash-123",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      capabilities: emptyCapabilities,
      sourceCode,
      generatedAt: new Date().toISOString(),
    };

    const result = orchestrator.orchestrate(artifacts, "cand-123");

    expect(result.success).toBe(true);
    expect(result.revisions.length).toBeGreaterThanOrEqual(2);

    const rev1 = result.revisions[0];
    const rev2 = result.revisions[1];

    expect(rev1.revisionNumber).toBe(1);
    expect(rev1.selfReview.passed).toBe(false);

    expect(rev2.revisionNumber).toBe(2);
    expect(rev2.parentRevisionId).toBe(rev1.revisionId);
    expect(rev2.selfReview.passed).toBe(true);
    expect(rev2.repairHistory.length).toBeGreaterThanOrEqual(1);
    expect(rev2.artifacts.capabilities.fs.allowWorkspaceRoot).toBe(true);
    expect(rev2.artifacts.capabilities.command.allowedBinaries.length).toBeGreaterThan(0);
  });

  it("should respect maxRepairIterations bound on unresolvable errors", () => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);

    // Unresolvable syntax error
    const artifacts: GeneratedArtifactSet = {
      plan,
      manifest: {
        id: "tool-123",
        name: plan.name,
        version: "1.0.0",
        description: plan.description,
        parameters: plan.inputSchema,
        runtime: plan.runtime,
        capabilities: plan.capabilityRequirements,
        limits: { timeoutMs: 30000, maxOutputBytes: 1048576, maxMemoryBytes: 134217728, maxConcurrentInvocations: 4 },
        scope: "workspace",
        digest: "hash-123",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      capabilities: plan.capabilityRequirements,
      sourceCode: "const syntax error = ;;;",
      generatedAt: new Date().toISOString(),
    };

    const result = orchestrator.orchestrate(artifacts, "cand-123", { maxRepairIterations: 3 });

    expect(result.success).toBe(false);
    expect(result.revisions.length).toBeLessThanOrEqual(3);
    expect(result.activeRevision.selfReview.passed).toBe(false);
  });
});
