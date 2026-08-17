import { CompensationManager } from "@tool-evolver/runtime";
import { describe, expect, it } from "vitest";
import type { ToolPlan, WorkflowStep } from "../../../src/evolution/generator/types.js";
import { WorkflowGenerator } from "../../../src/evolution/generator/workflow-generator.js";
import { WorkflowPlanner } from "../../../src/evolution/generator/workflow-planner.js";

describe("Workflow Safe Compensation Subsystem (AC 5)", () => {
  const workflowPlanner = new WorkflowPlanner();
  const workflowGenerator = new WorkflowGenerator();

  describe("Deterministic Safe Inverse Derivation", () => {
    it("should synthesize safe inverse for fs.writeFile operations", () => {
      const comp = workflowPlanner.generateSafeCompensation(
        "fs.writeFile",
        { path: "/workspace/config.json", content: "data" },
        "fs",
      );

      expect(comp).toBeDefined();
      expect(comp?.action).toBe("fs.remove");
      expect(comp?.service).toBe("fs");
      expect(comp?.inputs.path).toBe("/workspace/config.json");
      expect(comp?.deterministicInverse).toBe(true);
    });

    it("should synthesize safe inverse for fs.createDirectory operations", () => {
      const comp = workflowPlanner.generateSafeCompensation(
        "fs.createDirectory",
        { path: "/workspace/build/temp" },
        "fs",
      );

      expect(comp).toBeDefined();
      expect(comp?.action).toBe("fs.remove");
      expect(comp?.inputs.path).toBe("/workspace/build/temp");
      expect(comp?.inputs.recursive).toBe(true);
      expect(comp?.deterministicInverse).toBe(true);
    });

    it("should synthesize safe inverse for fs.copy operations", () => {
      const comp = workflowPlanner.generateSafeCompensation(
        "fs.copy",
        { source: "/workspace/src/app.ts", destination: "/workspace/dist/app.ts" },
        "fs",
      );

      expect(comp).toBeDefined();
      expect(comp?.action).toBe("fs.remove");
      expect(comp?.inputs.path).toBe("/workspace/dist/app.ts");
      expect(comp?.deterministicInverse).toBe(true);
    });

    it("should synthesize safe inverse for fs.move operations by reversing source and destination", () => {
      const comp = workflowPlanner.generateSafeCompensation(
        "fs.move",
        { source: "/workspace/temp/file.txt", destination: "/workspace/data/file.txt" },
        "fs",
      );

      expect(comp).toBeDefined();
      expect(comp?.action).toBe("fs.move");
      expect(comp?.inputs.source).toBe("/workspace/data/file.txt");
      expect(comp?.inputs.destination).toBe("/workspace/temp/file.txt");
      expect(comp?.deterministicInverse).toBe(true);
    });

    it("should synthesize safe inverse for reversible commands with rollback specification", () => {
      const comp = workflowPlanner.generateSafeCompensation(
        "cmd.exec",
        {
          command: "git tag -a v1.0.0 -m 'Release'",
          rollbackCommand: "git tag -d v1.0.0",
        },
        "cmd",
      );

      expect(comp).toBeDefined();
      expect(comp?.action).toBe("cmd.exec");
      expect(comp?.inputs.command).toBe("git tag -d v1.0.0");
      expect(comp?.deterministicInverse).toBe(true);
    });

    it("should NOT generate synthetic compensation for irreversible operations", () => {
      const irreversibleActions = [
        { action: "fs.remove", inputs: { path: "/workspace/precious-data.db" } },
        { action: "net.delete", inputs: { url: "https://api.cloud.com/v1/database" } },
        { action: "cmd.kill", inputs: { pid: 12345 } },
      ];

      for (const item of irreversibleActions) {
        const comp = workflowPlanner.generateSafeCompensation(item.action, item.inputs);
        expect(comp).toBeUndefined();
      }
    });
  });

  describe("Compensation Action Validation & Safety Gates", () => {
    it("should reject compensation actions attached to irreversible operations without backup", () => {
      const plan: ToolPlan = {
        id: "plan_unsafe_comp",
        opportunityId: "opp_1",
        name: "unsafe_tool",
        version: "1.0.0",
        description: "Unsafe tool",
        targetType: "workflow",
        variableInputs: [{ name: "filePath", type: "string", description: "Path", required: true }],
        invariantInputs: [],
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: {} },
        steps: [
          {
            id: "step_1",
            name: "Delete Database",
            toolClass: "file_write",
            action: "fs.remove", // Irreversible deletion!
            inputs: { path: "${input.filePath}" },
            dependsOn: [],
            timeoutMs: 10000,
            failureBehavior: "abort",
            compensation: {
              action: "fs.writeFile", // Fake unbacked compensation!
              inputs: { path: "${input.filePath}", content: "fake restore" },
              deterministicInverse: false,
            },
          },
        ],
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
      expect(
        validation.errors.some((e) => e.includes('Unsafe compensation in step "step_1"')),
      ).toBe(true);
    });

    it("should remove unsafe compensation actions during bounded repair loop", () => {
      const plan: ToolPlan = {
        id: "plan_repair_comp",
        opportunityId: "opp_1",
        name: "repair_tool",
        version: "1.0.0",
        description: "Repair tool",
        targetType: "workflow",
        variableInputs: [{ name: "filePath", type: "string", description: "Path", required: true }],
        invariantInputs: [],
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: {} },
        steps: [
          {
            id: "step_1",
            name: "Delete File",
            toolClass: "file_write",
            action: "fs.remove",
            inputs: { path: "${input.filePath}" },
            dependsOn: [],
            timeoutMs: 10000,
            failureBehavior: "abort",
            compensation: {
              action: "fs.writeFile",
              inputs: { path: "${input.filePath}" },
              deterministicInverse: false,
            },
          },
        ],
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

      const repair = workflowGenerator.repairWorkflow(plan);
      expect(repair.repaired).toBe(true);
      expect(repair.plan.steps[0].compensation).toBeUndefined();
      expect(repair.appliedFixes.some((f) => f.includes("Removed unsafe compensation"))).toBe(true);
    });
  });

  describe("Compensation Manager Runtime Unwinding", () => {
    it("should execute registered compensation actions in reverse LIFO order with error resilience", async () => {
      const manager = new CompensationManager();
      const rollbackLog: string[] = [];

      const step1: WorkflowStep = {
        id: "step_1",
        name: "Create Temp Dir",
        toolClass: "file_write",
        action: "fs.createDirectory",
        inputs: { path: "/workspace/temp_build" },
        dependsOn: [],
        compensation: {
          action: "fs.remove",
          service: "fs",
          inputs: { path: "/workspace/temp_build", recursive: true },
        },
      };

      const step2: WorkflowStep = {
        id: "step_2",
        name: "Write Bundle",
        toolClass: "file_write",
        action: "fs.writeFile",
        inputs: { path: "/workspace/temp_build/bundle.js", content: "..." },
        dependsOn: ["step_1"],
        compensation: {
          action: "fs.remove",
          service: "fs",
          inputs: { path: "/workspace/temp_build/bundle.js" },
        },
      };

      manager.registerStep(step1, { created: true });
      manager.registerStep(step2, { writtenBytes: 100 });

      expect(manager.count).toBe(2);

      const mockBrokerHandler = async (
        service: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        rollbackLog.push(`${action}:${payload.path}`);
        if (payload.path === "/workspace/temp_build/bundle.js") {
          // Simulate error on first rollback
          throw new Error("Failed to delete bundle.js (locked)");
        }
      };

      const results = await manager.executeCompensation(
        { brokerHandler: mockBrokerHandler },
        { workflowInputs: {}, stepResults: {} },
      );

      // Verify LIFO order: step_2 rollback executed BEFORE step_1 rollback
      expect(rollbackLog).toEqual([
        "fs.remove:/workspace/temp_build/bundle.js",
        "fs.remove:/workspace/temp_build",
      ]);

      // Verify error resilience: step_2 failed, but step_1 continued and succeeded
      expect(results).toHaveLength(2);
      expect(results[0].stepId).toBe("step_2");
      expect(results[0].status).toBe("failed");
      expect(results[0].error).toContain("Failed to delete bundle.js");

      expect(results[1].stepId).toBe("step_1");
      expect(results[1].status).toBe("compensated");
    });
  });
});
