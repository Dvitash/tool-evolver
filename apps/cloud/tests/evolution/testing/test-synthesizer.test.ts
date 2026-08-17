import { describe, expect, it, vi } from "vitest";
import { TestSynthesizer } from "../../../src/evolution/testing/test-synthesizer.js";
import type { InferenceService } from "../../../src/models/service.js";
import {
  CMD_TOOL_SOURCE,
  FS_TOOL_SOURCE,
  NET_TOOL_SOURCE,
  PURE_COMPUTE_TOOL_SOURCE,
  createMockManifest,
  createMockPlan,
} from "./helpers.js";

describe("TestSynthesizer (Deterministic & LLM Test Generation)", () => {
  const synthesizer = new TestSynthesizer();

  describe("Deterministic Baseline Test Synthesis", () => {
    it("should synthesize complete baseline test suite for pure compute tool", async () => {
      const manifest = createMockManifest({ name: "math_evaluator" });
      const plan = createMockPlan();

      const suite = await synthesizer.synthesize(manifest, PURE_COMPUTE_TOOL_SOURCE, plan, { skipLlm: true });

      expect(suite.suiteId).toBeDefined();
      expect(suite.toolName).toBe("math_evaluator");
      expect(suite.llmAssisted).toBe(false);
      expect(suite.cases.length).toBeGreaterThan(0);

      // Check happy path
      const happyPath = suite.cases.find((c) => c.testType === "happy_path");
      expect(happyPath).toBeDefined();
      expect(happyPath?.expectedOutcome).toBe("success");
      expect(happyPath?.input).toEqual(expect.objectContaining({ a: 10, b: 10 }));

      // Check schema boundary missing required
      const missingA = suite.cases.find(
        (c) => c.testType === "schema_boundary" && c.name.includes("Missing Required 'a'")
      );
      expect(missingA).toBeDefined();
      expect(missingA?.expectedOutcome).toBe("validation_error");
      expect(missingA?.input).not.toHaveProperty("a");

      // Check schema boundary invalid type
      const invalidTypeA = suite.cases.find(
        (c) => c.testType === "schema_boundary" && c.name.includes("Invalid Type for 'a'")
      );
      expect(invalidTypeA).toBeDefined();
      expect(invalidTypeA?.expectedOutcome).toBe("validation_error");

      // Check edge cases
      const zeroEdgeCase = suite.cases.find(
        (c) => c.testType === "edge_case" && c.name.includes("Zero Value")
      );
      expect(zeroEdgeCase).toBeDefined();

      // Check idempotency
      const idempotency = suite.cases.find((c) => c.testType === "idempotency");
      expect(idempotency).toBeDefined();
      expect(idempotency?.expectedOutcome).toBe("success");
    });

    it("should synthesize error mode tests for filesystem capabilities", async () => {
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
          net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https"], allowLocalhost: false, denyPrivateRanges: true },
          command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
          secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
          limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
        },
      });

      const suite = await synthesizer.synthesize(manifest, FS_TOOL_SOURCE, undefined, { skipLlm: true });

      const fsErrorMode = suite.cases.find(
        (c) => c.testType === "error_mode" && c.name.includes("Filesystem ENOENT")
      );
      expect(fsErrorMode).toBeDefined();
      expect(fsErrorMode?.expectedOutcome).toBe("execution_error");
      expect(fsErrorMode?.mockBrokerConfig?.fs?.simulateErrors).toBeDefined();
    });

    it("should synthesize error mode tests for network capabilities", async () => {
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
          fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 10485760 },
          net: { allowOutbound: true, allowedDomains: ["api.example.com"], allowedHosts: [], allowedPorts: [443], allowedProtocols: ["https"], allowLocalhost: false, denyPrivateRanges: true },
          command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
          secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
          limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
        },
      });

      const suite = await synthesizer.synthesize(manifest, NET_TOOL_SOURCE, undefined, { skipLlm: true });

      const netErrorMode = suite.cases.find(
        (c) => c.testType === "error_mode" && c.name.includes("Network Connection Refused")
      );
      expect(netErrorMode).toBeDefined();
      expect(netErrorMode?.expectedOutcome).toBe("execution_error");
    });

    it("should synthesize error mode tests for command capabilities", async () => {
      const manifest = createMockManifest({
        name: "command_exec",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
        capabilities: {
          fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 10485760 },
          net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https"], allowLocalhost: false, denyPrivateRanges: true },
          command: { allowShellExecution: true, allowedCommands: ["echo"], allowedBinaries: ["echo"], forbiddenPatterns: [], allowEnvPassthrough: [] },
          secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
          limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
        },
      });

      const suite = await synthesizer.synthesize(manifest, CMD_TOOL_SOURCE, undefined, { skipLlm: true });

      const cmdErrorMode = suite.cases.find(
        (c) => c.testType === "error_mode" && c.name.includes("Command Execution Failure")
      );
      expect(cmdErrorMode).toBeDefined();
      expect(cmdErrorMode?.expectedOutcome).toBe("execution_error");
    });
  });

  describe("LLM-Assisted Test Synthesis", () => {
    it("should augment suite with LLM generated unit and property tests", async () => {
      const mockInferenceService = {
        infer: vi.fn().mockResolvedValue({
          requestId: "req-123",
          tenantId: "tenant-1",
          output: {
            suiteId: "llm-suite-1",
            targetTool: "math_evaluator",
            unitTests: [
              {
                name: "Large Number Addition",
                description: "Tests addition of 10^6 operands",
                code: "test code",
              },
            ],
            propertyTests: [
              {
                name: "Commutativity of Addition",
                property: "a + b === b + a",
                code: "property code",
              },
            ],
            edgeCases: ["NaN", "Infinity"],
          },
        }),
      } as unknown as InferenceService;

      const manifest = createMockManifest({ name: "math_evaluator" });
      const suite = await synthesizer.synthesize(manifest, PURE_COMPUTE_TOOL_SOURCE, undefined, {
        inferenceService: mockInferenceService,
        skipLlm: false,
      });

      expect(suite.llmAssisted).toBe(true);
      expect(mockInferenceService.infer).toHaveBeenCalledWith(
        expect.objectContaining({
          taskClass: "test_generation",
          promptTemplateId: "test_generation",
        })
      );

      const llmUnit = suite.cases.find((c) => c.name.includes("LLM Unit - Large Number Addition"));
      const llmProp = suite.cases.find((c) => c.name.includes("LLM Property - Commutativity of Addition"));

      expect(llmUnit).toBeDefined();
      expect(llmProp).toBeDefined();
    });

    it("should fall back gracefully to deterministic tests when LLM inference fails", async () => {
      const failingInferenceService = {
        infer: vi.fn().mockRejectedValue(new Error("LLM provider unavailable")),
      } as unknown as InferenceService;

      const manifest = createMockManifest({ name: "math_evaluator" });
      const suite = await synthesizer.synthesize(manifest, PURE_COMPUTE_TOOL_SOURCE, undefined, {
        inferenceService: failingInferenceService,
        skipLlm: false,
      });

      expect(suite.llmAssisted).toBe(false);
      expect(suite.cases.length).toBeGreaterThan(0);
      expect(suite.cases.some((c) => c.testType === "happy_path")).toBe(true);
    });
  });
});
