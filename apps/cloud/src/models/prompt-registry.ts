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
        "Opportunity ID: {{opportunityId}}\nOpportunity Details:\n{{opportunityDetails}}\nCurrent Tool Manifest:\n{{currentManifest}}\nGenerate candidate evolution plan.",
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
        "You are the Tool Evolver Tool Synthesis Engine. Synthesize complete, runnable, sandboxed tool code in TypeScript for Deno worker execution. Produce valid schema definitions, documentation, and safe execution logic adhering to capability envelopes.",
      userTemplate:
        "Plan ID: {{planId}}\nSpecification:\n{{specification}}\nExisting Code:\n{{existingCode}}\nSynthesize tool implementation.",
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
  }
}
