import { describe, expect, it } from "vitest";
import { CodeGenerator } from "../../../src/evolution/generator/code-generator.js";
import { CandidatePlanner } from "../../../src/evolution/generator/planner.js";
import { DeterministicSelfReviewer } from "../../../src/evolution/generator/self-reviewer.js";
import type { GeneratedArtifactSet } from "../../../src/evolution/generator/types.js";
import { createMockEnvelope, createMockOpportunity } from "./helpers.js";

describe("DeterministicSelfReviewer", () => {
  const planner = new CandidatePlanner();
  const codeGen = new CodeGenerator();
  const reviewer = new DeterministicSelfReviewer();

  it("should pass cleanly for a valid generated artifact set", () => {
    const opp = createMockOpportunity({
      classification: {
        title: "Inspect File",
        description: "Inspects file in workspace",
        taskClass: "file_read",
        pattern: "file_read",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "inspect_file",
        inferredInputs: [{ name: "path", type: "string", description: "Path" }],
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

    const verdict = reviewer.review(artifacts);

    expect(verdict.passed).toBe(true);
    expect(verdict.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("should catch TypeScript syntax errors", () => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);

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
      sourceCode: "const invalid syntax = ;;;",
      generatedAt: new Date().toISOString(),
    };

    const verdict = reviewer.review(artifacts);

    expect(verdict.passed).toBe(false);
    expect(verdict.issues.some((i) => i.category === "ast")).toBe(true);
  });

  it("should catch illegal native imports", () => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);

    const badSource = `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import fs from "node:fs";
import { exec } from "child_process";
import { z } from "zod";

export const InputSchema = z.object({}).strict();
export const OutputSchema = z.object({}).strict();

export default defineTool(async (context: ToolContext) => {
  const { logger } = context;
  try {
    fs.readFileSync("foo");
    return { success: true };
  } catch (err) {
    await logger.error("failed", { err });
    throw err;
  }
});
`;

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
      sourceCode: badSource,
      generatedAt: new Date().toISOString(),
    };

    const verdict = reviewer.review(artifacts);

    expect(verdict.passed).toBe(false);
    const importErrors = verdict.issues.filter((i) => i.category === "imports");
    expect(importErrors.length).toBeGreaterThanOrEqual(2);
  });

  it("should catch missing capability declarations when broker calls are present", () => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);

    const source = `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({}).strict();
export const OutputSchema = z.object({}).strict();

export default defineTool(async (context: ToolContext) => {
  const { logger, broker, progress } = context;
  await progress(0, "start");
  try {
    await broker.net.fetch("https://api.example.com");
    await broker.cmd.exec("git status");
    return { success: true };
  } catch (err) {
    await logger.error("err", { err });
    throw err;
  }
});
`;

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
      sourceCode: source,
      generatedAt: new Date().toISOString(),
    };

    const verdict = reviewer.review(artifacts);

    expect(verdict.passed).toBe(false);
    const capErrors = verdict.issues.filter((i) => i.category === "capabilities");
    expect(capErrors.length).toBeGreaterThanOrEqual(2);
  });

  it("should catch envelope violations when envelope forbids requested capability", () => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);
    const sourceCode = codeGen.generateSource(plan);

    const envelope = createMockEnvelope({
      command: {
        allowShellExecution: false,
        allowedBinaries: [],
        allowedCommands: [],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
    });

    const artifacts: GeneratedArtifactSet = {
      plan,
      manifest: {
        id: "tool-123",
        name: plan.name,
        version: "1.0.0",
        description: plan.description,
        parameters: plan.inputSchema,
        runtime: plan.runtime,
        capabilities: {
          ...plan.capabilityRequirements,
          command: {
            ...plan.capabilityRequirements.command,
            allowShellExecution: true,
          },
        },
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
      capabilities: {
        ...plan.capabilityRequirements,
        command: {
          ...plan.capabilityRequirements.command,
          allowShellExecution: true,
        },
      },
      sourceCode,
      generatedAt: new Date().toISOString(),
    };

    const verdict = reviewer.review(artifacts, envelope);

    expect(verdict.passed).toBe(false);
    expect(
      verdict.issues.some((i) => i.message.includes("envelope strictly forbids shell execution")),
    ).toBe(true);
  });
});

