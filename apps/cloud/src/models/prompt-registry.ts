import { hashCanonical } from "@tool-evolver/contracts";
import { z } from "zod";
import { type ModelTaskClass, ModelTaskClassSchema } from "./types.js";

/**
 * Prompt template definition with typed inputs and schemas.
 */
export interface PromptTemplate<TInput = Record<string, unknown>, TOutput = unknown> {
  id: string;
  version: string;
  taskClass: ModelTaskClass;
  description: string;
  systemInstruction: string;
  userTemplate: string;
  inputSchema?: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  jsonSchema?: Record<string, unknown>;
  digest: string;
  createdAt: string;
}

/**
 * Rendered prompt result with computed digests.
 */
export interface RenderedPrompt {
  templateId: string;
  templateVersion: string;
  systemInstruction: string;
  userMessage: string;
  promptDigest: string;
  inputDigest: string;
  schemaDigest: string;
}

/**
 * Template creation parameters.
 */
export interface RegisterTemplateParams<TInput = Record<string, unknown>, TOutput = unknown> {
  id: string;
  version: string;
  taskClass: ModelTaskClass;
  description: string;
  systemInstruction: string;
  userTemplate: string;
  inputSchema?: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  jsonSchema?: Record<string, unknown>;
}

// Built-in schemas for task classes
export const OpportunityDetectionOutputSchema = z.object({
  opportunities: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      taskClass: z.string(),
      pattern: z.string(),
      confidenceScore: z.number().min(0).max(1),
      evidence: z.array(z.string()),
      priority: z.enum(["low", "medium", "high", "critical"]),
    }),
  ),
});
export type OpportunityDetectionOutput = z.infer<typeof OpportunityDetectionOutputSchema>;

export const CandidatePlanningOutputSchema = z.object({
  planId: z.string(),
  targetToolName: z.string(),
  action: z.enum(["create", "modify", "deprecate"]),
  summary: z.string(),
  interfaceChanges: z.array(z.string()).default([]),
  securityRisks: z.array(z.string()).default([]),
  estimatedImpact: z.string(),
  suggestedInputs: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(["string", "number", "boolean", "array", "object"]),
        description: z.string(),
        required: z.boolean().default(true),
        defaultValue: z.unknown().optional(),
      }),
    )
    .optional(),
  suggestedOutputs: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  transformationRules: z.array(z.string()).optional(),
  runtimeRequirements: z.array(z.string()).optional(),
});
export type CandidatePlanningOutput = z.infer<typeof CandidatePlanningOutputSchema>;

export const SchemaGenerationOutputSchema = z.object({
  toolName: z.string(),
  description: z.string(),
  parameters: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["string", "number", "boolean", "array", "object"]),
      description: z.string(),
      required: z.boolean().default(true),
      defaultValue: z.unknown().optional(),
      enumValues: z.array(z.string()).optional(),
    }),
  ),
  outputSchema: z.object({
    type: z.string().default("object"),
    description: z.string().optional(),
    properties: z
      .record(
        z.object({
          type: z.string(),
          description: z.string().optional(),
        }),
      )
      .optional(),
    required: z.array(z.string()).optional(),
  }),
  validationRules: z.array(z.string()).optional(),
});
export type SchemaGenerationOutput = z.infer<typeof SchemaGenerationOutputSchema>;

export const ToolSynthesisOutputSchema = z.object({
  toolId: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  schema: z.record(z.unknown()),
  code: z.string(),
  runtimeRequirements: z.array(z.string()),
  helperFunctions: z.string().optional(),
  transformationLogic: z.string().optional(),
  executionBody: z.string().optional(),
});
export type ToolSynthesisOutput = z.infer<typeof ToolSynthesisOutputSchema>;

export const TestGenerationOutputSchema = z.object({
  suiteId: z.string(),
  targetTool: z.string(),
  unitTests: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      code: z.string(),
    }),
  ),
  propertyTests: z.array(
    z.object({
      name: z.string(),
      property: z.string(),
      code: z.string(),
    }),
  ),
  edgeCases: z.array(z.string()),
});
export type TestGenerationOutput = z.infer<typeof TestGenerationOutputSchema>;

