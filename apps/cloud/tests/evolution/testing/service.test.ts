import { describe, expect, it } from "vitest";
import {
  type CandidateValidationService,
  createCandidateValidationService,
} from "../../../src/evolution/testing/service.js";
import {
  CMD_TOOL_SOURCE,
  FS_TOOL_SOURCE,
  NET_TOOL_SOURCE,
  PURE_COMPUTE_TOOL_SOURCE,
  SECRET_TOOL_SOURCE,
  createMockCandidateRevision,
  createMockManifest,
  createMockPlan,
} from "./helpers.js";

describe("CandidateValidationService (End-to-End Candidate Validation)", () => {
  const service: CandidateValidationService = createCandidateValidationService();
  describe("Successful Validation Passes", () => {
    it("should pass validation for pure compute candidate revision", async () => {
      const revision = createMockCandidateRevision();
      const result = await service.validateCandidate(revision, { skipLlmTestSynthesis: true });
      expect(result.candidateId).toBe(revision.candidateId);
      expect(result.revisionId).toBe(revision.revisionId);
      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
      expect(result.typecheckPassed).toBe(true);
      expect(result.staticFindings.filter((f) => f.severity === "error")).toHaveLength(0);
      expect(result.testReport).toBeDefined();
      expect(result.testReport?.passed).toBeGreaterThan(0);
      expect(result.testReport?.failed).toBe(0);
      expect(result.coverage).toBeDefined();
      expect(result.coverage?.statementCoveragePercent).toBeGreaterThanOrEqual(70);
    });

    it("should pass validation for filesystem candidate with valid capabilities", async () => {
      const manifest = createMockManifest({
        name: "file_processor",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
        },
        capabilities: {
          fs: {
            readPaths: ["/workspace"],
            writePaths: ["/workspace"],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 10485760,
          },
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
        },
      });

      const result = await service.validateCandidate(
        {
          id: "cand-fs",
          manifest,
          sourceCode: FS_TOOL_SOURCE,
          requiredCapabilities: manifest.capabilities,
        },
        { skipLlmTestSynthesis: true },
      );

      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
      expect(result.testReport?.passed).toBeGreaterThan(0);
    });

    it("should pass validation for network candidate with valid capabilities", async () => {
      const manifest = createMockManifest({
        name: "network_fetcher",
        parameters: {
          type: "object",
          properties: {
            endpointUrl: { type: "string" },
          },
          required: ["endpointUrl"],
        },
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: [],
            allowWorkspaceRoot: false,
            allowTemp: false,
            denyPaths: [],
            maxFileSizeBytes: 10485760,
          },
          net: {
            allowOutbound: true,
            allowedDomains: ["api.example.com"],
            allowedHosts: [],
            allowedPorts: [443],
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
        },
      });

      const result = await service.validateCandidate(
        {
          id: "cand-net",
          manifest,
          sourceCode: NET_TOOL_SOURCE,
          requiredCapabilities: manifest.capabilities,
        },
        { skipLlmTestSynthesis: true },
      );

      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
    });

    it("should pass validation for command and secret candidates", async () => {
      const cmdManifest = createMockManifest({
        name: "cmd_runner",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: [],
            allowWorkspaceRoot: false,
            allowTemp: false,
            denyPaths: [],
            maxFileSizeBytes: 10485760,
          },
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
            allowShellExecution: true,
            allowedCommands: ["echo"],
            allowedBinaries: ["echo"],
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
        },
      });

      const cmdResult = await service.validateCandidate(
        {
          id: "cand-cmd",
          manifest: cmdManifest,
          sourceCode: CMD_TOOL_SOURCE,
          requiredCapabilities: cmdManifest.capabilities,
        },
        { skipLlmTestSynthesis: true },
      );
      expect(cmdResult.status).toBe("pass");

      const secManifest = createMockManifest({
        name: "secret_consumer",
        parameters: {
          type: "object",
          properties: {
            secretName: { type: "string" },
          },
          required: ["secretName"],
        },
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: [],
            allowWorkspaceRoot: false,
            allowTemp: false,
            denyPaths: [],
            maxFileSizeBytes: 10485760,
          },
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
          secrets: {
            allowedSecretNames: ["API_KEY"],
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
        },
      });

      const secResult = await service.validateCandidate(
        {
          id: "cand-sec",
          manifest: secManifest,
          sourceCode: SECRET_TOOL_SOURCE,
          requiredCapabilities: secManifest.capabilities,
        },
        { skipLlmTestSynthesis: true },
      );
      expect(secResult.status).toBe("pass");
    });
  });

  describe("Rejection on Security & Parity Violations", () => {
    it("should return terminal_fail when forbidden native addons or remote imports are used", async () => {
      const badCode = `
        import addon from "./native.node";
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async () => { return { success: true }; });
      `;

      const manifest = createMockManifest();
      const result = await service.validateCandidate({
        id: "cand-bad-import",
        manifest,
        sourceCode: badCode,
      });

      expect(result.status).toBe("terminal_fail");
      expect(result.passed).toBe(false);
      expect(result.repairFeedback?.canRepair).toBe(false);
      expect(result.staticFindings.some((f) => f.category === "forbidden_import")).toBe(true);
    });

    it("should return repairable_fail and recommend capabilities on undeclared broker calls", async () => {
      const manifest = createMockManifest({
        name: "file_tool_without_caps",
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: [],
            allowWorkspaceRoot: false,
            allowTemp: false,
            denyPaths: [],
            maxFileSizeBytes: 10485760,
          },
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
        },
      });

      const result = await service.validateCandidate({
        id: "cand-undeclared",
        manifest,
        sourceCode: FS_TOOL_SOURCE,
        requiredCapabilities: manifest.capabilities,
      });

      expect(result.status).toBe("repairable_fail");
      expect(result.passed).toBe(false);
      expect(result.repairFeedback).toBeDefined();
      expect(result.repairFeedback?.canRepair).toBe(true);
      expect(result.repairFeedback?.recommendedChanges.capabilities?.fs).toBeDefined();
      expect(result.repairFeedback?.recommendedChanges.capabilities?.fs?.allowWorkspaceRoot).toBe(
        true,
      );
    });
  });

  describe("Syntax & Typecheck Failure Handling", () => {
    it("should return repairable_fail on syntax error with diagnostic fix hints", async () => {
      const brokenTs = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (ctx) => {
          const a: number = "unclosed string;
          return { success: true };
        });
      `;

      const result = await service.validateCandidate({
        id: "cand-syntax-err",
        manifest: createMockManifest(),
        sourceCode: brokenTs,
      });

      expect(result.status).toBe("repairable_fail");
      expect(result.passed).toBe(false);
      expect(result.typecheckPassed).toBe(false);
      expect(result.repairFeedback?.suggestedFixes.length).toBeGreaterThan(0);
    });
  });

  describe("Structured Repair Feedback Generation", () => {
    it("should formulate actionable repair feedback when tool logic fails tests", async () => {
      const failingToolSource = `
        import { defineTool } from "@tool-evolver/runtime";
        import { z } from "zod";

        export const InputSchema = z.object({
          a: z.number(),
          b: z.number(),
        });

        export const OutputSchema = z.object({
          success: z.boolean(),
          result: z.number(),
        });

        export default defineTool(async (ctx) => {
          // Intentionally broken calculation
          throw new Error("Simulated internal algorithm failure");
        });
      `;

      const manifest = createMockManifest({ name: "failing_math" });
      const result = await service.validateCandidate(
        {
          id: "cand-failing-tests",
          manifest,
          sourceCode: failingToolSource,
        },
        { skipLlmTestSynthesis: true },
      );

      expect(result.status).toBe("repairable_fail");
      expect(result.passed).toBe(false);
      expect(result.testReport?.failed).toBeGreaterThan(0);
      expect(result.repairFeedback).toBeDefined();
      expect(result.repairFeedback?.canRepair).toBe(true);
      expect(result.repairFeedback?.failedTestSummaries.length).toBeGreaterThan(0);
    });
  });

  describe("Candidate Target Polymorphism", () => {
    it("should validate EvolutionCandidate contract instance", async () => {
      const candidate = {
        id: "cand-contract-123",
        workspaceId: "ws-test-456",
        state: "synthesized" as const,
        trigger: {
          reason: "repeated_pattern" as const,
          evidenceEventIds: ["ev-1"],
          sessionOccurrences: 2,
          detectedAt: new Date().toISOString(),
          patternFrequency: 3,
        },
        proposedTool: createMockManifest({ name: "math_evaluator" }),
        requiredCapabilities: createMockManifest().capabilities,
        sourceCode: PURE_COMPUTE_TOOL_SOURCE,
        createdAt: new Date().toISOString(),
      };

      const result = await service.validateCandidate(candidate, { skipLlmTestSynthesis: true });
      expect(result.candidateId).toBe("cand-contract-123");
      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
    });
  });
});
