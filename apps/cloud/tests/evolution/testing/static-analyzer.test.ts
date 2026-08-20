import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../../../src/evolution/testing/static-analyzer.js";
import {
  CMD_TOOL_SOURCE,
  FS_TOOL_SOURCE,
  NET_TOOL_SOURCE,
  PURE_COMPUTE_TOOL_SOURCE,
  SECRET_TOOL_SOURCE,
  createMockManifest,
} from "./helpers.js";

describe("StaticAnalyzer (AST & Security Analysis)", () => {
  const analyzer = new StaticAnalyzer();

  describe("Clean Candidate Tool Validations", () => {
    it("should pass static analysis for pure compute tool with no errors", () => {
      const manifest = createMockManifest({ name: "math_evaluator" });
      const findings = analyzer.analyze(PURE_COMPUTE_TOOL_SOURCE, manifest, manifest.capabilities);

      const errors = findings.filter((f) => f.severity === "error");
      expect(errors).toHaveLength(0);
    });

    it("should pass static analysis for filesystem tool with valid fs capabilities", () => {
      const manifest = createMockManifest({
        name: "file_processor",
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

      const findings = analyzer.analyze(FS_TOOL_SOURCE, manifest, manifest.capabilities);
      const errors = findings.filter((f) => f.severity === "error");
      expect(errors).toHaveLength(0);
    });

    it("should pass static analysis for network tool with valid net capabilities", () => {
      const manifest = createMockManifest({
        name: "data_fetcher",
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

      const findings = analyzer.analyze(NET_TOOL_SOURCE, manifest, manifest.capabilities);
      const errors = findings.filter((f) => f.severity === "error");
      expect(errors).toHaveLength(0);
    });

    it("should pass static analysis for command tool with valid command capabilities", () => {
      const manifest = createMockManifest({
        name: "command_runner",
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

      const findings = analyzer.analyze(CMD_TOOL_SOURCE, manifest, manifest.capabilities);
      const errors = findings.filter((f) => f.severity === "error");
      expect(errors).toHaveLength(0);
    });

    it("should pass static analysis for secret tool with valid secrets capability", () => {
      const manifest = createMockManifest({
        name: "secret_consumer",
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

      const findings = analyzer.analyze(SECRET_TOOL_SOURCE, manifest, manifest.capabilities);
      const errors = findings.filter((f) => f.severity === "error");
      expect(errors).toHaveLength(0);
    });
  });

  describe("Forbidden Imports & APIs", () => {
    it("should detect direct node:fs or fs imports", () => {
      const badCode = `
        import fs from "node:fs";
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (ctx) => { return { success: true }; });
      `;

      const findings = analyzer.analyze(badCode);
      const fsFinding = findings.find(
        (f) => f.category === "forbidden_import" && f.message.includes("node:fs"),
      );
      expect(fsFinding).toBeDefined();
      expect(fsFinding?.severity).toBe("error");
    });

    it("should detect direct node:child_process or child_process imports", () => {
      const badCode = `
        import { execSync } from "child_process";
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (ctx) => { return { success: true }; });
      `;

      const findings = analyzer.analyze(badCode);
      const cpFinding = findings.find(
        (f) => f.category === "forbidden_import" && f.message.includes("child_process"),
      );
      expect(cpFinding).toBeDefined();
    });

    it("should detect native addon (.node) and remote URL imports", () => {
      const badCode = `
        import nativeAddon from "./binding.node";
        import remoteMod from "https://example.com/remote.js";
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (ctx) => { return { success: true }; });
      `;

      const findings = analyzer.analyze(badCode);
      const nativeFinding = findings.find((f) => f.message.includes(".node"));
      const remoteFinding = findings.find((f) => f.message.includes("Remote URL"));

      expect(nativeFinding).toBeDefined();
      expect(remoteFinding).toBeDefined();
    });

    it("should detect dynamic import() expressions", () => {
      const badCode = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (ctx) => {
          const mod = await import("some-module");
          return { success: true };
        });
      `;

      const findings = analyzer.analyze(badCode);
      const dynFinding = findings.find((f) => f.message.includes("Dynamic import()"));
      expect(dynFinding).toBeDefined();
      expect(dynFinding?.severity).toBe("error");
    });

    it("should detect forbidden globals: eval, Function, process.exit", () => {
      const badCode = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (ctx) => {
          eval("2 + 2");
          const fn = new Function("a", "return a * 2");
          process.exit(1);
          return { success: true };
        });
      `;

      const findings = analyzer.analyze(badCode);
      expect(findings.some((f) => f.message.includes("eval()"))).toBe(true);
      expect(findings.some((f) => f.message.includes("Function()"))).toBe(true);
      expect(findings.some((f) => f.message.includes("process.exit"))).toBe(true);
    });
  });

  describe("Broker-Manifest Parity Validation", () => {
    it("should report undeclared filesystem capability when broker.fs is called without fs grant", () => {
      const manifest = createMockManifest({
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

      const findings = analyzer.analyze(FS_TOOL_SOURCE, manifest, manifest.capabilities);
      const undeclaredFs = findings.find(
        (f) => f.category === "undeclared_capability" && f.message.includes("filesystem"),
      );
      expect(undeclaredFs).toBeDefined();
      expect(undeclaredFs?.severity).toBe("error");
    });

    it("should report undeclared network capability when broker.net.fetch is called without net.allowOutbound", () => {
      const manifest = createMockManifest({
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

      const findings = analyzer.analyze(NET_TOOL_SOURCE, manifest, manifest.capabilities);
      const undeclaredNet = findings.find(
        (f) => f.category === "undeclared_capability" && f.message.includes("network"),
      );
      expect(undeclaredNet).toBeDefined();
      expect(undeclaredNet?.severity).toBe("error");
    });

    it("should report undeclared command execution capability when broker.cmd is called", () => {
      const manifest = createMockManifest({
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

      const findings = analyzer.analyze(CMD_TOOL_SOURCE, manifest, manifest.capabilities);
      const undeclaredCmd = findings.find(
        (f) => f.category === "undeclared_capability" && f.message.includes("command"),
      );
      expect(undeclaredCmd).toBeDefined();
      expect(undeclaredCmd?.severity).toBe("error");
    });

    it("should report undeclared secret capability when broker.secret is called", () => {
      const manifest = createMockManifest({
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

      const findings = analyzer.analyze(SECRET_TOOL_SOURCE, manifest, manifest.capabilities);
      const undeclaredSecret = findings.find(
        (f) => f.category === "undeclared_capability" && f.message.includes("secret"),
      );
      expect(undeclaredSecret).toBeDefined();
      expect(undeclaredSecret?.severity).toBe("error");
    });
  });

  describe("Static Flaws Detection", () => {
    it("should detect infinite while(true) loops without exit mechanism", () => {
      const loopCode = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (ctx) => {
          while (true) {
            const x = 1;
          }
          return { success: true };
        });
      `;

      const findings = analyzer.analyze(loopCode);
      const loopFinding = findings.find(
        (f) => f.category === "static_flaw" && f.message.includes("infinite loop"),
      );
      expect(loopFinding).toBeDefined();
      expect(loopFinding?.severity).toBe("error");
    });

    it("should detect swallowed errors in empty catch blocks", () => {
      const swallowCode = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (ctx) => {
          try {
            const x = 1;
          } catch (e) {}
          return { success: true };
        });
      `;

      const findings = analyzer.analyze(swallowCode);
      const catchFinding = findings.find(
        (f) => f.category === "static_flaw" && f.message.includes("Swallowed error"),
      );
      expect(catchFinding).toBeDefined();
    });

    it("should detect catastrophic backtracking regex literals (ReDoS)", () => {
      const redosCode = `
        import { defineTool } from "@tool-evolver/runtime";
        const PATTERN = /(a+)+$/;
        export default defineTool(async (ctx) => {
          PATTERN.test("aaaaaaaaaaaaaaaa");
          return { success: true };
        });
      `;

      const findings = analyzer.analyze(redosCode);
      const redosFinding = findings.find(
        (f) => f.category === "static_flaw" && f.message.includes("catastrophic backtracking"),
      );
      expect(redosFinding).toBeDefined();
      expect(redosFinding?.severity).toBe("error");
    });

    it("should reject shell globs passed as literal command file operands", () => {
      const globCode = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (context) => {
          await context.broker.cmd.exec("wc", ["-l", "module_*.txt"]);
          await context.broker.cmd.exec("grep", ["-o", "TODO", "module_*.txt"]);
          return { success: true };
        });
      `;

      const findings = analyzer.analyze(globCode);
      const globFindings = findings.filter(
        (finding) =>
          finding.category === "static_flaw" &&
          finding.message.includes("do not expand shell globs"),
      );
      expect(globFindings).toHaveLength(2);
      expect(globFindings.every((finding) => finding.severity === "error")).toBe(true);
    });

    it("should allow patterns interpreted by the command itself", () => {
      const findCode = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (context) => {
          await context.broker.cmd.exec("find", [".", "-name", "module_*.txt"]);
          return { success: true };
        });
      `;

      const findings = analyzer.analyze(findCode);
      expect(findings.some((finding) => finding.message.includes("do not expand shell globs"))).toBe(
        false,
      );
    });

    it("should reject literal executables outside command allowedBinaries", () => {
      const shellCode = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (context) => {
          await context.broker.cmd.exec("sh", ["-c", "wc -l module_*.txt"]);
          return { success: true };
        });
      `;
      const manifest = createMockManifest();
      manifest.capabilities!.command.allowedBinaries = ["git", "grep", "wc"];
      manifest.capabilities!.command.allowedCommands = ["git status --porcelain"];

      const findings = analyzer.analyze(shellCode, manifest, manifest.capabilities);
      const binaryFinding = findings.find(
        (finding) =>
          finding.category === "undeclared_capability" &&
          finding.message.includes("executable 'sh'"),
      );
      expect(binaryFinding).toBeDefined();
      expect(binaryFinding?.severity).toBe("error");
    });

    it("should warn on top-level mutable collections accumulating state across runs", () => {
      const leakCode = `
        import { defineTool } from "@tool-evolver/runtime";
        const globalCache = new Map();
        export default defineTool(async (ctx) => {
          globalCache.set("key", "value");
          return { success: true };
        });
      `;

      const findings = analyzer.analyze(leakCode);
      const leakFinding = findings.find(
        (f) =>
          f.category === "static_flaw" && f.message.includes("retains state across invocations"),
      );
      expect(leakFinding).toBeDefined();
      expect(leakFinding?.severity).toBe("warning");
    });
  });

  describe("Structural AST Requirements", () => {
    it("should report error when export default defineTool is missing", () => {
      const missingExport = `
        import { z } from "zod";
        const x = 10;
      `;

      const findings = analyzer.analyze(missingExport);
      const structureFinding = findings.find((f) =>
        f.message.includes("default export wrapped with 'defineTool'"),
      );
      expect(structureFinding).toBeDefined();
      expect(structureFinding?.severity).toBe("error");
    });

    it("should provide line and column numbers for diagnostics", () => {
      const badCode = `import fs from "fs";\nexport default defineTool(async () => {});`;
      const findings = analyzer.analyze(badCode);
      expect(findings[0]?.location).toEqual({ line: 1, column: 1 });
    });
  });
});
