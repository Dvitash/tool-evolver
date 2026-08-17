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
