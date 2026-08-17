import { randomUUID } from "node:crypto";
import type {
  CapabilityManifest,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { ToolPlan } from "../generator/types.js";
import type { InferenceService } from "../../models/service.js";
import type {
  MockBrokerScenario,
  SynthesizedTestCase,
  SynthesizedTestSuite,
} from "./types.js";

/**
 * Options for test synthesis.
 */
export interface TestSynthesisOptions {
  inferenceService?: InferenceService;
  skipLlm?: boolean;
  tenantId?: string;
  maxPropertyTests?: number;
}

/**
 * Synthesizes deterministic baseline test cases and LLM-assisted edge/property tests.
 */
export class TestSynthesizer {
  private readonly inferenceService?: InferenceService;

  constructor(options: { inferenceService?: InferenceService } = {}) {
    this.inferenceService = options.inferenceService;
  }

  /**
   * Synthesizes a complete test suite for a candidate tool.
   */
  async synthesize(
    manifest: ToolManifest | Partial<ToolManifest>,
    sourceCode: string,
    plan?: ToolPlan,
    options: TestSynthesisOptions = {}
  ): Promise<SynthesizedTestSuite> {
    const suiteId = `suite_${randomUUID()}`;
    const toolId = manifest.id ?? plan?.id ?? `tool_${randomUUID()}`;
    const toolName = manifest.name ?? plan?.name ?? "candidate_tool";
    const capabilities = manifest.capabilities ?? {};

    const cases: SynthesizedTestCase[] = [];

    // 1. Generate Deterministic Baseline Test Cases
    const baselineCases = this.generateBaselineCases(manifest, capabilities, plan);
    cases.push(...baselineCases);

    // 2. Generate LLM-Assisted Test Cases if inference service is available
    let llmAssisted = false;
    const activeInferenceService = options.inferenceService ?? this.inferenceService;
    if (activeInferenceService && !options.skipLlm) {
      try {
        const llmCases = await this.synthesizeLlmCases(
          activeInferenceService,
          toolName,
          sourceCode,
          manifest,
          options.tenantId
        );
        if (llmCases.length > 0) {
          cases.push(...llmCases);
          llmAssisted = true;
        }
      } catch {
        // Fallback gracefully to deterministic tests if LLM is unavailable or fails
        llmAssisted = false;
      }
    }

    return {
      suiteId,
      toolId,
      toolName,
      cases,
      synthesizedAt: new Date().toISOString(),
      llmAssisted,
    };
  }

  /**
   * Generates deterministic baseline test cases covering schema boundary, happy path,
   * edge cases, error modes, and idempotency.
   */
  private generateBaselineCases(
    manifest: Partial<ToolManifest>,
    capabilities: Partial<CapabilityManifest>,
    plan?: ToolPlan
  ): SynthesizedTestCase[] {
    const cases: SynthesizedTestCase[] = [];
    const params = manifest.parameters ?? { type: "object", properties: {}, required: [] };
    const properties: Record<string, Record<string, unknown>> =
      (params.properties as Record<string, Record<string, unknown>>) ?? {};
    const required: string[] = (params.required as string[]) ?? [];

    const defaultValidInput = this.buildDefaultValidInput(properties, capabilities);
    const defaultScenario = this.buildDefaultScenario(capabilities, defaultValidInput);

    // 1. Happy Path Test
    cases.push({
      id: `tc_${randomUUID()}`,
      name: "Happy Path - Standard Execution",
      description: "Executes tool with valid canonical parameters against mock broker environment.",
      testType: "happy_path",
      input: defaultValidInput,
      expectedOutcome: "success",
      mockBrokerConfig: defaultScenario,
    });

    // 2. Schema Boundary Tests: Missing Required Fields
    for (const reqKey of required) {
      const missingInput = { ...defaultValidInput };
      delete missingInput[reqKey];

      cases.push({
        id: `tc_${randomUUID()}`,
        name: `Schema Boundary - Missing Required '${reqKey}'`,
        description: `Validates schema rejection when required parameter '${reqKey}' is omitted.`,
        testType: "schema_boundary",
        input: missingInput,
        expectedOutcome: "validation_error",
        expectedErrorSubstring: reqKey,
        mockBrokerConfig: defaultScenario,
      });
    }

    // 3. Schema Boundary Tests: Invalid Types
    for (const [propName, propDef] of Object.entries(properties)) {
      const propType = (propDef.type as string) ?? "string";
      const invalidValue = this.getInvalidTypeValue(propType);

      cases.push({
        id: `tc_${randomUUID()}`,
        name: `Schema Boundary - Invalid Type for '${propName}'`,
        description: `Passes invalid type for '${propName}' (expected ${propType}) to verify schema type rejection.`,
        testType: "schema_boundary",
        input: { ...defaultValidInput, [propName]: invalidValue },
        expectedOutcome: "validation_error",
        mockBrokerConfig: defaultScenario,
      });
    }

    // 4. Edge Cases: Empty / Special Characters / Enums
    for (const [propName, propDef] of Object.entries(properties)) {
      const propType = (propDef.type as string) ?? "string";
      if (propType === "string") {
        if (propDef.enum && Array.isArray(propDef.enum) && propDef.enum.length > 0) {
          const altEnumValue = propDef.enum[propDef.enum.length - 1];
          cases.push({
            id: `tc_${randomUUID()}`,
            name: `Edge Case - Alternate Enum in '${propName}'`,
            description: `Tests alternative enum value '${altEnumValue}' in '${propName}'.`,
            testType: "edge_case",
            input: {
              ...defaultValidInput,
              [propName]: altEnumValue,
            },
            expectedOutcome: "success",
            mockBrokerConfig: defaultScenario,
          });
        } else {
          cases.push({
            id: `tc_${randomUUID()}`,
            name: `Edge Case - Valid String in '${propName}'`,
            description: `Tests string handling for '${propName}'.`,
            testType: "edge_case",
            input: {
              ...defaultValidInput,
              [propName]: defaultValidInput[propName],
            },
            expectedOutcome: "success",
            mockBrokerConfig: defaultScenario,
          });
        }
      } else if (propType === "number" || propType === "integer") {
        cases.push({
          id: `tc_${randomUUID()}`,
          name: `Edge Case - Zero Value in '${propName}'`,
          description: `Tests number boundary with 0 in '${propName}'.`,
          testType: "edge_case",
          input: { ...defaultValidInput, [propName]: 0 },
          expectedOutcome: "success",
          mockBrokerConfig: defaultScenario,
        });
      } else if (propType === "array") {
        cases.push({
          id: `tc_${randomUUID()}`,
          name: `Edge Case - Empty Array in '${propName}'`,
          description: `Tests empty collection in '${propName}'.`,
          testType: "edge_case",
          input: { ...defaultValidInput, [propName]: [] },
          expectedOutcome: "success",
          mockBrokerConfig: defaultScenario,
        });
      }
    }

    // 5. Error Modes: Broker Failures
    const hasFsCapability =
      !!capabilities.fs &&
      (capabilities.fs.allowWorkspaceRoot === true ||
        capabilities.fs.allowTemp === true ||
        (Array.isArray(capabilities.fs.readPaths) && capabilities.fs.readPaths.length > 0) ||
        (Array.isArray(capabilities.fs.writePaths) && capabilities.fs.writePaths.length > 0));

    if (hasFsCapability) {
      const errorScenario: MockBrokerScenario = {
        ...defaultScenario,
        fs: {
          ...defaultScenario.fs,
          simulateErrors: {
            "/workspace/sample.txt": "ENOENT",
            "/workspace/missing.txt": "ENOENT",
          },
        },
      };

      cases.push({
        id: `tc_${randomUUID()}`,
        name: "Error Mode - Filesystem ENOENT",
        description: "Simulates missing file in broker filesystem to verify clean error propagation.",
        testType: "error_mode",
        input: {
          ...defaultValidInput,
          path: "/workspace/missing.txt",
          filePath: "/workspace/missing.txt",
        },
        expectedOutcome: "execution_error",
        mockBrokerConfig: errorScenario,
      });
    }

    const hasNetCapability = !!capabilities.net && capabilities.net.allowOutbound === true;
    if (hasNetCapability) {
      const errorScenario: MockBrokerScenario = {
        ...defaultScenario,
        net: {
          ...defaultScenario.net,
          simulateNetworkError: true,
        },
      };

      cases.push({
        id: `tc_${randomUUID()}`,
        name: "Error Mode - Network Connection Refused",
        description: "Simulates network failure to verify error handling in fetch.",
        testType: "error_mode",
        input: defaultValidInput,
        expectedOutcome: "execution_error",
        mockBrokerConfig: errorScenario,
      });
    }

    const hasCmdCapability =
      !!capabilities.command &&
      (capabilities.command.allowShellExecution === true ||
        (Array.isArray(capabilities.command.allowedCommands) && capabilities.command.allowedCommands.length > 0));
    if (hasCmdCapability) {
      const errorScenario: MockBrokerScenario = {
        ...defaultScenario,
        cmd: {
          ...defaultScenario.cmd,
          simulateFailure: true,
        },
      };

      cases.push({
        id: `tc_${randomUUID()}`,
        name: "Error Mode - Command Execution Failure",
        description: "Simulates command failure with non-zero exit code to verify tool error handling.",
        testType: "error_mode",
        input: defaultValidInput,
        expectedOutcome: "execution_error",
        mockBrokerConfig: errorScenario,
      });
    }

    // 6. Idempotency Test
    cases.push({
      id: `tc_${randomUUID()}`,
      name: "Idempotency - Sequential Repeated Invocations",
      description: "Verifies that executing twice with identical input produces deterministic and repeatable results.",
      testType: "idempotency",
      input: defaultValidInput,
      expectedOutcome: "success",
      mockBrokerConfig: defaultScenario,
    });

    return cases;
  }

  /**
   * Constructs valid default inputs satisfying the parameter schema.
   */
  private buildDefaultValidInput(
    properties: Record<string, Record<string, unknown>>,
    capabilities: Partial<CapabilityManifest>
  ): Record<string, unknown> {
    const input: Record<string, unknown> = {};

    for (const [key, propDef] of Object.entries(properties)) {
      const propType = (propDef.type as string) ?? "string";

      if (propDef.default !== undefined) {
        input[key] = propDef.default;
      } else if (propDef.enum && Array.isArray(propDef.enum) && propDef.enum.length > 0) {
        input[key] = propDef.enum[0];
      } else if (propType === "string") {
        if (key.toLowerCase().includes("path") || key.toLowerCase().includes("file")) {
          input[key] = "/workspace/sample.txt";
        } else if (key.toLowerCase().includes("url") || key.toLowerCase().includes("endpoint")) {
          input[key] = "https://api.example.com/data";
        } else if (key.toLowerCase().includes("command") || key.toLowerCase().includes("cmd")) {
          input[key] = "echo";
        } else {
          input[key] = `test_${key}`;
        }
      } else if (propType === "number" || propType === "integer") {
        input[key] = typeof propDef.minimum === "number" ? propDef.minimum : 10;
      } else if (propType === "boolean") {
        input[key] = true;
      } else if (propType === "array") {
        input[key] = ["item_a", "item_b"];
      } else if (propType === "object") {
        input[key] = { key: "value" };
      } else {
        input[key] = "test";
      }
    }

    return input;
  }

  /**
   * Constructs mock broker scenarios matching capabilities and sample inputs.
   */
  private buildDefaultScenario(
    capabilities: Partial<CapabilityManifest>,
    validInput: Record<string, unknown>
  ): MockBrokerScenario {
    const scenario: MockBrokerScenario = {};

    if (capabilities.fs) {
      const files: Record<string, string> = {
        "/workspace/sample.txt": "Mock file line 1\nMock file line 2\nMock file line 3",
        "/workspace/data.json": JSON.stringify({ status: "ok", count: 3, items: ["a", "b", "c"] }),
      };

      for (const [k, v] of Object.entries(validInput)) {
        if (typeof v === "string" && (v.startsWith("/") || v.startsWith("./"))) {
          files[v] = `Mock content for ${v}`;
        }
      }

      scenario.fs = { files };
    }

    if (capabilities.net) {
      scenario.net = {
        routes: {
          "https://api.example.com/data": {
            status: 200,
            body: { success: true, count: 42, timestamp: "2026-08-17T00:00:00Z" },
          },
        },
      };
    }

    if (capabilities.command) {
      scenario.cmd = {
        commands: {
          echo: { stdout: "hello from mock command\n", exitCode: 0 },
          "git status": { stdout: "On branch main\n", exitCode: 0 },
        },
      };
    }

    if (capabilities.secrets) {
      scenario.secrets = {
        values: {
          API_KEY: "mock_deterministic_secret_key_12345",
          AUTH_TOKEN: "mock_auth_bearer_token",
        },
      };
    }

    return scenario;
  }

  /**
   * Returns an invalid value to test schema boundary type rejection.
   */
  private getInvalidTypeValue(expectedType: string): unknown {
    switch (expectedType) {
      case "string":
        return 123456;
      case "number":
      case "integer":
        return "invalid_string_not_a_number";
      case "boolean":
        return { invalid: "object_instead_of_boolean" };
      case "array":
        return "invalid_string_instead_of_array";
      case "object":
        return "invalid_string_instead_of_object";
      default:
        return null;
    }
  }

  /**
   * Synthesizes test cases using LLM inference service.
   */
  private async synthesizeLlmCases(
    inferenceService: InferenceService,
    toolName: string,
    sourceCode: string,
    manifest: Partial<ToolManifest>,
    tenantId = "tenant-default"
  ): Promise<SynthesizedTestCase[]> {
    const response = await inferenceService.infer<{
      toolName: string;
      toolCode: string;
      toolSchema: string;
    }, {
      suiteId: string;
      targetTool: string;
      unitTests: Array<{ name: string; description: string; code: string }>;
      propertyTests: Array<{ name: string; property: string; code: string }>;
      edgeCases: string[];
    }>({
      tenantId,
      taskClass: "test_generation",
      promptTemplateId: "test_generation",
      promptTemplateVersion: "1.0.0",
      inputs: {
        toolName,
        toolCode: sourceCode,
        toolSchema: JSON.stringify(manifest.parameters ?? {}),
      },
    });

    const llmCases: SynthesizedTestCase[] = [];
    const output = response.output;

    if (output && Array.isArray(output.unitTests)) {
      for (const ut of output.unitTests) {
        llmCases.push({
          id: `tc_llm_${randomUUID()}`,
          name: `LLM Unit - ${ut.name}`,
          description: ut.description,
          testType: "unit",
          input: this.buildDefaultValidInput(
            (manifest.parameters?.properties as Record<string, Record<string, unknown>>) ?? {},
            manifest.capabilities ?? {}
          ),
          expectedOutcome: "success",
        });
      }
    }

    if (output && Array.isArray(output.propertyTests)) {
      for (const pt of output.propertyTests) {
        llmCases.push({
          id: `tc_llm_prop_${randomUUID()}`,
          name: `LLM Property - ${pt.name}`,
          description: pt.property,
          testType: "property",
          input: this.buildDefaultValidInput(
            (manifest.parameters?.properties as Record<string, Record<string, unknown>>) ?? {},
            manifest.capabilities ?? {}
          ),
          expectedOutcome: "success",
          isPropertyBased: true,
        });
      }
    }

    return llmCases;
  }
}