export const CandidateScoringOutputSchema = z.object({
  candidateId: z.string(),
  overallScore: z.number().min(0).max(100),
  approved: z.boolean(),
  categories: z.object({
    quality: z.number().min(0).max(100),
    performance: z.number().min(0).max(100),
    security: z.number().min(0).max(100),
    utility: z.number().min(0).max(100),
  }),
  rationale: z.string(),
  recommendations: z.array(z.string()),
});
export type CandidateScoringOutput = z.infer<typeof CandidateScoringOutputSchema>;

export const BrokeredToolPlanningOutputSchema = z.object({
  toolName: z.string(),
  description: z.string(),
  taskClass: z.string().default("tool_synthesis"),
  toolCategory: z.enum(["fs", "net", "command", "compute", "composite"]).default("compute"),
  variableInputs: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        description: z.string(),
        required: z.boolean().default(true),
        defaultValue: z.unknown().optional(),
      }),
    )
    .default([]),
  invariants: z
    .array(
      z.object({
        name: z.string(),
        value: z.unknown(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  steps: z
    .array(
      z.object({
        stepId: z.string(),
        name: z.string(),
        description: z.string(),
        action: z.string(),
        service: z.enum(["fs", "net", "cmd", "secret", "compute"]).optional(),
        inputs: z.record(z.unknown()).default({}),
        outputs: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
  requiredCapabilities: z
    .object({
      fs: z
        .object({
          readPaths: z.array(z.string()).default([]),
          writePaths: z.array(z.string()).default([]),
          allowWorkspaceRoot: z.boolean().default(false),
          allowTemp: z.boolean().default(false),
          denyPaths: z.array(z.string()).default([]),
        })
        .default({}),
      net: z
        .object({
          allowedHosts: z.array(z.string()).default([]),
          allowedUrls: z.array(z.string()).default([]),
          allowedMethods: z.array(z.string()).default([]),
          allowOutbound: z.boolean().default(false),
        })
        .default({}),
      command: z
        .object({
          allowedCommands: z.array(z.string()).default([]),
          allowedArguments: z.record(z.array(z.string())).default({}),
          allowShell: z.boolean().default(false),
        })
        .default({}),
      secrets: z
        .object({
          requiredSecrets: z.array(z.string()).default([]),
          allowedMediationModes: z.array(z.string()).default([]),
        })
        .default({}),
    })
    .default({}),
  secretsUsed: z
    .array(
      z.object({
        secretName: z.string(),
        mediationMode: z.enum([
          "bearer_token",
          "header_template",
          "query_template",
          "command_stdin",
          "command_env",
        ]),
      }),
    )
    .default([]),
  runtimeRequirements: z.array(z.string()).default([]),
});
export type BrokeredToolPlanningOutput = z.infer<typeof BrokeredToolPlanningOutputSchema>;

export const CapabilitySynthesisOutputSchema = z.object({
  fs: z
    .object({
      readPaths: z.array(z.string()).default([]),
      writePaths: z.array(z.string()).default([]),
      allowWorkspaceRoot: z.boolean().default(false),
      allowTemp: z.boolean().default(false),
      denyPaths: z.array(z.string()).default([]),
      maxFileSizeBytes: z.number().optional(),
    })
    .default({}),
  net: z
    .object({
      allowedHosts: z.array(z.string()).default([]),
      allowedUrls: z.array(z.string()).default([]),
      allowedMethods: z.array(z.string()).default([]),
      allowOutbound: z.boolean().default(false),
      maxRequestsPerRun: z.number().optional(),
      maxResponseSizeBytes: z.number().optional(),
    })
    .default({}),
  command: z
    .object({
      allowedCommands: z.array(z.string()).default([]),
      allowedArguments: z.record(z.array(z.string())).default({}),
      allowShell: z.boolean().default(false),
      maxExecutionTimeMs: z.number().optional(),
    })
    .default({}),
  secrets: z
    .object({
      requiredSecrets: z.array(z.string()).default([]),
      allowedMediationModes: z.array(z.string()).default([]),
      denySecretExfiltration: z.boolean().default(true),
    })
    .default({}),
  limits: z
    .object({
      maxExecutionTimeMs: z.number().optional(),
      maxMemoryBytes: z.number().optional(),
      maxOutputSizeBytes: z.number().optional(),
    })
    .default({}),
  rationale: z.string().optional(),
  isMinimal: z.boolean().default(true),
});
export type CapabilitySynthesisOutput = z.infer<typeof CapabilitySynthesisOutputSchema>;

export const ToolRepairOutputSchema = z.object({
  toolId: z.string(),
  name: z.string(),
  version: z.string(),
  code: z.string(),
  fixedIssues: z.array(z.string()).default([]),
  explanation: z.string().optional(),
  capabilities: z.record(z.unknown()).optional(),
  schemaChanges: z.record(z.unknown()).optional(),
});
export type ToolRepairOutput = z.infer<typeof ToolRepairOutputSchema>;

export const WorkflowPlanningStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  toolClass: z.string(),
  action: z.string(),
  service: z.enum(["fs", "net", "cmd", "secret", "compute"]).optional(),
  inputs: z.record(z.unknown()).default({}),
  outputs: z.union([z.record(z.unknown()), z.array(z.string())]).optional(),
  outputVar: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  capabilityRequirements: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().positive().default(30000),
  retryPolicy: z
    .object({
      maxRetries: z.number().int().min(0).default(0),
      backoffMs: z.number().int().min(0).default(1000),
      idempotent: z.boolean().default(false),
    })
    .optional(),
  failureBehavior: z.enum(["abort", "continue", "compensate", "fail"]).default("abort"),
  compensation: z
    .object({
      action: z.string(),
      inputs: z.record(z.unknown()).default({}),
      service: z.string().optional(),
      description: z.string().optional(),
      deterministicInverse: z.boolean().default(true),
    })
    .optional(),
  condition: z.string().optional(),
});
export type WorkflowPlanningStep = z.infer<typeof WorkflowPlanningStepSchema>;

export const WorkflowPlanningOutputSchema = z.object({
  planId: z.string(),
  targetToolName: z.string(),
  description: z.string(),
  workflowPattern: z.string().default("sequential_pipeline"),
  variableInputs: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(["string", "number", "boolean", "array", "object"]),
        description: z.string(),
        required: z.boolean().default(true),
        defaultValue: z.unknown().optional(),
        examples: z.array(z.unknown()).optional(),
      }),
    )
    .default([]),
  invariantInputs: z
    .array(
      z.object({
        name: z.string(),
        value: z.unknown(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  steps: z.array(WorkflowPlanningStepSchema),
  requiredCapabilities: z.record(z.unknown()).default({}),
  compensationPolicy: z
    .object({
      enabled: z.boolean().default(true),
      autoRollback: z.boolean().default(true),
    })
    .default({ enabled: true, autoRollback: true }),
  rationale: z.string().optional(),
});
export type WorkflowPlanningOutput = z.infer<typeof WorkflowPlanningOutputSchema>;

export const WorkflowSynthesisOutputSchema = z.object({
  workflowId: z.string(),
  name: z.string(),
  version: z.string().default("1.0.0"),
  description: z.string(),
  steps: z.array(WorkflowPlanningStepSchema),
  code: z.string(),
  unitTests: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        code: z.string(),
        testType: z.enum(["unit", "property", "integration"]).default("unit"),
      }),
    )
    .default([]),
  propertyTests: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        code: z.string(),
        testType: z.enum(["unit", "property", "integration"]).default("property"),
      }),
    )
    .default([]),
  failureInjectionTests: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        code: z.string(),
        testType: z.enum(["unit", "property", "integration"]).default("integration"),
      }),
    )
    .default([]),
  requiredCapabilities: z.record(z.unknown()).default({}),
});
export type WorkflowSynthesisOutput = z.infer<typeof WorkflowSynthesisOutputSchema>;

