import { describe, expect, it } from "vitest";
import { CodeGenerator } from "../../../src/evolution/generator/code-generator.js";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import { RepairOrchestrator } from "../../../src/evolution/generator/repair-orchestrator.js";
import type { GeneratedArtifactSet } from "../../../src/evolution/generator/types.js";
import { buildWorkflowCoverage, workflowCoverageDiagnostics } from "../../../src/evolution/generator/workflow-coverage.js";
import type { WorkflowContract } from "../../../src/evolution/opportunity/types.js";
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
        limits: {
          timeoutMs: 30000,
          maxOutputBytes: 1048576,
          maxMemoryBytes: 134217728,
          maxConcurrentInvocations: 4,
        },
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
    return { success: cmdRes.exitCode === 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error("failed", { msg });
    throw new Error(msg);
  }
});
`;

    // Empty capabilities in initial artifacts
    const emptyCapabilities = {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 1048576,
      },
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https"] as "https"[],
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
      secrets: {
        allowedSecretNames: [],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
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
        limits: {
          timeoutMs: 30000,
          maxOutputBytes: 1048576,
          maxMemoryBytes: 134217728,
          maxConcurrentInvocations: 4,
        },
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
        limits: {
          timeoutMs: 30000,
          maxOutputBytes: 1048576,
          maxMemoryBytes: 134217728,
          maxConcurrentInvocations: 4,
        },
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

  it("should repair missing later operations and outputs in contract plan and mark repaired when complete", () => {
    const contract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "command:git status --porcelain", toolClass: "vcs", commandProfile: "git status --porcelain" },
        { id: "op_1", order: 1, name: "command:git diff --stat", toolClass: "vcs", commandProfile: "git diff --stat" },
        { id: "op_2", order: 2, name: "command:git log --oneline -5", toolClass: "vcs", commandProfile: "git log --oneline -5" },
        { id: "op_3", order: 3, name: "tool:read_file", toolClass: "file_read" },
      ],
      requiredInputs: [{ name: "targetRepo", type: "string", description: "Target repo", required: true }],
      outputRequirements: [
        { name: "op0_command_git_status_porcelain_result", sourceOperationId: "op_0", type: "object", required: true, description: "Output of op0" },
        { name: "op1_command_git_diff_stat_result", sourceOperationId: "op_1", type: "object", required: true, description: "Output of op1" },
        { name: "op2_command_git_log_oneline_5_result", sourceOperationId: "op_2", type: "object", required: true, description: "Output of op2" },
        { name: "op3_tool_read_file_result", sourceOperationId: "op_3", type: "object", required: true, description: "Output of op3" },
      ],
      invariants: ["ordering: sequential op_0->op_3"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const opp = createMockOpportunity({
      classification: { title: "Git Audit", description: "Audit", taskClass: "multi_step", pattern: "vcs -> vcs -> vcs -> file_read", confidenceScore: 0.95, priority: "high", workflowContract: contract },
    });
    const basePlan = planner.plan(opp);
    const plan = {
      ...basePlan,
      workflowContract: contract,
      steps: basePlan.steps.filter((s) => s.coveredOperationIds?.includes("op_0") || s.coveredOperationIds?.includes("op_1")),
      outputSchema: {
        type: "object",
        properties: {
          op0_command_git_status_porcelain_result: { type: "object", description: "Output of op0" },
          op1_command_git_diff_stat_result: { type: "object", description: "Output of op1" },
          success: { type: "boolean" },
          data: { type: "object" },
        },
        description: "Execution output",
      },
    } as unknown as typeof basePlan;
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
    const initialCoverage = buildWorkflowCoverage(contract, plan.steps, plan.outputSchema);
    expect(initialCoverage.uncoveredOperationIds).toEqual(expect.arrayContaining(["op_2", "op_3"]));
    expect(initialCoverage.uncoveredOutputNames).toEqual(expect.arrayContaining(["op2_command_git_log_oneline_5_result", "op3_tool_read_file_result"]));

    const result = orchestrator.orchestrate(artifacts, "cand-123", { maxRepairIterations: 5 });
    expect(result.success).toBe(true);
    expect(result.activeRevision.selfReview.passed).toBe(true);
    const finalCoverage = buildWorkflowCoverage(contract, result.activeRevision.artifacts.plan.steps, result.activeRevision.artifacts.plan.outputSchema);
    expect(finalCoverage.complete).toBe(true);
    expect(finalCoverage.uncoveredOperationIds).toHaveLength(0);
    expect(finalCoverage.uncoveredOutputNames).toHaveLength(0);
    expect(result.activeRevision.artifacts.plan.workflowCoverage?.complete).toBe(true);
    expect(result.activeRevision.artifacts.plan.steps.some((s) => s.coveredOperationIds?.includes("op_2"))).toBe(true);
    expect(result.activeRevision.artifacts.plan.steps.some((s) => s.coveredOperationIds?.includes("op_3"))).toBe(true);
    expect(result.revisions.length).toBeGreaterThan(1);
    expect(result.revisions[1].parentRevisionId).toBe(result.revisions[0].revisionId);
  });

  it("should remain failed when maxRepairIterations exhausted and coverage incomplete", () => {
    const contract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "command:git status --porcelain", toolClass: "vcs", commandProfile: "git status --porcelain" },
        { id: "op_1", order: 1, name: "command:git diff --stat", toolClass: "vcs", commandProfile: "git diff --stat" },
        { id: "op_2", order: 2, name: "command:git log --oneline -5", toolClass: "vcs", commandProfile: "git log --oneline -5" },
        { id: "op_3", order: 3, name: "tool:read_file", toolClass: "file_read" },
      ],
      requiredInputs: [{ name: "targetRepo", type: "string", description: "Target repo", required: true }],
      outputRequirements: [
        { name: "op0_command_git_status_porcelain_result", sourceOperationId: "op_0", type: "object", required: true, description: "Output of op0" },
        { name: "op1_command_git_diff_stat_result", sourceOperationId: "op_1", type: "object", required: true, description: "Output of op1" },
        { name: "op2_command_git_log_oneline_5_result", sourceOperationId: "op_2", type: "object", required: true, description: "Output of op2" },
        { name: "op3_tool_read_file_result", sourceOperationId: "op_3", type: "object", required: true, description: "Output of op3" },
      ],
      invariants: ["ordering: sequential op_0->op_3"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const opp = createMockOpportunity({
      classification: { title: "Git Audit", description: "Audit", taskClass: "multi_step", pattern: "vcs -> vcs -> vcs -> file_read", confidenceScore: 0.95, priority: "high", workflowContract: contract },
    });
    const basePlan = planner.plan(opp);
    const plan = {
      ...basePlan,
      workflowContract: contract,
      steps: basePlan.steps.filter((s) => s.coveredOperationIds?.includes("op_0")),
      outputSchema: {
        type: "object",
        properties: {
          op0_command_git_status_porcelain_result: { type: "object", description: "Output of op0" },
          success: { type: "boolean" },
          data: { type: "object" },
        },
        description: "Execution output",
      },
    } as unknown as typeof basePlan;
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
    const result = orchestrator.orchestrate(artifacts, "cand-123", { maxRepairIterations: 1 });
    expect(result.success).toBe(false);
    expect(result.activeRevision.selfReview.passed).toBe(false);
    const coverageAfter = buildWorkflowCoverage(contract, result.activeRevision.artifacts.plan.steps, result.activeRevision.artifacts.plan.outputSchema);
    expect(coverageAfter.complete).toBe(false);
    expect(workflowCoverageDiagnostics(coverageAfter).length).toBeGreaterThan(0);
    expect(result.revisions.length).toBe(1);
  });

  it("should feed coverage diagnostics into model repair prompt and request exact missing coverage", async () => {
    const contract: WorkflowContract = {
      version: 1,
      operations: [
        { id: "op_0", order: 0, name: "command:git status --porcelain", toolClass: "vcs", commandProfile: "git status --porcelain" },
        { id: "op_1", order: 1, name: "command:git diff --stat", toolClass: "vcs", commandProfile: "git diff --stat" },
        { id: "op_2", order: 2, name: "tool:read_file", toolClass: "file_read" },
      ],
      requiredInputs: [{ name: "targetRepo", type: "string", description: "Target repo", required: true }],
      outputRequirements: [
        { name: "op0_command_git_status_porcelain_result", sourceOperationId: "op_0", type: "object", required: true, description: "Output of op0" },
        { name: "op1_command_git_diff_stat_result", sourceOperationId: "op_1", type: "object", required: true, description: "Output of op1" },
        { name: "op2_tool_read_file_result", sourceOperationId: "op_2", type: "object", required: true, description: "Output of op2" },
      ],
      invariants: ["ordering: sequential op_0->op_2"],
      expensiveOperationIds: [],
      repeatedOperationIds: [],
    };
    const opp = createMockOpportunity({
      classification: { title: "Git Audit", description: "Audit", taskClass: "multi_step", pattern: "vcs -> vcs -> file_read", confidenceScore: 0.95, priority: "high", workflowContract: contract },
    });
    const basePlan = planner.plan(opp);
    const plan = {
      ...basePlan,
      workflowContract: contract,
      steps: basePlan.steps.filter((s) => s.coveredOperationIds?.includes("op_0")),
      outputSchema: {
        type: "object",
        properties: {
          op0_command_git_status_porcelain_result: { type: "object", description: "Output of op0" },
          success: { type: "boolean" },
          data: { type: "object" },
        },
        description: "Execution output",
      },
    } as unknown as typeof basePlan;
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
    const captured: Array<Record<string, unknown>> = [];
    const mockInference = {
      infer: async (req: { inputs: Record<string, unknown> }) => {
        captured.push(req.inputs);
        return {
          output: {
            toolId: "tool-123",
            name: plan.name,
            version: "1.0.0",
            code: sourceCode,
            fixedIssues: [],
            capabilities: {},
          },
          provenance: { providerId: "test", model: "test-model", requestId: "req-1", promptTemplateId: "tool_repair", promptTemplateVersion: "1.0.0", promptDigest: "digest", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
        } as unknown as Awaited<ReturnType<typeof mockInference.infer>>;
      },
    } as unknown as import("../../../src/models/service.js").InferenceService;
    const result = await orchestrator.orchestrateAsync(artifacts, "cand-123", { maxRepairIterations: 2, inferenceService: mockInference });
    expect(captured.length).toBeGreaterThan(0);
    const firstInputs = captured[0] as Record<string, unknown>;
    const reviewIssuesStr = String(firstInputs.reviewIssues);
    expect(reviewIssuesStr).toContain("op_1");
    expect(reviewIssuesStr).toContain("op_2");
    expect(reviewIssuesStr.toLowerCase()).toContain("missing");
    expect(String(firstInputs.workflowContract)).toContain("op_1");
    expect(String(firstInputs.coverageDiagnostics)).toContain("op_1");
    const coverageDiagnostics = JSON.parse(String(firstInputs.coverageDiagnostics)) as string[];
    expect(coverageDiagnostics.some((d) => d.includes("op_1"))).toBe(true);
    expect(coverageDiagnostics.some((d) => d.includes("op_2"))).toBe(true);
  });

  it("should retain legacy repair behavior without workflowContract", () => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);
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
    await progress(100, "done");
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error("failed", { msg });
    throw new Error(msg);
  }
});
`;
    const emptyCapabilities = {
      fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 1048576 },
      net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https"] as "https"[], allowLocalhost: false, denyPrivateRanges: true },
      command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
      secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
      limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
    };
    const artifacts: GeneratedArtifactSet = {
      plan,
      manifest: { id: "tool-123", name: plan.name, version: "1.0.0", description: plan.description, parameters: plan.inputSchema, outputSchema: plan.outputSchema, runtime: plan.runtime, capabilities: emptyCapabilities, limits: { timeoutMs: 30000, maxOutputBytes: 1048576, maxMemoryBytes: 134217728, maxConcurrentInvocations: 4 }, scope: "workspace", digest: "hash-123", metadata: {}, createdAt: new Date().toISOString() },
      capabilities: emptyCapabilities,
      sourceCode,
      generatedAt: new Date().toISOString(),
    };
    const result = orchestrator.orchestrate(artifacts, "cand-123");
    expect(result.success).toBe(true);
    expect(result.revisions[0].artifacts.plan.workflowContract).toBeUndefined();
    expect(result.revisions[0].artifacts.plan.workflowCoverage).toBeUndefined();
  });
});
