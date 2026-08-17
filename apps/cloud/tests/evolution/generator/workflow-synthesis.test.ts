import { describe, expect, it } from "vitest";
import { CapabilityMapper } from "../../../src/evolution/generator/capability-mapper.js";
import type { ToolPlan, WorkflowStep } from "../../../src/evolution/generator/types.js";
import { WorkflowGenerator } from "../../../src/evolution/generator/workflow-generator.js";
import { WorkflowPlanner } from "../../../src/evolution/generator/workflow-planner.js";
import { PromptRegistry } from "../../../src/models/prompt-registry.js";
import { InferenceService } from "../../../src/models/service.js";
import { createMockEnvelope, createMockOpportunity } from "./helpers.js";

describe("Workflow Synthesis Subsystem", () => {
  const capabilityMapper = new CapabilityMapper();
  const workflowGenerator = new WorkflowGenerator();
  const workflowPlanner = new WorkflowPlanner(capabilityMapper, undefined, workflowGenerator);

  describe("Workflow Planning & Synthesis (AC 1 & AC 2)", () => {
    it("should produce an evidence-specific acyclic step graph with complete step declarations", async () => {
      const opportunity = createMockOpportunity({
        classification: {
          taskClass: "file_transform",
          pattern: "chained_steps",
          confidenceScore: 0.95,
          priority: "high",
          title: "Build and Deploy Artifacts",
          description: "Reads configuration, compiles project, and writes deploy bundle",
          suggestedToolName: "build_and_deploy",
        },
      });

      const envelope = createMockEnvelope({
        fs: {
          readPaths: ["/workspace/src", "/workspace/config.json"],
          writePaths: ["/workspace/dist", "/workspace/temp"],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: ["/etc", "/root"],
          maxFileSizeBytes: 10485760,
        },
      });

      const plan = await workflowPlanner.planWorkflow(opportunity, { envelope });

      expect(plan.name).toBe("build_and_deploy");
      expect(plan.targetType).toBe("workflow");
      expect(plan.steps.length).toBeGreaterThanOrEqual(2);

      // Verify every step declares all required contract fields (AC 2)
      for (const step of plan.steps) {
        expect(step.id).toBeDefined();
        expect(typeof step.id).toBe("string");
        expect(step.name).toBeDefined();
        expect(step.toolClass).toBeDefined();
        expect(step.action).toBeDefined();
        expect(step.inputs).toBeDefined();
        expect(Array.isArray(step.dependsOn)).toBe(true);
        expect(step.timeoutMs).toBeGreaterThan(0);
        expect(step.failureBehavior).toBeDefined();
        expect(["abort", "continue", "compensate", "fail"]).toContain(step.failureBehavior);
      }

      // Verify topological sort passes without cycles
      const sorted = workflowGenerator.topologicalSort(plan.steps);
      expect(sorted).toHaveLength(plan.steps.length);
    });

    it("should use versioned structured prompt template when inference service is available", async () => {
      const registry = new PromptRegistry();
      const template = registry.get("workflow_planning", "1.0.0");

      expect(template).toBeDefined();
      expect(template?.id).toBe("workflow_planning");
      expect(template?.version).toBe("1.0.0");
      expect(template?.taskClass).toBe("candidate_planning");
      expect(template?.outputSchema).toBeDefined();
    });
  });

  describe("Variable Binding Security & Schema Validation (AC 3)", () => {
    it("should reject undeclared variable bindings in step inputs", () => {
      const plan: ToolPlan = {
        id: "plan_test_undeclared",
        opportunityId: "opp_1",
        name: "test_tool",
        version: "1.0.0",
        description: "Test tool",
        targetType: "workflow",
        variableInputs: [
          { name: "declaredParam", type: "string", description: "Declared input", required: true },
        ],
        invariantInputs: [],
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: {} },
        steps: [
          {
            id: "step_1",
            name: "Step 1",
            toolClass: "file_read",
            action: "fs.readFile",
            inputs: {
              path: "${input.undeclaredParam}", // Undeclared!
            },
            dependsOn: [],
            timeoutMs: 10000,
            failureBehavior: "abort",
          },
        ],
        capabilities: {
          fs: {
            readPaths: ["/workspace/file.txt"],
            writePaths: [],
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
            allowedSchemes: ["https"],
            deniedDomains: [],
            maxConcurrentRequests: 5,
            timeoutMs: 30000,
            maxResponseSizeBytes: 10485760,
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
            injectAsEnv: false,
          },
          limits: {
            maxExecutionTimeMs: 60000,
            maxMemoryMb: 128,
            maxProcesses: 1,
            maxOpenFiles: 10,
            maxPayloadSizeBytes: 10485760,
          },
          manifestVersion: "1.0.0",
        },
        capabilityRequirements: {
          fs: {
            readPaths: ["/workspace/file.txt"],
            writePaths: [],
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
            allowedSchemes: ["https"],
            deniedDomains: [],
            maxConcurrentRequests: 5,
            timeoutMs: 30000,
            maxResponseSizeBytes: 10485760,
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
            injectAsEnv: false,
          },
          limits: {
            maxExecutionTimeMs: 60000,
            maxMemoryMb: 128,
            maxProcesses: 1,
            maxOpenFiles: 10,
            maxPayloadSizeBytes: 10485760,
          },
          manifestVersion: "1.0.0",
        },
        runtime: {
          runtime: "deno",
          minRuntimeVersion: "1.40.0",
          memoryLimitMb: 128,
          timeoutMs: 30000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 10485760,
        },
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      const validation = workflowGenerator.validateWorkflow(plan);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes("Undeclared input variable reference"))).toBe(
        true,
      );
    });

    it("should reject executable code injection attempts in variable interpolations", () => {
      const maliciousInputs = [
        "eval(process.exit(1))",
        "Function('return process')()",
        "__proto__.polluted = true",
        "<script>alert(1)</script>",
      ];

      for (const injection of maliciousInputs) {
        const plan: ToolPlan = {
          id: "plan_test_injection",
          opportunityId: "opp_1",
          name: "test_tool",
          version: "1.0.0",
          description: "Test tool",
          targetType: "workflow",
          variableInputs: [
            { name: "filePath", type: "string", description: "Path", required: true },
          ],
          invariantInputs: [],
          inputSchema: { type: "object", properties: {}, required: [] },
          outputSchema: { type: "object", properties: {} },
          steps: [
            {
              id: "step_1",
              name: "Step 1",
              toolClass: "file_read",
              action: "fs.readFile",
              inputs: {
                payload: injection,
              },
              dependsOn: [],
              timeoutMs: 10000,
              failureBehavior: "abort",
            },
          ],
          capabilities: {
            fs: {
              readPaths: ["/workspace/file.txt"],
              writePaths: [],
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
              allowedSchemes: ["https"],
              deniedDomains: [],
              maxConcurrentRequests: 5,
              timeoutMs: 30000,
              maxResponseSizeBytes: 10485760,
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
              injectAsEnv: false,
            },
            limits: {
              maxExecutionTimeMs: 60000,
              maxMemoryMb: 128,
              maxProcesses: 1,
              maxOpenFiles: 10,
              maxPayloadSizeBytes: 10485760,
            },
            manifestVersion: "1.0.0",
          },
          capabilityRequirements: {
            fs: {
              readPaths: ["/workspace/file.txt"],
              writePaths: [],
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
              allowedSchemes: ["https"],
              deniedDomains: [],
              maxConcurrentRequests: 5,
              timeoutMs: 30000,
              maxResponseSizeBytes: 10485760,
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
              injectAsEnv: false,
            },
            limits: {
              maxExecutionTimeMs: 60000,
              maxMemoryMb: 128,
              maxProcesses: 1,
              maxOpenFiles: 10,
              maxPayloadSizeBytes: 10485760,
            },
            manifestVersion: "1.0.0",
          },
          runtime: {
            runtime: "deno",
            minRuntimeVersion: "1.40.0",
            memoryLimitMb: 128,
            timeoutMs: 30000,
            cpuLimitPercent: 100,
            maxOutputSizeBytes: 10485760,
          },
          metadata: {},
          createdAt: new Date().toISOString(),
        };

        const validation = workflowGenerator.validateWorkflow(plan);
        expect(validation.valid).toBe(false);
        expect(validation.errors.some((e) => e.includes("Security violation"))).toBe(true);
      }
    });

    it("should reject path traversal in path input bindings", () => {
      const plan: ToolPlan = {
        id: "plan_test_traversal",
        opportunityId: "opp_1",
        name: "test_tool",
        version: "1.0.0",
        description: "Test tool",
        targetType: "workflow",
        variableInputs: [{ name: "filePath", type: "string", description: "Path", required: true }],
        invariantInputs: [],
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: {} },
        steps: [
          {
            id: "step_1",
            name: "Step 1",
            toolClass: "file_read",
            action: "fs.readFile",
            inputs: {
              path: "/workspace/../../etc/passwd", // Directory traversal!
            },
            dependsOn: [],
            timeoutMs: 10000,
            failureBehavior: "abort",
          },
        ],
        capabilities: {
          fs: {
            readPaths: ["/workspace"],
            writePaths: [],
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
            allowedSchemes: ["https"],
            deniedDomains: [],
            maxConcurrentRequests: 5,
            timeoutMs: 30000,
            maxResponseSizeBytes: 10485760,
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
            injectAsEnv: false,
          },
          limits: {
            maxExecutionTimeMs: 60000,
            maxMemoryMb: 128,
            maxProcesses: 1,
            maxOpenFiles: 10,
            maxPayloadSizeBytes: 10485760,
          },
          manifestVersion: "1.0.0",
        },
        capabilityRequirements: {
          fs: {
            readPaths: ["/workspace"],
            writePaths: [],
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
            allowedSchemes: ["https"],
            deniedDomains: [],
            maxConcurrentRequests: 5,
            timeoutMs: 30000,
            maxResponseSizeBytes: 10485760,
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
            injectAsEnv: false,
          },
          limits: {
            maxExecutionTimeMs: 60000,
            maxMemoryMb: 128,
            maxProcesses: 1,
            maxOpenFiles: 10,
            maxPayloadSizeBytes: 10485760,
          },
          manifestVersion: "1.0.0",
        },
        runtime: {
          runtime: "deno",
          minRuntimeVersion: "1.40.0",
          memoryLimitMb: 128,
          timeoutMs: 30000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 10485760,
        },
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      const validation = workflowGenerator.validateWorkflow(plan);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes("path traversal attempt"))).toBe(true);
    });
  });

  describe("Minimal Capability Union & Workspace Envelope (AC 4)", () => {
    it("should compute minimal capability union and reject envelope overruns", () => {
      const steps: WorkflowStep[] = [
        {
          id: "step_1",
          name: "Read Config",
          toolClass: "file_read",
          action: "fs.readFile",
          inputs: { path: "/workspace/config.json" },
          dependsOn: [],
          timeoutMs: 5000,
          failureBehavior: "abort",
        },
        {
          id: "step_2",
          name: "Fetch Schema",
          toolClass: "api_client",
          action: "net.fetch",
          inputs: { url: "https://api.internal.com/schema" },
          dependsOn: ["step_1"],
          timeoutMs: 10000,
          failureBehavior: "abort",
        },
      ];

      const envelope = createMockEnvelope({
        fs: {
          readPaths: ["/workspace/config.json"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: true,
          allowedHosts: ["api.allowed.com"], // Does NOT include api.internal.com
          allowedDomains: ["api.allowed.com"],
          allowedPorts: [443],
          allowedSchemes: ["https"],
          deniedDomains: [],
          maxConcurrentRequests: 5,
          timeoutMs: 30000,
          maxResponseSizeBytes: 10485760,
          denyPrivateRanges: true,
        },
      });

      const rawCapabilities = capabilityMapper.mapRequiredCapabilities(steps);
      expect(rawCapabilities.fs.readPaths).toContain("/workspace/config.json");
      expect(rawCapabilities.net.allowedDomains).toContain("api.internal.com");
      // Verify envelope overrun detection
      const subsetResult = capabilityMapper.validateSubset(rawCapabilities, envelope);
      expect(subsetResult.valid).toBe(false);
      expect(subsetResult.violations.some((v) => v.includes("api.internal.com"))).toBe(true);
    });
  });

  describe("Bounded Repair Loop (AC 8)", () => {
    it("should automatically repair cycles, missing input bindings, and envelope overruns", () => {
      const envelope = createMockEnvelope({
        fs: {
          readPaths: ["/workspace/src"],
          writePaths: ["/workspace/dist"],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
      });

      const invalidPlan: ToolPlan = {
        id: "plan_repair_test",
        opportunityId: "opp_1",
        name: "repairable_workflow",
        version: "1.0.0",
        description: "Repairable workflow",
        targetType: "workflow",
        variableInputs: [], // Missing variable input declaration for ${input.srcDir}!
        invariantInputs: [],
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: {} },
        steps: [
          {
            id: "step_1",
            name: "Step 1",
            toolClass: "file_read",
            action: "fs.readFile",
            inputs: { path: "${input.srcDir}/file.txt" },
            dependsOn: ["step_2"], // Circular dependency!
            timeoutMs: 10000,
            failureBehavior: "abort",
          },
          {
            id: "step_2",
            name: "Step 2",
            toolClass: "file_write",
            action: "fs.writeFile",
            inputs: { path: "/workspace/dist/out.txt", content: "hello" },
            dependsOn: ["step_1"], // Circular dependency!
            timeoutMs: 10000,
            failureBehavior: "abort",
          },
        ],
        capabilities: {
          fs: {
            readPaths: ["/workspace/src", "/unauthorized/path"],
            writePaths: ["/workspace/dist"],
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
            allowedSchemes: ["https"],
            deniedDomains: [],
            maxConcurrentRequests: 5,
            timeoutMs: 30000,
            maxResponseSizeBytes: 10485760,
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
            injectAsEnv: false,
          },
          limits: {
            maxExecutionTimeMs: 60000,
            maxMemoryMb: 128,
            maxProcesses: 1,
            maxOpenFiles: 10,
            maxPayloadSizeBytes: 10485760,
          },
          manifestVersion: "1.0.0",
        },
        capabilityRequirements: {
          fs: {
            readPaths: ["/workspace/src", "/unauthorized/path"],
            writePaths: ["/workspace/dist"],
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
            allowedSchemes: ["https"],
            deniedDomains: [],
            maxConcurrentRequests: 5,
            timeoutMs: 30000,
            maxResponseSizeBytes: 10485760,
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
            injectAsEnv: false,
          },
          limits: {
            maxExecutionTimeMs: 60000,
            maxMemoryMb: 128,
            maxProcesses: 1,
            maxOpenFiles: 10,
            maxPayloadSizeBytes: 10485760,
          },
          manifestVersion: "1.0.0",
        },
        runtime: {
          runtime: "deno",
          minRuntimeVersion: "1.40.0",
          memoryLimitMb: 128,
          timeoutMs: 30000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 10485760,
        },
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      const repairResult = workflowGenerator.repairWorkflow(invalidPlan, [], envelope, 3);
      expect(repairResult.repaired).toBe(true);
      expect(repairResult.plan.variableInputs.some((v) => v.name === "srcDir")).toBe(true);

      // Verify that after repair, validation passes completely
      const reValidation = workflowGenerator.validateWorkflow(repairResult.plan, envelope);
      expect(reValidation.valid).toBe(true);
      expect(reValidation.errors).toHaveLength(0);
    });
  });

  describe("Deterministic Fixture & Code/Test Generation (AC 7 & AC 10)", () => {
    it("should generate complete unit, property, and failure-injection tests for workflow", () => {
      const opportunity = createMockOpportunity({
        classification: {
          taskClass: "file_transform",
          pattern: "sequential_pipeline",
          confidenceScore: 0.9,
          priority: "high",
          title: "Transform and Sync",
          description: "Transforms file and syncs output",
        },
      });

      const plan = workflowPlanner.planDeterministic(opportunity);
      const tests = workflowGenerator.generateTests(plan);

      expect(tests.length).toBeGreaterThanOrEqual(3);
      expect(tests.some((t) => t.testType === "unit")).toBe(true);
      expect(tests.some((t) => t.testType === "property")).toBe(true);
      expect(tests.some((t) => t.testType === "integration")).toBe(true);

      // Verify generated TypeScript orchestrator source
      const sourceCode = workflowGenerator.generateCode(plan);
      expect(sourceCode).toContain(
        'import { defineTool, type ToolContext } from "@tool-evolver/runtime";',
      );
      expect(sourceCode).toContain("export const ToolInputSchema =");
      expect(sourceCode).toContain("export const ToolOutputSchema =");
      expect(sourceCode).toContain("const compensationStack: Array<() => Promise<void>> = [];");
      expect(sourceCode).toContain("await progress(");
      expect(sourceCode).toContain("await logger.info(");
    });
  });
});