export const CompensationGenerationOutputSchema = z.object({
  stepId: z.string(),
  action: z.string(),
  hasDeterministicInverse: z.boolean(),
  compensation: z
    .object({
      action: z.string(),
      inputs: z.record(z.unknown()).default({}),
      service: z.string().optional(),
      description: z.string().optional(),
      deterministicInverse: z.boolean().default(true),
    })
    .optional(),
  safetyRationale: z.string(),
});
export type CompensationGenerationOutput = z.infer<typeof CompensationGenerationOutputSchema>;
/**
 * Versioned prompt template registry.
 */
export class PromptRegistry {
  private templates: Map<string, Map<string, PromptTemplate<unknown, unknown>>> = new Map();
  constructor() {
    this.registerDefaults();
  }

  /**
   * Registers a prompt template in the registry.
   */
  register<TInput = Record<string, unknown>, TOutput = unknown>(
    params: RegisterTemplateParams<TInput, TOutput>,
  ): PromptTemplate<TInput, TOutput> {
    const canonicalPayload = {
      id: params.id,
      version: params.version,
      taskClass: params.taskClass,
      systemInstruction: params.systemInstruction,
      userTemplate: params.userTemplate,
      jsonSchema: params.jsonSchema ?? null,
    };
    const digest = hashCanonical(canonicalPayload);

    const template: PromptTemplate<TInput, TOutput> = {
      ...params,
      digest,
      createdAt: new Date().toISOString(),
    };

    if (!this.templates.has(template.id)) {
      this.templates.set(template.id, new Map());
    }

    const versionMap = this.templates.get(template.id)!;
    versionMap.set(template.version, template);

    return template;
  }

