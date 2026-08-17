import { describe, expect, it } from "vitest";
import {
  FakeCmdBroker,
  FakeFsBroker,
  FakeNetBroker,
  FakeSecretBroker,
  FakeToolBrokerClient,
  ValidationSandbox,
} from "../../../src/evolution/testing/validation-sandbox.js";
import {
  CMD_TOOL_SOURCE,
  FS_TOOL_SOURCE,
  NET_TOOL_SOURCE,
  PURE_COMPUTE_TOOL_SOURCE,
  SECRET_TOOL_SOURCE,
  createMockManifest,
} from "./helpers.js";

describe("ValidationSandbox (Ephemeral Test Execution & Broker Fakes)", () => {
  const sandbox = new ValidationSandbox();

  describe("Broker Fakes Unit Functionality", () => {
    it("should perform in-memory filesystem operations deterministically", async () => {
      const fs = new FakeFsBroker({
        files: {
          "/workspace/test.txt": "Hello Fake FS",
        },
      });

      expect(await fs.exists("/workspace/test.txt")).toBe(true);
      expect(await fs.exists("/workspace/nonexistent.txt")).toBe(false);

      const content = await fs.readFile("/workspace/test.txt", "utf-8");
      expect(content).toBe("Hello Fake FS");

      await fs.writeFile("/workspace/output.txt", "New File Content");
      expect(await fs.exists("/workspace/output.txt")).toBe(true);
      expect(await fs.readFile("/workspace/output.txt", "utf-8")).toBe("New File Content");

      const dir = await fs.listDir("/workspace");
      expect(dir).toContain("/workspace/test.txt");
      expect(dir).toContain("/workspace/output.txt");

      const stat = await fs.stat("/workspace/output.txt");
      expect(stat.size).toBeGreaterThan(0);
      expect(stat.isFile).toBe(true);

      await fs.removeFile("/workspace/output.txt");
      expect(await fs.exists("/workspace/output.txt")).toBe(false);
    });

    it("should simulate filesystem errors when configured", async () => {
      const fs = new FakeFsBroker({
        simulateErrors: {
          "/workspace/locked.txt": "EACCES",
        },
      });

      await expect(fs.readFile("/workspace/locked.txt")).rejects.toThrow("EACCES");
    });

    it("should handle mock HTTP requests deterministically", async () => {
      const net = new FakeNetBroker({
        routes: {
          "https://api.test.com/users": {
            status: 200,
            body: { users: [{ id: 1, name: "Alice" }] },
          },
        },
      });

      const res = await net.fetch("https://api.test.com/users");
      expect(res.status).toBe(200);
      expect(res.ok).toBe(true);
      const data = await res.json<{ users: Array<{ id: number; name: string }> }>();
      expect(data.users[0]?.name).toBe("Alice");
    });

    it("should simulate network timeouts and errors", async () => {
      const timeoutNet = new FakeNetBroker({ simulateTimeout: true });
      await expect(timeoutNet.fetch("https://api.test.com")).rejects.toThrow("Network timeout");

      const errorNet = new FakeNetBroker({ simulateNetworkError: true });
      await expect(errorNet.fetch("https://api.test.com")).rejects.toThrow("ECONNREFUSED");
    });

    it("should execute mock commands and return deterministic stdout/stderr", async () => {
      const cmd = new FakeCmdBroker({
        commands: {
          "echo test": { stdout: "test\n", exitCode: 0 },
        },
      });

      const res = await cmd.exec("echo", ["test"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe("test\n");

      const failCmd = new FakeCmdBroker({ simulateFailure: true });
      const failRes = await failCmd.exec("git", ["status"]);
      expect(failRes.exitCode).toBe(1);
    });

    it("should provide mock secrets without exposing production credentials", async () => {
      const secrets = new FakeSecretBroker({
        values: {
          CUSTOM_API_KEY: "mock_secret_key_999",
        },
      });

      expect(await secrets.getSecret("CUSTOM_API_KEY")).toBe("mock_secret_key_999");
      expect(await secrets.getSecret("OTHER_KEY")).toBe("mock_secret_for_OTHER_KEY");

      const deniedSecrets = new FakeSecretBroker({ denyAccess: true });
      expect(await deniedSecrets.getSecret("CUSTOM_API_KEY")).toBeNull();
    });

    it("should dispatch requests correctly via FakeToolBrokerClient", async () => {
      const client = new FakeToolBrokerClient({
        fs: { files: { "/workspace/a.txt": "aaa" } },
      });

      const exists = await client.request<boolean>("fs", "exists", { path: "/workspace/a.txt" });
      expect(exists).toBe(true);

      const secret = await client.request<string>("secret", "getSecret", { name: "KEY" });
      expect(secret).toBeDefined();
    });
  });

  describe("Sandbox Test Suite Execution", () => {
    it("should execute pure compute tool test suite and report coverage", async () => {
      const manifest = createMockManifest({ name: "math_evaluator" });
      const testSuite = {
        suiteId: "suite-test-1",
        toolId: manifest.id,
        toolName: manifest.name,
        synthesizedAt: new Date().toISOString(),
        llmAssisted: false,
        cases: [
          {
            id: "tc_1",
            name: "Happy Path Addition",
            description: "10 + 20 === 30",
            testType: "happy_path" as const,
            input: { a: 10, b: 20, operation: "add" },
            expectedOutcome: "success" as const,
          },
          {
            id: "tc_2",
            name: "Happy Path Division",
            description: "100 / 4 === 25",
            testType: "happy_path" as const,
            input: { a: 100, b: 4, operation: "divide" },
            expectedOutcome: "success" as const,
          },
          {
            id: "tc_3",
            name: "Error Mode - Division by Zero",
            description: "Expects division by zero error",
            testType: "error_mode" as const,
            input: { a: 10, b: 0, operation: "divide" },
            expectedOutcome: "execution_error" as const,
            expectedErrorSubstring: "Division by zero",
          },
          {
            id: "tc_4",
            name: "Schema Boundary - Missing Field",
            description: "Omitted 'a' field should fail schema validation",
            testType: "schema_boundary" as const,
            input: { b: 5 },
            expectedOutcome: "validation_error" as const,
          },
        ],
      };

      const report = await sandbox.executeTestSuite(PURE_COMPUTE_TOOL_SOURCE, manifest, testSuite);

      expect(report.totalTests).toBe(4);
      expect(report.passed).toBe(4);

      // Verify coverage report
      expect(report.coverage).toBeDefined();
      expect(report.coverage?.statementCoveragePercent).toBeGreaterThanOrEqual(80);
      expect(report.coverage?.branchCoveragePercent).toBeGreaterThanOrEqual(50);
      expect(report.coverage?.functionCoveragePercent).toBeGreaterThanOrEqual(80);
    });

    it("should execute filesystem tool in sandbox with mock files", async () => {
      const manifest = createMockManifest({ name: "file_processor" });
      const testSuite = {
        suiteId: "suite-fs-1",
        toolId: manifest.id,
        toolName: manifest.name,
        synthesizedAt: new Date().toISOString(),
        llmAssisted: false,
        cases: [
          {
            id: "tc_fs_1",
            name: "Read Existing File",
            description: "Reads lines from sample file",
            testType: "happy_path" as const,
            input: { filePath: "/workspace/sample.txt" },
            expectedOutcome: "success" as const,
            mockBrokerConfig: {
              fs: { files: { "/workspace/sample.txt": "Line 1\nLine 2\nLine 3" } },
            },
          },
        ],
      };

      const report = await sandbox.executeTestSuite(FS_TOOL_SOURCE, manifest, testSuite);
      expect(report.passed).toBe(1);
      expect(report.failed).toBe(0);

      const happyResult = report.results[0];
      expect(happyResult?.status).toBe("pass");
      expect(happyResult?.actualOutput).toEqual(
        expect.objectContaining({
          success: true,
          lineCount: 3,
        }),
      );
    });

    it("should execute network tool in sandbox with mock HTTP routes", async () => {
      const manifest = createMockManifest({ name: "net_fetcher" });
      const testSuite = {
        suiteId: "suite-net-1",
        toolId: manifest.id,
        toolName: manifest.name,
        synthesizedAt: new Date().toISOString(),
        llmAssisted: false,
        cases: [
          {
            id: "tc_net_1",
            name: "Fetch Remote Resource",
            description: "Fetches JSON payload from endpoint",
            testType: "happy_path" as const,
            input: { endpointUrl: "https://api.example.com/data" },
            expectedOutcome: "success" as const,
            mockBrokerConfig: {
              net: {
                routes: {
                  "https://api.example.com/data": {
                    status: 200,
                    body: { result: "ok", count: 10 },
                  },
                },
              },
            },
          },
        ],
      };

      const report = await sandbox.executeTestSuite(NET_TOOL_SOURCE, manifest, testSuite);
      expect(report.passed).toBe(1);
      expect(report.results[0]?.actualOutput).toEqual(
        expect.objectContaining({
          success: true,
          status: 200,
        }),
      );
    });

    it("should execute command tool in sandbox with fake commands", async () => {
      const manifest = createMockManifest({ name: "cmd_runner" });
      const testSuite = {
        suiteId: "suite-cmd-1",
        toolId: manifest.id,
        toolName: manifest.name,
        synthesizedAt: new Date().toISOString(),
        llmAssisted: false,
        cases: [
          {
            id: "tc_cmd_1",
            name: "Run Echo Command",
            description: "Executes echo and returns stdout",
            testType: "happy_path" as const,
            input: { command: "echo", args: ["hello", "world"] },
            expectedOutcome: "success" as const,
            mockBrokerConfig: {
              cmd: {
                commands: {
                  "echo hello world": { stdout: "hello world\n", exitCode: 0 },
                },
              },
            },
          },
        ],
      };

      const report = await sandbox.executeTestSuite(CMD_TOOL_SOURCE, manifest, testSuite);
      expect(report.passed).toBe(1);
      expect(report.results[0]?.actualOutput).toEqual(
        expect.objectContaining({
          success: true,
          stdout: "hello world\n",
          exitCode: 0,
        }),
      );
    });

    it("should execute secret tool in sandbox with fake secret store", async () => {
      const manifest = createMockManifest({ name: "secret_consumer" });
      const testSuite = {
        suiteId: "suite-sec-1",
        toolId: manifest.id,
        toolName: manifest.name,
        synthesizedAt: new Date().toISOString(),
        llmAssisted: false,
        cases: [
          {
            id: "tc_sec_1",
            name: "Load API Key Secret",
            description: "Retrieves secret prefix without leaking full token",
            testType: "happy_path" as const,
            input: { secretName: "CUSTOM_KEY" },
            expectedOutcome: "success" as const,
            mockBrokerConfig: {
              secrets: {
                values: { CUSTOM_KEY: "sk_test_123456789" },
              },
            },
          },
        ],
      };

      const report = await sandbox.executeTestSuite(SECRET_TOOL_SOURCE, manifest, testSuite);
      expect(report.passed).toBe(1);
      expect(report.results[0]?.actualOutput).toEqual(
        expect.objectContaining({
          success: true,
          hasSecret: true,
          secretPrefix: "sk_t",
        }),
      );
    });
  });

  describe("Timeout & Resource Enforcement", () => {
    it("should safely timeout hanging candidate code and record timeout result", async () => {
      const hangingToolSource = `
        import { defineTool } from "@tool-evolver/runtime";
        import { z } from "zod";

        export const InputSchema = z.object({});
        export const OutputSchema = z.object({ success: z.boolean() });

        export default defineTool(async (context) => {
          // Hang simulation via unresolving promise
          await new Promise(() => {});
          return { success: true };
        });
      `;
      const manifest = createMockManifest({ name: "hanging_tool" });
      const testSuite = {
        suiteId: "suite-hang-1",
        toolId: manifest.id,
        toolName: manifest.name,
        synthesizedAt: new Date().toISOString(),
        llmAssisted: false,
        cases: [
          {
            id: "tc_hang",
            name: "Timeout Enforcement Test",
            description: "Enforces 100ms timeout",
            testType: "happy_path" as const,
            input: {},
            expectedOutcome: "success" as const,
            timeoutMs: 100,
          },
        ],
      };

      const report = await sandbox.executeTestSuite(hangingToolSource, manifest, testSuite, {
        timeoutMs: 100,
      });
      expect(report.timeouts + report.failed).toBe(1);
      expect(report.passed).toBe(0);
    });
  });
});
