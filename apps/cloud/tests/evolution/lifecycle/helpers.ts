import { randomUUID } from "node:crypto";
import {
  type CapabilityEnvelope,
  type CapabilityManifest,
  type EvaluationResult,
  type EvolutionCandidate,
  type ToolManifest,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import { computeSha256 } from "@tool-evolver/runtime";
import { MemoryDatabasePool } from "../../../src/db/client.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { OutboxPublisher, OutboxRepository } from "../../../src/db/outbox.js";
import {
  SigningKeyRepository,
  ToolRegistryRepository,
} from "../../../src/evolution/artifacts/repositories/index.js";
import { ToolArtifactRegistryService } from "../../../src/evolution/artifacts/service.js";
import { ArtifactSigner } from "../../../src/evolution/artifacts/signer.js";
import { CandidateEvaluationService } from "../../../src/evolution/evaluation/service.js";
import { CandidateRepository } from "../../../src/evolution/generator/repositories/candidate-repository.js";
import type { CandidateRevision } from "../../../src/evolution/generator/types.js";
import { CandidateLifecycleOrchestrator } from "../../../src/evolution/lifecycle/orchestrator.js";
import { LifecycleRepository } from "../../../src/evolution/lifecycle/repositories/lifecycle-repository.js";
import { HistoricalReplayService } from "../../../src/evolution/replay/service.js";
import type { HistoricalReplayResult } from "../../../src/evolution/replay/types.js";
import { CandidateValidationService } from "../../../src/evolution/testing/service.js";
import type { CandidateValidationResult } from "../../../src/evolution/testing/types.js";
import { CloudCatalogService } from "../../../src/mcp/catalog-service.js";
import { MemoryDurableQueue } from "../../../src/queue/queue.js";
import { MemoryObjectStore } from "../../../src/storage/object-store.js";
import type { TenantContext } from "../../../src/tenant.js";

/**
 * Creates a mock ToolManifest for lifecycle testing.
 */
export function createMockToolManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  const base: Omit<ToolManifest, "digest"> = {
    id: "tool_calc_util",
    name: "calculator_utility",
    version: "1.0.0",
    description: "Performs deterministic mathematical calculations",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
        operation: {
          type: "string",
          description: "Operation type",
          enum: ["add", "subtract", "multiply", "divide"],
          default: "add",
        },
      },
      required: ["a", "b"],
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Success status" },
        result: { type: "number", description: "Calculation result" },
      },
      required: ["success", "result"],
    },
    runtime: {
      runtime: "node",
      minRuntimeVersion: "18.0.0",
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
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
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: {
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: "workspace",
    metadata: {},
    createdAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };

  return {
    ...base,
    digest: overrides.digest ?? hashCanonicalContent(base),
  };
}

/**
 * Creates a mock EvolutionCandidate.
 */