  /**
   * Retrieves a template by ID and optional version (defaults to latest registered).
   */
  get<TInput = Record<string, unknown>, TOutput = unknown>(
    id: string,
    version?: string,
  ): PromptTemplate<TInput, TOutput> | undefined {
    const versionMap = this.templates.get(id);
    if (!versionMap || versionMap.size === 0) {
      return undefined;
    }
    if (version) {
      return versionMap.get(version) as PromptTemplate<TInput, TOutput> | undefined;
    }

    return this.getLatest<TInput, TOutput>(id);
  }

  /**
   * Retrieves the latest version of a template by ID.
   */
  getLatest<TInput = Record<string, unknown>, TOutput = unknown>(
    id: string,
  ): PromptTemplate<TInput, TOutput> | undefined {
    const versionMap = this.templates.get(id);
    if (!versionMap || versionMap.size === 0) {
      return undefined;
    }

    // Sort versions in descending semver order
    const versions = Array.from(versionMap.keys()).sort((a, b) => {
      return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
    });

    return versionMap.get(versions[0]) as PromptTemplate<TInput, TOutput> | undefined;
  }

  /**
   * Lists all templates, optionally filtered by task class.
   */
  list(taskClass?: ModelTaskClass): PromptTemplate<unknown, unknown>[] {
    const result: PromptTemplate<unknown, unknown>[] = [];
    for (const versionMap of this.templates.values()) {
      for (const template of versionMap.values()) {
        if (!taskClass || template.taskClass === taskClass) {
          result.push(template);
        }
      }
    }
    return result;
  }

  /**
   * Renders a prompt template with the provided inputs, verifying input schemas and computing digests.
   */
  render<TInput = Record<string, unknown>, TOutput = unknown>(
    template: PromptTemplate<TInput, TOutput>,
    inputs: TInput,
  ): RenderedPrompt {
    if (template.inputSchema) {
      template.inputSchema.parse(inputs);
    }

    let userMessage = template.userTemplate;
    const inputObj = inputs as Record<string, unknown>;

    for (const [key, value] of Object.entries(inputObj)) {
      const serialized = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
      userMessage = userMessage.replaceAll(`{{${key}}}`, serialized);
    }

    const promptDigest = hashCanonical({
      system: template.systemInstruction,
      user: userMessage,
    });
    const inputDigest = hashCanonical(inputs);
    const schemaDigest = template.jsonSchema
      ? hashCanonical(template.jsonSchema)
      : hashCanonical({ id: template.id, version: template.version });

    return {
      templateId: template.id,
      templateVersion: template.version,
      systemInstruction: template.systemInstruction,
      userMessage,
      promptDigest,
      inputDigest,
      schemaDigest,
    };
  }