describe("DeterministicSelfReviewer broker result contract", () => {
  const planner = new CandidatePlanner();
  const reviewer = new DeterministicSelfReviewer();

  const makeArtifacts = (sourceCode: string): GeneratedArtifactSet => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);
    return {
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
  };

  const brokerErrors = (sourceCode: string) =>
    reviewer
      .review(makeArtifacts(sourceCode))
      .issues.filter((i) => i.severity === "error" && i.category === "broker");

  it("flags hallucinated result fields (.output/.error/.exit_code) on exec results", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const logResult = await context.broker.cmd.exec("git", ["log", "--oneline", "-5"]);
    const code = logResult.exit_code ?? 0;
    return { success: code === 0, data: { output: logResult.output, error: logResult.error }, error: null };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    const issues = brokerErrors(sourceCode);
    expect(issues.some((i) => i.message.includes("logResult.exit_code"))).toBe(true);
    expect(issues.some((i) => i.message.includes("logResult.output"))).toBe(true);
    expect(issues.some((i) => i.message.includes("logResult.error"))).toBe(true);
    expect(issues.every((i) => i.fixHint?.includes("exitCode") || i.fixHint?.includes("stdout"))).toBe(
      true,
    );
  });

  it("flags exec invoked directly on broker/context (missing cmd family)", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const result = await context.broker.exec("git status --porcelain", { shell: true });
    return { success: result.exitCode === 0, data: { stdout: result.stdout }, error: null };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    const issues = brokerErrors(sourceCode);
    expect(issues.some((i) => i.message.includes("broker.exec"))).toBe(true);
  });

  it("flags cmd.execute (CmdBrokerClient exposes exec only)", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const result = await context.broker.cmd.execute("git", ["status", "--porcelain"]);
    return { success: result.exitCode === 0, data: { stdout: result.stdout }, error: null };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    const issues = brokerErrors(sourceCode);
    expect(issues.some((i) => i.message.includes("cmd.execute"))).toBe(true);
  });

  it("accepts contract-correct cmd.exec usage", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const result = await context.broker.cmd.exec("git", ["status", "--porcelain"]);
    await context.logger.info("git status done");
    return {
      success: result.exitCode === 0,
      data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      error: result.exitCode === 0 ? null : result.stderr,
    };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    expect(brokerErrors(sourceCode)).toHaveLength(0);
  });

  it("does not flag .output on non-broker variables", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const aggregate = { output: "ok", error: "" };
    const result = await context.broker.cmd.exec("git", ["log", "--oneline", "-5"]);
    aggregate.output = result.stdout;
    await context.logger.info("done");
    return { success: result.exitCode === 0, data: aggregate, error: null };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    expect(brokerErrors(sourceCode)).toHaveLength(0);
  });
});

describe("DeterministicSelfReviewer exec result inspection", () => {
  const planner = new CandidatePlanner();
  const reviewer = new DeterministicSelfReviewer();

  const makeArtifacts = (sourceCode: string): GeneratedArtifactSet => {
    const opp = createMockOpportunity();
    const plan = planner.plan(opp);
    return {
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
  };

  const brokerErrors = (sourceCode: string) =>
    reviewer
      .review(makeArtifacts(sourceCode))
      .issues.filter((i) => i.severity === "error" && i.category === "broker");

  it("flags exec results whose exitCode is never inspected", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const result = await context.broker.cmd.exec("git", ["log", "--oneline", "-5"]);
    await context.logger.info("done");
    return { success: true, data: { stdout: result.stdout, stderr: result.stderr }, error: null };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    const issues = brokerErrors(sourceCode);
    expect(issues.some((i) => i.message.includes("exitCode is never inspected"))).toBe(true);
  });

  it("flags shell operators passed as literal exec arguments", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const result = await context.broker.cmd.exec("git", ["log", "--oneline", "-5", "&&", "git", "status"]);
    await context.logger.info("done");
    return { success: result.exitCode === 0, data: { stdout: result.stdout }, error: null };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    const issues = brokerErrors(sourceCode);
    expect(issues.some((i) => i.message.includes("does not invoke a shell"))).toBe(true);
  });

  it("flags discarded exec results", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    await context.broker.cmd.exec("git", ["fetch", "--all"]);
    await context.logger.info("done");
    return { success: true, data: null, error: null };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    const issues = brokerErrors(sourceCode);
    expect(issues.some((i) => i.message.includes("result discarded"))).toBe(true);
  });

  it("flags destructuring that omits exitCode", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const { stdout, stderr } = await context.broker.cmd.exec("git", ["log", "--oneline", "-5"]);
    await context.logger.info("done");
    return { success: true, data: { stdout, stderr }, error: null };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    const issues = brokerErrors(sourceCode);
    expect(issues.some((i) => i.message.includes("does not bind 'exitCode'"))).toBe(true);
  });

  it("accepts destructuring that binds and checks exitCode", () => {
    const sourceCode = `
import { defineTool } from "@tool-evolver/runtime";
export default defineTool(async (context) => {
  try {
    const { exitCode, stdout, stderr } = await context.broker.cmd.exec("git", ["log", "--oneline", "-5"]);
    await context.logger.info("done");
    return { success: exitCode === 0, data: { stdout, stderr }, error: exitCode === 0 ? null : stderr };
  } catch (err) {
    await context.logger.error(String(err));
    return { success: false, data: null, error: String(err) };
  }
});
`;
    expect(brokerErrors(sourceCode)).toHaveLength(0);
  });
});