export function createMockCandidate(
  tenant: TenantContext,
  overrides: Partial<EvolutionCandidate> = {},
): EvolutionCandidate {
  const candidateId = overrides.id || `cand_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const manifest = createMockToolManifest(overrides.proposedTool);
  const sourceCode =
    overrides.sourceCode ||
    `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  a: z.number(),
  b: z.number(),
  operation: z.enum(["add", "subtract", "multiply", "divide"]).default("add"),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  success: z.boolean(),
  result: z.number(),
});
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, progress } = context;

  await progress(0, "Starting math operation", "init");
  await logger.info("Calculating", { a: input.a, b: input.b, op: input.operation });

  let result = 0;
  if (input.operation === "add") {
    result = input.a + input.b;
  } else if (input.operation === "subtract") {
    result = input.a - input.b;
  } else if (input.operation === "multiply") {
    result = input.a * input.b;
  } else if (input.operation === "divide") {
    if (input.b === 0) {
      throw new Error("Division by zero is not permitted.");
    }
    result = input.a / input.b;
  }

  await progress(100, "Math operation complete", "done");
  await logger.info("Calculation successful", { result });

  return {
    success: true,
    result,
  };
});`;

  return {
    id: candidateId,
    workspaceId: tenant.workspaceId,
    schemaVersion: "1.0.0",
    state: "synthesized",
    trigger: {
      reason: "repeated_pattern",
      evidenceEventIds: [`evt_${randomUUID().replace(/-/g, "").slice(0, 12)}`],
      sessionOccurrences: 5,
      detectedAt: "2026-08-17T00:00:00.000Z",
      patternFrequency: 5,
    },
    proposedTool: manifest,
    requiredCapabilities: manifest.capabilities,
    sourceCode,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Creates a mock CandidateRevision.
 */
export function createMockRevision(
  candidate: EvolutionCandidate,
  tenant: TenantContext,
  overrides: Partial<CandidateRevision> = {},
): CandidateRevision {
  const manifest = candidate.proposedTool;
  const sourceCode = candidate.sourceCode || "";
  const rawOverrides: unknown = overrides;
  const idFromOverrides =
    rawOverrides &&
    typeof rawOverrides === "object" &&
    "id" in rawOverrides &&
    typeof rawOverrides.id === "string"
      ? rawOverrides.id
      : undefined;
  const revisionId = overrides.revisionId ?? idFromOverrides ?? `rev_${candidate.id}_1`;

  return {
    revisionId,
    candidateId: candidate.id,
    revisionNumber: overrides.revisionNumber || 1,
    parentRevisionId: overrides.parentRevisionId,
    artifacts: {
      plan: {
        name: manifest.name,
        description: manifest.description,
        inputSchema: manifest.parameters,
        outputSchema: manifest.outputSchema ?? {},
        capabilities: candidate.requiredCapabilities,
        steps: [],
        variableInputs: [],
        compensationStrategy: "atomic_rollback",
      },
      manifest,
      capabilities: candidate.requiredCapabilities,
      sourceCode,
      generatedAt: "2026-08-17T00:00:00.000Z",
    },
    selfReview: {
      passed: true,
      issues: [],
      reviewedAt: "2026-08-17T00:00:00.000Z",
    },
    repairHistory: [],
    createdAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Creates a mock Brokered Candidate tool requiring external capabilities.
 */
export function createMockBrokeredCandidate(
  tenant: TenantContext,
  overrides: Partial<EvolutionCandidate> = {},
): EvolutionCandidate {
  const candidateId =
    overrides.id || `cand_brokered_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const manifest = createMockToolManifest({
    id: "tool_weather_fetcher",
    name: "weather_fetcher",
    description: "Fetches live weather via external API broker",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        units: { type: "string", enum: ["metric", "imperial"], default: "metric" },
      },
      required: ["city"],
    },
    outputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        temp: { type: "number", description: "Temperature" },
        condition: { type: "string", description: "Weather condition" },
        units: { type: "string", description: "Measurement units" },
      },
      required: ["city", "temp", "condition"],
    },
    capabilities: {
      net: {
        allowOutbound: true,
        allowedDomains: ["api.weather.com", "services.weather.org"],
        allowedHosts: ["api.weather.com", "services.weather.org"],
        allowedPorts: [443],
        allowHttp: false,
        allowHttps: true,
      },
      secrets: {
        allowedSecretNames: ["WEATHER_API_KEY"],
      },
      fs: {
        allowRead: false,
        allowWrite: false,
        readPaths: [],
        writePaths: [],
      },
      exec: {
        allowExec: false,
        allowedCommands: [],
      },
      env: {
        allowAll: false,
        allowEnvPassthrough: [],
      },
      limits: {
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    },
    ...overrides.proposedTool,
  });

  const sourceCode =
    overrides.sourceCode ||
    `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  city: z.string(),
  units: z.enum(["metric", "imperial"]).default("metric"),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  city: z.string(),
  temp: z.number(),
  condition: z.string(),
  units: z.string(),
});
export type ToolOutput = z.infer<typeof OutputSchema>;
export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, progress, broker } = context;
  await progress(0, "Fetching weather data", "init");
  await logger.info("Fetching weather for", { city: input.city });
  if (broker) {
    const b = broker as unknown as { net?: { fetch?: (...args: unknown[]) => Promise<unknown> }; fetch?: (...args: unknown[]) => Promise<unknown> };
    if (b.net?.fetch) {
      await b.net.fetch(\`https://api.weather.com/v1?q=\${encodeURIComponent(input.city)}\`);
    } else if (b.fetch) {
      await b.fetch(\`https://api.weather.com/v1?q=\${encodeURIComponent(input.city)}\`);
    }
  }
  await progress(100, "Fetch complete", "done");
  return {
    city: input.city,
    temp: 22,
    condition: "Sunny",
    units: input.units ?? "metric",
  };
});`;

  return {
    id: candidateId,
    workspaceId: tenant.workspaceId,
    schemaVersion: "1.0.0",
    state: "synthesized",
    trigger: {
      reason: "repeated_pattern",
      evidenceEventIds: [`evt_${randomUUID().replace(/-/g, "").slice(0, 12)}`],
      sessionOccurrences: 4,
      detectedAt: "2026-08-17T00:00:00.000Z",
      patternFrequency: 4,
    },
    proposedTool: manifest,
    requiredCapabilities: manifest.capabilities,
    sourceCode,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Creates a mock Brokered Candidate Revision.
 */
export function createMockBrokeredRevision(
  candidate: EvolutionCandidate,
  tenant: TenantContext,
  overrides: Partial<CandidateRevision> = {},
): CandidateRevision {
  const manifest = candidate.proposedTool;
  const sourceCode = candidate.sourceCode || "";
  const revisionId = overrides.revisionId ?? `rev_${candidate.id}_1`;

  return {
    revisionId,
    candidateId: candidate.id,
    revisionNumber: overrides.revisionNumber || 1,
    parentRevisionId: overrides.parentRevisionId,
    artifacts: {
      plan: {
        name: manifest.name,
        description: manifest.description,
        inputSchema: manifest.parameters,
        outputSchema: manifest.outputSchema ?? {},
        capabilities: candidate.requiredCapabilities,
        steps: [],
        variableInputs: [],
        compensationStrategy: "atomic_rollback",
      },
      manifest,
      capabilities: candidate.requiredCapabilities,
      sourceCode,
      tests: [
        {
          id: "test_brokered_1",
          name: "should fetch weather successfully with mock broker",
          description: "Tests happy path network call via mock broker",
          code: `import { describe, it, expect } from "vitest";
describe("weather_fetcher", () => {
  it("should fetch weather", async () => {
    expect(true).toBe(true);
  });
});`,
          category: "happy_path",
          timeoutMs: 5000,
          mockScenario: {
            net: {
              routes: {
                "https://api.weather.com/v1": {
                  status: 200,
                  body: { temp: 22, condition: "Sunny" },
                },
              },
            },
            secrets: {
              values: { WEATHER_API_KEY: "secret_val_123" },
            },
          },
        },
      ],
      generatedAt: "2026-08-17T00:00:00.000Z",
    },
    selfReview: {
      passed: true,
      issues: [],
      reviewedAt: "2026-08-17T00:00:00.000Z",
    },
    repairHistory: [],
    createdAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Creates a mock Multi-Step Workflow Candidate.
 */
export function createMockWorkflowCandidate(
  tenant: TenantContext,
  overrides: Partial<EvolutionCandidate> = {},
): EvolutionCandidate {
  const candidateId =
    overrides.id || `cand_workflow_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const manifest = createMockToolManifest({
    id: "workflow_weather_summary",
    name: "weather_summary_workflow",
    description: "Multi-step workflow fetching weather data and generating analytical summaries",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        emailReport: { type: "boolean", default: false },
      },
      required: ["city"],
    },
    outputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Weather summary" },
        success: { type: "boolean", description: "Execution status" },
      },
      required: ["summary", "success"],
    },
    capabilities: {
      net: {
        allowOutbound: true,
        allowedDomains: ["api.weather.com", "reports.internal.net"],
        allowedHosts: ["api.weather.com", "reports.internal.net"],
        allowedPorts: [443],
        allowHttp: false,
        allowHttps: true,
      },
      fs: {
        allowRead: false,
        allowWrite: false,
        readPaths: [],
        writePaths: [],
      },
      exec: {
        allowExec: false,
        allowedCommands: [],
      },
      env: {
        allowAll: false,
        allowEnvPassthrough: [],
      },
      limits: {
        maxConcurrentExecutions: 2,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 256,
        maxExecutionTimeMs: 60000,
        maxOutputSizeBytes: 2097152,
      },
    },
    ...overrides.proposedTool,
  });

  const sourceCode =
    overrides.sourceCode ||
    `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  city: z.string(),
  emailReport: z.boolean().default(false),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  summary: z.string(),
  success: z.boolean(),
});
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, progress, broker } = context;
  await progress(0, "Starting workflow execution", "init");
  await logger.info("Workflow execution started", { city: input.city });
  if (broker) {
    const b = broker as unknown as { net?: { fetch?: (...args: unknown[]) => Promise<unknown> }; fetch?: (...args: unknown[]) => Promise<unknown> };
    if (b.net?.fetch) {
      await b.net.fetch(\`https://api.weather.com/v1?q=\${encodeURIComponent(input.city)}\`);
    } else if (b.fetch) {
      await b.fetch(\`https://api.weather.com/v1?q=\${encodeURIComponent(input.city)}\`);
    }
  }
  await progress(100, "Workflow complete", "done");
  return {
    summary: \`Weather summary for \${input.city}: 22C Sunny\`,
    success: true,
  };
});`;

  return {
    id: candidateId,
    workspaceId: tenant.workspaceId,
    schemaVersion: "1.0.0",
    state: "synthesized",
    trigger: {
      reason: "repeated_pattern",
      evidenceEventIds: [`evt_${randomUUID().replace(/-/g, "").slice(0, 12)}`],
      sessionOccurrences: 6,
      detectedAt: "2026-08-17T00:00:00.000Z",
      patternFrequency: 6,
    },
    proposedTool: manifest,
    requiredCapabilities: manifest.capabilities,
    sourceCode,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Creates a mock Multi-Step Workflow Revision.
 */
export function createMockWorkflowRevision(
  candidate: EvolutionCandidate,
  tenant: TenantContext,
  overrides: Partial<CandidateRevision> = {},
): CandidateRevision {
  const manifest = candidate.proposedTool;
  const sourceCode = candidate.sourceCode || "";
  const revisionId = overrides.revisionId ?? `rev_${candidate.id}_1`;

  const workflowDefinition = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    steps: [
      {
        id: "step_1_fetch",
        name: "Fetch Weather Data",
        action: "http.get",
        endpoint: "https://api.weather.com/v1",
        compensation: {
          action: "http.delete",
          endpoint: "https://api.weather.com/v1/session",
        },
      },
      {
        id: "step_2_aggregate",
        name: "Aggregate Metrics",
        action: "compute.transform",
      },
    ],
    compensationPolicy: {
      strategy: "atomic_rollback",
      timeoutMs: 15000,
    },
  };

  return {
    revisionId,
    candidateId: candidate.id,
    revisionNumber: overrides.revisionNumber || 1,
    parentRevisionId: overrides.parentRevisionId,
    artifacts: {
      plan: {
        name: manifest.name,
        description: manifest.description,
        inputSchema: manifest.parameters,
        outputSchema: manifest.outputSchema ?? {},
        capabilities: candidate.requiredCapabilities,
        steps: [
          { id: "step_1", description: "Fetch weather data" },
          { id: "step_2", description: "Aggregate and format summary" },
        ],
        variableInputs: [],
        compensationStrategy: "atomic_rollback",
      },
      manifest,
      capabilities: candidate.requiredCapabilities,
      sourceCode,
      workflowDefinition,
      tests: [
        {
          id: "test_workflow_1",
          name: "should execute all workflow steps and compensate on error",
          description: "Tests multi-step progression and atomic rollback",
          code: `import { describe, it, expect } from "vitest";
describe("weather_summary_workflow", () => {
  it("should run 2 steps and roll back on error", async () => {
    expect(true).toBe(true);
  });
});`,
          category: "happy_path",
          timeoutMs: 10000,
        },
      ],
      generatedAt: "2026-08-17T00:00:00.000Z",
    },
    selfReview: {
      passed: true,
      issues: [],
      reviewedAt: "2026-08-17T00:00:00.000Z",
    },
    repairHistory: [],
    createdAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Creates test environment with real database migrations, object store, outbox, queue, and orchestrator.
 */
export async function createTestLifecycleEnvironment(
  options: {
    validationService?: CandidateValidationService;
    replayService?: CandidateHistoricalReplayService;
    evaluationService?: CandidateEvaluationService;
  } = {},
) {
  const pool = new MemoryDatabasePool();
  await runMigrations(pool);

  const objectStore = new MemoryObjectStore();
  const queue = new MemoryDurableQueue();
  const outboxPublisher = new OutboxPublisher(pool);
  outboxPublisher.subscribe("*", async (record) => {
    const rawPayload = record.payload;
    const idempotencyKey =
      rawPayload &&
      typeof rawPayload === "object" &&
      "idempotencyKey" in rawPayload &&
      typeof rawPayload.idempotencyKey === "string"
        ? rawPayload.idempotencyKey
        : undefined;
    await queue.enqueue({
      jobId: `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      jobType: record.eventType,
      version: "1.0.0",
      tenantContext: {
        accountId: record.accountId,
        workspaceId: record.workspaceId,
      },
      payload: record.payload,
      idempotencyKey,
      attempt: 1,
      maxAttempts: 3,
      priority: "standard",
      createdAt: new Date().toISOString(),
    });
  });

  const toolRegistryRepo = new ToolRegistryRepository(pool);
  const signingKeyRepo = new SigningKeyRepository(pool);
  const candidateRepo = new CandidateRepository(pool, objectStore);
  const lifecycleRepo = new LifecycleRepository(pool);

  const artifactService = new ToolArtifactRegistryService(pool, objectStore, {
    toolRegistryRepo,
    signingKeyRepo,
  });

  const catalogService = new CloudCatalogService({
    dbPool: pool,
    toolRegistryRepo,
  });

  const validationService = options.validationService ?? new CandidateValidationService();
  const replayService = options.replayService ?? new HistoricalReplayService();
  const evaluationService = options.evaluationService ?? new CandidateEvaluationService();

  const orchestrator = new CandidateLifecycleOrchestrator(pool, {
    validationService,
    replayService,
    evaluationService,
    artifactService,
    catalogService,
    candidateRepo,
    lifecycleRepo,
    outboxPublisher,
    queue,
    objectStore,
  });

  return {
    pool,
    objectStore,
    queue,
    outboxPublisher,
    toolRegistryRepo,
    signingKeyRepo,
    candidateRepo,
    lifecycleRepo,
    artifactService,
    catalogService,
    validationService,
    replayService,
    evaluationService,
    orchestrator,
  };
}
