import { describe, expect, it } from "vitest";
import { TypeChecker } from "../../../src/evolution/testing/type-checker.js";
import {
  CMD_TOOL_SOURCE,
  FS_TOOL_SOURCE,
  NET_TOOL_SOURCE,
  PURE_COMPUTE_TOOL_SOURCE,
  SECRET_TOOL_SOURCE,
  createMockManifest,
} from "./helpers.js";

describe("TypeChecker (Pinned TypeScript Compilation & Schema Validator)", () => {
  const typeChecker = new TypeChecker();

  describe("Compilation and Diagnostics", () => {
    it("should successfully typecheck pure compute tool candidate", () => {
      const manifest = createMockManifest({ name: "math_evaluator" });
      const result = typeChecker.check(PURE_COMPUTE_TOOL_SOURCE, manifest);

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.jsCode).toBeDefined();
      expect(result.jsCode).toContain("exports.default = (0, runtime_1.defineTool)");
    });

    it("should successfully typecheck filesystem tool candidate", () => {
      const manifest = createMockManifest({ name: "file_processor" });
      const result = typeChecker.check(FS_TOOL_SOURCE, manifest);

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should successfully typecheck network, command, and secret tool candidates", () => {
      expect(typeChecker.check(NET_TOOL_SOURCE).passed).toBe(true);
      expect(typeChecker.check(CMD_TOOL_SOURCE).passed).toBe(true);
      expect(typeChecker.check(SECRET_TOOL_SOURCE).passed).toBe(true);
    });

    it("should report syntax errors for malformed TypeScript code", () => {
      const malformedCode = `
        import { defineTool } from "@tool-evolver/runtime";
        export default defineTool(async (context) => {
          const x: number = "not a number; // unclosed string
          return { success: true };
        });
      `;

      const result = typeChecker.check(malformedCode);
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Schema Consistency Checks", () => {
    it("should report schema inconsistency when manifest required parameter is missing from code", () => {
      const manifest = createMockManifest({
        parameters: {
          type: "object",
          properties: {
            requiredParameterXYZ: { type: "string" },
          },
          required: ["requiredParameterXYZ"],
        },
      });

      const result = typeChecker.check(PURE_COMPUTE_TOOL_SOURCE, manifest);
      expect(result.passed).toBe(false);
      expect(result.errors.some((e) => e.includes("requiredParameterXYZ"))).toBe(true);
    });

    it("should pass schema consistency when all required parameters are present", () => {
      const manifest = createMockManifest({
        parameters: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      });

      const result = typeChecker.check(PURE_COMPUTE_TOOL_SOURCE, manifest);
      expect(result.passed).toBe(true);
    });
  });

  describe("Transpilation", () => {
    it("should transpile TypeScript code to CommonJS JavaScript", () => {
      const jsOutput = typeChecker.transpile(PURE_COMPUTE_TOOL_SOURCE);
      expect(jsOutput).toBeDefined();
      expect(typeof jsOutput).toBe("string");
      expect(jsOutput).toContain("exports.InputSchema");
      expect(jsOutput).toContain("exports.OutputSchema");
    });
  });
});
