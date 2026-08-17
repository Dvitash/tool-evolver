import type {
  CapabilityEnvelope,
  CapabilityManifest,
  EvolutionCandidate,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { CandidateRevision, ToolPlan } from "../../src/evolution/generator/types.js";

/**
 * Pure compute candidate tool source code.
 */
export const PURE_COMPUTE_TOOL_SOURCE = `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  a: z.number(),
  b: z.number(),
  operation: z.enum(["add", "subtract", "multiply", "divide"]).default("add"),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  success: z.boolean(),
  result: z.number(),
});
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, progress } = context;

  await progress(0, "Starting math operation", "init");
  await logger.info("Calculating", { a: input.a, b: input.b, op: input.operation });

  let result = 0;
  if (input.operation === "add") {
    result = input.a + input.b;
  } else if (input.operation === "subtract") {
    result = input.a - input.b;
  } else if (input.operation === "multiply") {
    result = input.a * input.b;
  } else if (input.operation === "divide") {
    if (input.b === 0) {
      throw new Error("Division by zero is not permitted.");
    }
    result = input.a / input.b;
  }

  await progress(100, "Math operation complete", "done");
  await logger.info("Calculation successful", { result });

  return {
    success: true,
    result,
  };
});
`;

/**
 * Filesystem candidate tool source code.
 */
export const FS_TOOL_SOURCE = `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  filePath: z.string().min(1),
  appendText: z.string().optional(),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  success: z.boolean(),
  lineCount: z.number(),
  contentLength: z.number(),
});
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;

  await progress(10, "Checking file existence", "check");
  const exists = await broker.fs.exists(input.filePath);
  if (!exists) {
    throw new Error(\`File does not exist: \${input.filePath}\`);
  }

  await progress(40, "Reading file content", "read");
  const content = (await broker.fs.readFile(input.filePath, "utf-8")) as string;
  const lines = content.split("\\n");

  if (input.appendText) {
    await progress(70, "Appending text", "write");
    await broker.fs.writeFile(input.filePath, content + "\\n" + input.appendText);
  }

  await progress(100, "Finished file processing", "done");
  await logger.info("File processed successfully", { path: input.filePath, lines: lines.length });

  return {
    success: true,
    lineCount: lines.length,
    contentLength: content.length,
  };
});
`;

/**
 * Network candidate tool source code.
 */
export const NET_TOOL_SOURCE = `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  endpointUrl: z.string().url(),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  success: z.boolean(),
  status: z.number(),
  data: z.record(z.unknown()),
});
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;

  await progress(20, "Fetching remote resource", "fetch");
  await logger.info("Initiating HTTP GET", { url: input.endpointUrl });

  const response = await broker.net.fetch(input.endpointUrl);
  if (response.status >= 400) {
    throw new Error(\`Remote request failed with status: \${response.status}\`);
  }

  const data = await response.json<Record<string, unknown>>();

  await progress(100, "Fetch complete", "done");
  return {
    success: true,
    status: response.status,
    data,
  };
});
`;

/**
 * Command candidate tool source code.
 */
export const CMD_TOOL_SOURCE = `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  success: z.boolean(),
  stdout: z.string(),
  exitCode: z.number(),
});
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;

  await progress(30, "Executing command", "exec");
  await logger.info("Running command", { cmd: input.command, args: input.args });

  const result = await broker.cmd.exec(input.command, input.args);
  if (result.exitCode !== 0) {
    throw new Error(\`Command '\${input.command}' failed with exit code \${result.exitCode}: \${result.stderr}\`);
  }

  await progress(100, "Command finished", "done");
  return {
    success: true,
    stdout: result.stdout,
    exitCode: result.exitCode,
  };
});
`;

/**
 * Secret candidate tool source code.
 */
export const SECRET_TOOL_SOURCE = `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  secretName: z.string().min(1),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  success: z.boolean(),
  hasSecret: z.boolean(),
  secretPrefix: z.string(),
});
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;

  await progress(30, "Retrieving secret", "secret");
  const secretValue = await broker.secret.getSecret(input.secretName);

  if (!secretValue) {
    throw new Error(\`Secret '\${input.secretName}' was not found or access denied.\`);
  }

  await progress(100, "Secret verified", "done");
  await logger.info("Secret loaded successfully", { secretName: input.secretName });

  return {
    success: true,
    hasSecret: true,
    secretPrefix: secretValue.slice(0, 4),
  };
});
`;

/**
 * Creates a mock ToolManifest.
 */
export function createMockManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    id: overrides.id ?? "tool-math-evaluator-123",
    name: overrides.name ?? "math_evaluator",
    version: overrides.version ?? "1.0.0",
    description: overrides.description ?? "Performs safe arithmetic operations.",
    parameters: overrides.parameters ?? {
      type: "object",
      properties: {
        a: { type: "number", description: "First operand" },
        b: { type: "number", description: "Second operand" },
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide"],
          default: "add",
        },
      },
      required: ["a", "b"],
    },
    outputSchema: overrides.outputSchema ?? {
      type: "object",
      properties: {
        success: { type: "boolean" },
        result: { type: "number" },
      },
      required: ["success", "result"],
    },
    runtime: overrides.runtime ?? {
      engine: "bun",
      minVersion: "1.0.0",
      target: "es2022",
    },
    capabilities: overrides.capabilities ?? {
      fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 10485760 },
      net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https"], allowLocalhost: false, denyPrivateRanges: true },
      command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
      secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
      limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
    },
    limits: overrides.limits ?? {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: overrides.scope ?? "workspace",
    digest: overrides.digest ?? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Creates a mock ToolPlan.
 */
export function createMockPlan(overrides: Partial<ToolPlan> = {}): ToolPlan {
  return {
    id: overrides.id ?? "plan-math-123",
    opportunityId: overrides.opportunityId ?? "opp-math-456",
    workspaceId: overrides.workspaceId ?? "ws-test-789",
    targetType: overrides.targetType ?? "single_tool",
    name: overrides.name ?? "math_evaluator",
    intent: overrides.intent ?? "Perform math computations",
    description: overrides.description ?? "Safe arithmetic evaluator",
    inputSchema: overrides.inputSchema ?? {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
    outputSchema: overrides.outputSchema ?? {
      type: "object",
      properties: {
        success: { type: "boolean" },
        result: { type: "number" },
      },
      required: ["success", "result"],
    },
    variableInputs: overrides.variableInputs ?? [],
    steps: overrides.steps ?? [
      {
        id: "step_1",
        toolClass: "compute",
        action: "compute",
        inputs: {},
        dependsOn: [],
      },
    ],
    requiredCapabilities: overrides.requiredCapabilities ?? {
      fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 10485760 },
      net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https"], allowLocalhost: false, denyPrivateRanges: true },
      command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
      secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
      limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
    },
    resourceRequirements: overrides.resourceRequirements ?? {
      maxExecutionTimeMs: 5000,
      maxMemoryMb: 64,
      maxOutputBytes: 1024,
    },
    confidenceScore: overrides.confidenceScore ?? 0.95,
    estimatedImpact: overrides.estimatedImpact ?? {
      latencyImprovementPercent: 50,
      tokenSavingsPercent: 40,
    },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Creates a mock CandidateRevision.
 */
export function createMockCandidateRevision(overrides: Partial<CandidateRevision> = {}): CandidateRevision {
  const plan = createMockPlan();
  const manifest = createMockManifest();
  return {
    revisionId: overrides.revisionId ?? "rev-12345",
    candidateId: overrides.candidateId ?? "cand-67890",
    revisionNumber: overrides.revisionNumber ?? 1,
    artifacts: overrides.artifacts ?? {
      plan,
      manifest,
      capabilities: manifest.capabilities,
      sourceCode: PURE_COMPUTE_TOOL_SOURCE,
      generatedAt: new Date().toISOString(),
    },
    selfReview: overrides.selfReview ?? {
      passed: true,
      issues: [],
      reviewedAt: new Date().toISOString(),
    },
    repairHistory: overrides.repairHistory ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}