  /**
   * Registers default prompt templates for all 5 core task classes.
   */
  private registerDefaults(): void {
    // 1. Opportunity Detection
    this.register({
      id: "opportunity_detection",
      version: "1.0.0",
      taskClass: "opportunity_detection",
      description:
        "Detects tool evolution opportunities from session telemetry and trace patterns.",
      systemInstruction:
        "You are the Tool Evolver Opportunity Detection Engine. Analyze the provided tool execution traces and session telemetry. Detect patterns indicating repeated failures, high latency, missing tool capabilities, or evolution opportunities. Output structured JSON matching the specified schema.",
      userTemplate:
        "Session ID: {{sessionId}}\nTrace Data:\n{{traceData}}\nTelemetry Summary:\n{{telemetrySummary}}\nDetect evolution opportunities.",
      outputSchema: OpportunityDetectionOutputSchema,
      jsonSchema: {
        type: "object",
        properties: {
          opportunities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                taskClass: { type: "string" },
                pattern: { type: "string" },
                confidenceScore: { type: "number" },
                evidence: { type: "array", items: { type: "string" } },
                priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
              },
              required: [
                "id",
                "title",
                "description",
                "taskClass",
                "pattern",
                "confidenceScore",
                "evidence",
                "priority",
              ],
            },
          },
        },
        required: ["opportunities"],
      },
    });

    // 2. Candidate Planning
    this.register({
      id: "candidate_planning",
      version: "1.0.0",
      taskClass: "candidate_planning",
      description: "Plans candidate tool improvements, interfaces, and architecture.",
      systemInstruction:
        "You are the Tool Evolver Candidate Planning Engine. Plan candidate tool modifications or new tool additions based on detected opportunities. Provide interface specifications, risk evaluations, and impact summaries.",
      userTemplate:
        "Opportunity ID: {{opportunityId}}\nClassification:\n{{classification}}\nOpportunity Details:\n{{opportunityDetails}}\nEvidence:\n{{evidence}}\nCurrent Tool Manifest:\n{{currentManifest}}\nGenerate candidate evolution plan.",
      outputSchema: CandidatePlanningOutputSchema,
      jsonSchema: {
        type: "object",
        properties: {
          planId: { type: "string" },
          targetToolName: { type: "string" },
          action: { type: "string", enum: ["create", "modify", "deprecate"] },
          summary: { type: "string" },
          interfaceChanges: { type: "array", items: { type: "string" } },
          securityRisks: { type: "array", items: { type: "string" } },
          estimatedImpact: { type: "string" },
        },
        required: [
          "planId",
          "targetToolName",
          "action",
          "summary",
          "interfaceChanges",
          "securityRisks",
          "estimatedImpact",
        ],
      },
    });
    // Schema Generation
    this.register({
      id: "schema_generation",
      version: "1.0.0",
      taskClass: "candidate_planning",
      description: "Generates input/output parameter schemas and types from workflow evidence.",
      systemInstruction:
        "You are the Tool Evolver Schema Generation Engine. Analyze the sanitized workflow evidence, observed parameter types, and intent. Synthesize precise MCP-compatible parameter schemas and return types. Output structured JSON matching the specified schema.",
      userTemplate:
        "Tool Name: {{toolName}}\nDescription: {{description}}\nWorkflow Evidence:\n{{workflowEvidence}}\nObserved Variables:\n{{observedVariables}}\nDerive input and output schemas.",
      outputSchema: SchemaGenerationOutputSchema,
      jsonSchema: {
        type: "object",
        properties: {
          toolName: { type: "string" },
          description: { type: "string" },
          parameters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["string", "number", "boolean", "array", "object"] },
                description: { type: "string" },
                required: { type: "boolean" },
              },
              required: ["name", "type", "description", "required"],
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              type: { type: "string" },
              description: { type: "string" },
              properties: { type: "object" },
              required: { type: "array", items: { type: "string" } },
            },
            required: ["type"],
          },
        },
        required: ["toolName", "description", "parameters", "outputSchema"],
      },
    });

    // 3. Tool Synthesis
    this.register({
      id: "tool_synthesis",
      version: "1.0.0",
      taskClass: "tool_synthesis",
      description: "Synthesizes executable TypeScript/Deno tool implementations and schemas.",
      systemInstruction:
        "You are the Tool Evolver Tool Synthesis Engine. Synthesize complete, runnable, sandboxed tool code in TypeScript for Deno worker execution. Hard output contract (a static gate rejects violating output): the `code` field must be a complete TypeScript module that imports `defineTool` from \"@tool-evolver/runtime\" and contains `export default defineTool`; route every side effect through the tool context broker (context.broker.fs, context.broker.net, context.broker.cmd, context.broker.secret) — command steps must call `broker.cmd.exec(command, args)`; use exactly the broker families required by the plan steps and never a family the capability envelope does not permit; direct runtime APIs (child_process, Deno.Command, Deno.readFile, fetch, process.env) are forbidden.",
      userTemplate:
        "Plan ID: {{planId}}\nSpecification:\n{{specification}}\nCapability envelope (the only broker families you may use):\n{{requiredCapabilities}}\nExisting Code:\n{{existingCode}}\nSynthesize tool implementation. The `code` field must contain `export default defineTool` and must route every side effect through the tool context broker (command steps via `broker.cmd.exec`).",
      outputSchema: ToolSynthesisOutputSchema,
      jsonSchema: {
        type: "object",
        properties: {
          toolId: { type: "string" },
          name: { type: "string" },
          version: { type: "string" },
          description: { type: "string" },
          schema: { type: "object" },
          code: { type: "string" },
          runtimeRequirements: { type: "array", items: { type: "string" } },
        },
        required: [
          "toolId",
          "name",
          "version",
          "description",
          "schema",
          "code",
          "runtimeRequirements",
        ],
      },
    });

    // 4. Test Generation
    this.register({
      id: "test_generation",
      version: "1.0.0",
      taskClass: "test_generation",
      description: "Generates comprehensive unit and property test suites for synthesized tools.",
      systemInstruction:
        "You are the Tool Evolver Test Generation Engine. Generate unit tests, property tests, and boundary checks for the provided tool implementation. Ensure high test coverage and validation of edge cases.",
      userTemplate:
        "Tool Name: {{toolName}}\nTool Code:\n{{toolCode}}\nTool Schema:\n{{toolSchema}}\nGenerate test suite.",
      outputSchema: TestGenerationOutputSchema,
      jsonSchema: {
        type: "object",
        properties: {
          suiteId: { type: "string" },
          targetTool: { type: "string" },
          unitTests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                code: { type: "string" },
              },
              required: ["name", "description", "code"],
            },
          },
          propertyTests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                property: { type: "string" },
                code: { type: "string" },
              },
              required: ["name", "property", "code"],
            },
          },
          edgeCases: { type: "array", items: { type: "string" } },
        },
        required: ["suiteId", "targetTool", "unitTests", "propertyTests", "edgeCases"],
      },
    });

    // 5. Candidate Scoring
    this.register({
      id: "candidate_scoring",
      version: "1.0.0",
      taskClass: "candidate_scoring",
      description: "Scores candidate tool performance, security, quality, and utility.",
      systemInstruction:
        "You are the Tool Evolver Candidate Scoring Engine. Score candidate tools based on test results, benchmark telemetry, code quality, and security policy checks. Output category breakdowns and promotion recommendation.",
      userTemplate:
        "Candidate ID: {{candidateId}}\nTest Results:\n{{testResults}}\nBenchmark Telemetry:\n{{benchmarkTelemetry}}\nScore candidate tool.",
      outputSchema: CandidateScoringOutputSchema,
      jsonSchema: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          overallScore: { type: "number" },
          approved: { type: "boolean" },
          categories: {
            type: "object",
            properties: {
              quality: { type: "number" },
              performance: { type: "number" },
              security: { type: "number" },
              utility: { type: "number" },
            },
            required: ["quality", "performance", "security", "utility"],
          },
          rationale: { type: "string" },
          recommendations: { type: "array", items: { type: "string" } },
        },
        required: [
          "candidateId",
          "overallScore",
          "approved",
          "categories",
          "rationale",
          "recommendations",
        ],
      },
    });

    // 6. Brokered Tool Planning (brokered_tool_planning v1.0.0)
    this.register({
      id: "brokered_tool_planning",
      version: "1.0.0",
      taskClass: "candidate_planning",
      description:
        "Plans brokered tool synthesis with explicit filesystem, network, command, and secret requirements.",
      systemInstruction:
        "You are the Tool Evolver Brokered Planning Engine. Analyze the detected opportunity and session evidence. Plan a secure, minimal-capability tool using hardened broker contracts (context.fs, context.net, context.cmd, context.secret). Authentication MUST use non-disclosing secret references without requesting raw values. Output structured JSON matching the BrokeredToolPlanningOutputSchema.",
      userTemplate:
        "Opportunity ID: {{opportunityId}}\nClassification: {{classification}}\nEvidence:\n{{evidence}}\nCapability Envelope:\n{{capabilityEnvelope}}\nPlan brokered tool candidate.",
      outputSchema: BrokeredToolPlanningOutputSchema,
    });

    // 7. Capability Synthesis (capability_synthesis v1.0.0)
    this.register({
      id: "capability_synthesis",
      version: "1.0.0",
      taskClass: "candidate_planning",
      description:
        "Synthesizes minimal capability manifest strictly bounded by workspace envelope.",
      systemInstruction:
        "You are the Tool Evolver Capability Minimizer. Derive the strictly minimal CapabilityManifest required for the proposed tool steps. Every requested path, host, command, and secret must be necessary and proven to be a subset of the provided workspace capability envelope. Never grant unneeded permissions.",
      userTemplate:
        "Tool Plan:\n{{plan}}\nWorkspace Envelope:\n{{capabilityEnvelope}}\nSynthesize minimal capability manifest.",
      outputSchema: CapabilitySynthesisOutputSchema,
    });

    // 8. Brokered Tool Synthesis (brokered_tool_synthesis v1.0.0)
    this.register({
      id: "brokered_tool_synthesis",
      version: "1.0.0",
      taskClass: "tool_synthesis",
      description:
        "Synthesizes production-ready, sandboxed TypeScript tool code using runtime broker SDKs and non-disclosing secrets.",
      systemInstruction:
        "You are the Tool Evolver Code Synthesizer. Generate safe, robust TypeScript tool code for execution in a Deno sandbox using @tool-evolver/runtime. Import { defineTool, type ToolContext } from '@tool-evolver/runtime' and { z } from 'zod'. Use context.fs, context.net, context.cmd, and context.secret. NEVER import forbidden modules (node:fs, child_process, http, net). Authentication MUST use context.secret.getSecretRef(...) without reading raw secret values. Always wrap execution in try/catch and log with context.logger.",
      userTemplate:
        "Plan ID: {{planId}}\nSpecification:\n{{specification}}\nRequired Capabilities:\n{{requiredCapabilities}}\nSynthesize brokered tool implementation.",
      outputSchema: ToolSynthesisOutputSchema,
    });

    // 9. Tool Repair (tool_repair v1.0.0 / repair_prompting v1.0.0)
    this.register({
      id: "tool_repair",
      version: "1.0.0",
      taskClass: "tool_synthesis",
      description:
        "Repairs broken or non-compliant tool source code based on structured diagnostic review findings.",
      systemInstruction:
        "You are the Tool Evolver Repair Engine. Review the failed tool code and structured diagnostic findings (syntax, imports, broker usage, capabilities, schema alignment, error handling). Fix the code so it passes all review gates. Capabilities must remain minimal and bounded by the workspace envelope. Do not broaden capabilities beyond what is permitted. Output structured JSON matching ToolRepairOutputSchema.",
      userTemplate:
        "Tool Name: {{toolName}}\nPrevious Code:\n{{previousCode}}\nReview Issues:\n{{reviewIssues}}\nWorkspace Envelope:\n{{capabilityEnvelope}}\nRepair the tool implementation.",
      outputSchema: ToolRepairOutputSchema,
    });

    this.register({
      id: "repair_prompting",
      version: "1.0.0",
      taskClass: "tool_synthesis",
      description:
        "Repairs broken or non-compliant tool source code based on structured diagnostic review findings.",
      systemInstruction:
        "You are the Tool Evolver Repair Engine. Review the failed tool code and structured diagnostic findings. Fix the code so it passes all review gates. Capabilities must remain minimal and bounded by the workspace envelope. Do not broaden capabilities beyond what is permitted. Output structured JSON matching ToolRepairOutputSchema.",
      userTemplate:
        "Tool Name: {{toolName}}\nPrevious Code:\n{{previousCode}}\nReview Issues:\n{{reviewIssues}}\nWorkspace Envelope:\n{{capabilityEnvelope}}\nRepair the tool implementation.",
      outputSchema: ToolRepairOutputSchema,
    });

    // 10. Multi-Step Workflow Planning (workflow_planning v1.0.0)
    this.register({
      id: "workflow_planning",
      version: "1.0.0",
      taskClass: "candidate_planning",
      description:
        "Plans multi-step workflow graphs with variable bindings, minimal capabilities, and safe compensation.",
      systemInstruction:
        "You are the Tool Evolver Workflow Planner. Plan a robust, minimal multi-step workflow graph from observed tool interaction episodes. Each step must declare its toolClass, action, inputs, outputs, dependencies (dependsOn), capability requirements, timeoutMs, retryPolicy (with idempotency verification), failureBehavior, and deterministic compensation action where a safe inverse exists. Variable bindings (${input.x}, ${step.step_id.y}) must be strictly typed and safe. Output structured JSON matching WorkflowPlanningOutputSchema.",
      userTemplate:
        "Workflow Title: {{title}}\nDescription: {{description}}\nObserved Episodes:\n{{episodes}}\nWorkspace Capability Envelope:\n{{capabilityEnvelope}}\nPlan an acyclic workflow graph with variable bindings and compensation.",
      outputSchema: WorkflowPlanningOutputSchema,
    });

    // 11. Step Graph Synthesis (step_graph_synthesis v1.0.0)
    this.register({
      id: "step_graph_synthesis",
      version: "1.0.0",
      taskClass: "tool_synthesis",
      description:
        "Synthesizes executable TypeScript workflow orchestrator code and comprehensive test suites.",
      systemInstruction:
        "You are the Tool Evolver Workflow Synthesizer. Generate executable TypeScript orchestrator source code for Deno execution that executes the planned step graph in topological dependency order, resolves variable bindings safely, tracks a LIFO compensation stack, handles retries with backoff, emits progress events, and rolls back on failure. Also generate unit, property, and failure-injection test suites. Output structured JSON matching WorkflowSynthesisOutputSchema.",
      userTemplate:
        "Workflow Plan:\n{{plan}}\nWorkspace Envelope:\n{{capabilityEnvelope}}\nSynthesize executable workflow code and test suites.",
      outputSchema: WorkflowSynthesisOutputSchema,
    });

    // 12. Safe Compensation Generation (compensation_generation v1.0.0)
    this.register({
      id: "compensation_generation",
      version: "1.0.0",
      taskClass: "tool_synthesis",
      description:
        "Derives safe, deterministic compensation and rollback actions for workflow operations.",
      systemInstruction:
        "You are the Tool Evolver Compensation Engineer. Determine whether a workflow action has a deterministic safe inverse. Safe inverses include: fs.writeFile -> fs.remove or backup restoration, fs.mkdir -> fs.rmdir, fs.copy -> delete dest, reversible cmd -> rollback command. Irreversible or unsafe operations must NOT have synthetic compensation (flag hasDeterministicInverse: false). Output structured JSON matching CompensationGenerationOutputSchema.",
      userTemplate:
        "Step Action: {{action}}\nStep Inputs: {{inputs}}\nWorkflow Context: {{context}}\nDetermine deterministic safe compensation action.",
      outputSchema: CompensationGenerationOutputSchema,
    });
  }
}
