import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../../src/db/client.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  CandidateGenerationService,
  CandidatePlanner,
  CandidateRepository,
  CodeGenerator,
  SchemaGenerator,
  createCandidateGenerationService,
} from "../../../src/evolution/generator/index.js";
import {
  FakeToolBrokerClient,
  ValidationSandbox,
} from "../../../src/evolution/testing/validation-sandbox.js";
import {
  FakeModelProvider,
  InferenceService,
  OutboundPrivacyGate,
  PrivacyViolationError,
  PromptRegistry,
  createInferenceService,
} from "../../../src/models/index.js";
import type { TenantContext } from "../../../src/tenant.js";
import { createMockEnvelope, createMockOpportunity, createMockTenant } from "./helpers.js";

describe("Pure-Compute Tool Synthesis with Structured Inference & Provenance", () => {
  async function setupEnvironment() {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);

    const tenant: TenantContext = createMockTenant({
      accountId: "acc_pure_comp_001",
      workspaceId: "ws_pure_comp_001",
    });

    await pool.query(
      `INSERT INTO accounts (id, name, plan, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
      [tenant.accountId, "Pure Compute Account", "enterprise"],
    );
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
      [tenant.workspaceId, tenant.accountId, "Pure Compute Workspace"],
    );

    const promptRegistry = new PromptRegistry();
    const privacyGate = new OutboundPrivacyGate();
    const inferenceService = createInferenceService({ promptRegistry, privacyGate });
    const fakeProvider = new FakeModelProvider({
      id: "mock-llm-primary",
      defaultModel: "gpt-4o-mini",
    });
    inferenceService.router.registerProvider(fakeProvider);

    const candidateRepo = new CandidateRepository(pool);
    const service = createCandidateGenerationService({
      inferenceService,
      pool,
      candidateRepo,
    });

    return {
      pool,
      tenant,
      promptRegistry,
      privacyGate,
      inferenceService,
      fakeProvider,
      candidateRepo,
      service,
    };
  }

  it("should synthesize a workflow-specific pure-compute tool using versioned structured prompts", async () => {
    const { tenant, service, fakeProvider } = await setupEnvironment();

    // Configure mock provider to return specific pure-compute responses
    fakeProvider.registerMockResponse(
      (req) =>
        req.schemaName === "tool_synthesis" || req.systemInstruction.includes("Tool Synthesis"),
      (req) => ({
        toolId: "tool_vec_stats",
        name: "vector_stats_aggregator",
        version: "1.0.0",
        description:
          "Computes mathematical aggregates and normalized z-scores for numerical vectors.",
        schema: {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "number" }, description: "Input vector" },
          },
          required: ["values"],
        },
        code: `
    const values = (input as { values: number[] }).values;
    const count = values.length;
    const sum = values.reduce((acc, v) => acc + v, 0);
    const mean = count > 0 ? sum / count : 0;
    const variance = count > 0 ? values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / count : 0;
    const stdDev = Math.sqrt(variance);

    resultData = {
      count,
      sum,
      mean,
      variance,
      stdDev,
      normalized: values.map((v) => (stdDev > 0 ? (v - mean) / stdDev : 0)),
    };`,
        runtimeRequirements: ["deno:core"],
      }),
    );

    const opportunity = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      triggerReason: "repeated_pattern",
      occurrenceCount: 18,
      distinctSessionCount: 5,
      classification: {
        title: "Aggregate vector statistics",
        description:
          "Calculate statistical aggregates across vector float arrays without filesystem or network access",
        taskClass: "compute",
        pattern: "compute_vector_stats",
        confidenceScore: 0.98,
        priority: "high",
        suggestedToolName: "vector_stats_aggregator",
        inferredInputs: [
          { name: "values", type: "array", description: "Array of float numbers to aggregate" },
        ],
      },
    });

    const envelope = createMockEnvelope({
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: false,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 0,
        },
        net: {
          allowOutbound: false,
          allowedHosts: [],
          denyHosts: [],
          allowedPorts: [],
          allowInsecure: false,
          maxResponseBodyBytes: 0,
        },
        command: {
          allowedCommands: [],
          allowShellExecution: false,
          environmentVariables: {},
          denyCommands: [],
        },
        secret: { allowedKeyPrefixes: [], denyKeyPrefixes: [] },
      },
    });

    const result = await service.generateCandidate(tenant, opportunity, { envelope });

    expect(result.status).toBe("synthesized");
    expect(result.candidate).toBeDefined();
    expect(result.candidate.id).toMatch(/^cand-/);
    expect(result.candidate.workspaceId).toBe(tenant.workspaceId);
    expect(result.candidate.trigger.reason).toBe("repeated_pattern");
    expect(result.candidate.trigger.sessionOccurrences).toBe(18);
    expect(result.candidate.requiredCapabilities.fs.readPaths).toHaveLength(0);
    expect(result.candidate.requiredCapabilities.net.allowOutbound).toBe(false);
    expect(result.candidate.requiredCapabilities.command.allowShellExecution).toBe(false);

    // Provenance must capture prompt template versions, provider, model, and token usage
    const activeRevision = result.activeRevision;
    expect(activeRevision.promptTemplateId).toBe("tool_synthesis");
    expect(activeRevision.promptTemplateVersion).toBe("1.0.0");
    expect(activeRevision.modelProvider).toBe("mock-llm-primary");
    expect(activeRevision.modelId).toBe("gpt-4o-mini");
    expect(activeRevision.requestId).toBeDefined();
    expect(activeRevision.usage).toBeDefined();
    expect(activeRevision.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("should prevent model outputs from overwriting deterministic opportunity evidence, tenant identity, or capability envelope", async () => {
    const { tenant, service, fakeProvider } = await setupEnvironment();

    // Adversarial model response attempting to escalate privileges and overwrite tenant context
    fakeProvider.registerMockResponse(
      (req) =>
        req.schemaName === "candidate_planning" || req.systemInstruction.includes("Planning"),
      () => ({
        planId: "attacker_plan_999",
        targetToolName: "root_shell_escalator",
        action: "create",
        summary: "Escalate privilege to shell execution",
        interfaceChanges: ["+ exec(command)"],
        securityRisks: [],
        estimatedImpact: "Critical impact",
        suggestedInputs: [
          {
            name: "cmd",
            type: "string",
            description: "Command to execute as root",
            required: true,
          },
        ],
      }),
    );

    const opportunity = createMockOpportunity({
      id: "opp_immutable_evidence_001",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      triggerReason: "repeated_pattern",
      occurrenceCount: 42,
      distinctSessionCount: 9,
      structuralHash: "hash_determ_456",
      classification: {
        title: "Pure Hash Transform",
        description: "Transform input data without capabilities",
        taskClass: "compute",
        pattern: "compute_hash",
        confidenceScore: 0.95,
        priority: "medium",
        suggestedToolName: "pure_hasher",
        inferredInputs: [{ name: "data", type: "string", description: "Input string" }],
      },
    });

    const tightEnvelope = createMockEnvelope({
      capabilities: {
        command: {
          allowedCommands: [],
          allowShellExecution: false,
          environmentVariables: {},
          denyCommands: [],
        },
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: false,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 0,
        },
        net: {
          allowOutbound: false,
          allowedHosts: [],
          denyHosts: [],
          allowedPorts: [],
          allowInsecure: false,
          maxResponseBodyBytes: 0,
        },
        secret: { allowedKeyPrefixes: [], denyKeyPrefixes: [] },
      },
    });

    const result = await service.generateCandidate(tenant, opportunity, {
      envelope: tightEnvelope,
    });

    // Deterministic fields must remain completely intact
    expect(result.candidate.workspaceId).toBe(tenant.workspaceId);
    expect(result.candidate.trigger.reason).toBe("repeated_pattern");
    expect(result.candidate.trigger.sessionOccurrences).toBe(42);
    expect(result.candidate.requiredCapabilities.command.allowShellExecution).toBe(false);
  });

  it("should block raw transcripts and secrets via privacy gate during candidate generation", async () => {
    const { tenant, inferenceService } = await setupEnvironment();

    // Payload containing forbidden raw transcript markers
    const forbiddenRequest = {
      tenantId: tenant.workspaceId,
      taskClass: "tool_synthesis" as const,
      promptTemplateId: "tool_synthesis",
      inputs: {
        planId: "plan_test",
        specification:
          "Synthesize tool for raw transcript: [RAW_TRANSCRIPT] user said: secret_password_123",
        existingCode: "",
        toolName: "leaky_tool",
        workflowEvidence: "--- BEGIN RAW USER TRANSCRIPT ---\nSELECT * FROM sensitive_users;",
      },
    };

    await expect(inferenceService.infer(forbiddenRequest)).rejects.toThrow(PrivacyViolationError);
  });

  it("should execute the synthesized tool in ValidationSandbox and verify exact transformation against declared schemas", async () => {
    const { tenant, service, fakeProvider } = await setupEnvironment();
    fakeProvider.registerMockResponse(
      (req) =>
        req.schemaName === "schema_generation" ||
        req.userMessage.includes("Derive input and output schemas"),
      () => ({
        toolName: "math_stats_calculator",
        description: "Calculates mathematical summary statistics for numerical input arrays.",
        parameters: [
          {
            name: "values",
            type: "array",
            description: "Input numbers",
            required: true,
          },
        ],
        outputSchema: {
          type: "object",
          description: "Summary statistics",
          properties: {
            count: { type: "number", description: "Count of values" },
            sum: { type: "number", description: "Sum of values" },
            mean: { type: "number", description: "Mean of values" },
            min: { type: "number", description: "Minimum value" },
            max: { type: "number", description: "Maximum value" },
          },
          required: ["count", "sum", "mean", "min", "max"],
        },
        validationRules: ["values must be a non-empty array of numbers"],
      }),
    );

    fakeProvider.registerMockResponse(
      (req) =>
        req.schemaName === "tool_synthesis" || req.systemInstruction.includes("Tool Synthesis"),
      () => ({
        toolId: "tool_stats",
        name: "math_stats_calculator",
        version: "1.0.0",
        description: "Calculates mathematical summary statistics for numerical input arrays.",
        schema: {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "number" }, description: "Input numbers" },
          },
          required: ["values"],
        },
        code: `
    const values = (input as { values: number[] }).values;
    const count = values.length;
    const sum = values.reduce((acc, v) => acc + v, 0);
    const mean = count > 0 ? sum / count : 0;
    const sorted = [...values].sort((a, b) => a - b);
    const min = count > 0 ? sorted[0] : 0;
    const max = count > 0 ? sorted[count - 1] : 0;

    resultData = {
      count,
      sum,
      mean,
      min,
      max,
    };`,
        runtimeRequirements: ["deno:core"],
      }),
    );

    const opp = createMockOpportunity({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      classification: {
        title: "Compute numerical stats",
        description: "Calculate statistical aggregates across numerical values array",
        taskClass: "compute",
        pattern: "compute_stats",
        confidenceScore: 0.96,
        priority: "high",
        suggestedToolName: "math_stats_calculator",
        inferredInputs: [{ name: "values", type: "array", description: "Array of numbers" }],
      },
    });

    const genResult = await service.generateCandidate(tenant, opp);
    expect(genResult.status).toBe("synthesized");

    // Execute in sandbox with real input fixture
    const sandbox = new ValidationSandbox();
    const broker = new FakeToolBrokerClient();

    const runResult = await sandbox.executeCandidate(
      genResult.candidate.sourceCode!,
      genResult.candidate.proposedTool,
      { values: [10, 20, 30, 40, 50] },
      broker,
    );

    expect(runResult.error).toBeUndefined();
    expect(runResult.output).toEqual({
      success: true,
      data: {
        count: 5,
        sum: 150,
        mean: 30,
        min: 10,
        max: 50,
      },
    });
  });
});
