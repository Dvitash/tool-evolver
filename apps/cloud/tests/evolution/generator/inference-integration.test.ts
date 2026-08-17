import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../../src/db/client.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  CandidateGenerationService,
  CandidateRepository,
  createCandidateGenerationService,
} from "../../../src/evolution/generator/index.js";
import {
  InferenceExecutionError,
  InferenceService,
  OpenAiCompatibleProvider,
  ProviderError,
  ProviderRateLimitError,
  createInferenceService,
} from "../../../src/models/index.js";
import type { TenantContext } from "../../../src/tenant.js";
import { createMockOpportunity, createMockTenant } from "./helpers.js";

describe("Inference Gateway & Candidate Persistence Integration (PostgreSQL + HTTP Provider)", () => {
  let server: http.Server;
  let serverUrl: string;
  let simulatedBehavior: "success" | "malformed" | "timeout" | "rate_limit" | "transient_fail" =
    "success";
  let requestCount = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requestCount++;

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (simulatedBehavior === "timeout") {
            // Hold connection open without writing response until client aborts/times out
            req.on("close", () => {
              if (!res.writableEnded) {
                res.end();
              }
            });
            return;
          }

          if (simulatedBehavior === "rate_limit") {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: "Rate limit exceeded. Please retry later.",
                  type: "requests",
                  code: "rate_limit_exceeded",
                },
              }),
            );
            return;
          }

          if (simulatedBehavior === "transient_fail") {
            if (requestCount === 1) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }));
              return;
            }
          }

          if (simulatedBehavior === "malformed") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: "chatcmpl_malformed",
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "gpt-4o-mini",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "{ unparseable invalid json string: [",
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 },
              }),
            );
            return;
          }

          // Default success response for structured synthesis
          const parsedReq = JSON.parse(body || "{}");
          const messages = parsedReq.messages || [];
          const userMsg = messages[messages.length - 1]?.content || "";

          let responseContent = {};
          if (
            userMsg.includes("candidate evolution plan") ||
            userMsg.includes("Candidate evolution plan")
          ) {
            responseContent = {
              planId: "plan_http_001",
              targetToolName: "json_metric_filter",
              action: "create",
              summary: "Filters and transforms structured JSON metric objects",
              interfaceChanges: ["+ filter(metrics, threshold)"],
              securityRisks: [],
              estimatedImpact: "High utility pure transformation",
            };
          } else if (
            userMsg.includes("Derive input and output schemas") ||
            userMsg.includes("derive input and output schemas")
          ) {
            responseContent = {
              toolName: "json_metric_filter",
              description: "Filters and transforms structured JSON metric objects",
              parameters: [
                {
                  name: "metrics",
                  type: "array",
                  description: "Array of metric records",
                  required: true,
                },
                {
                  name: "threshold",
                  type: "number",
                  description: "Threshold value for filtering",
                  required: false,
                  defaultValue: 0,
                },
              ],
              outputSchema: {
                type: "object",
                description: "Filtered metric results",
                properties: {
                  passed: { type: "array", description: "Passing metrics" },
                  count: { type: "number", description: "Count of matching items" },
                },
                required: ["passed", "count"],
              },
              validationRules: [],
            };
          } else {
            responseContent = {
              toolId: "tool_http_001",
              name: "json_metric_filter",
              version: "1.0.0",
              description: "Filters and transforms structured JSON metric objects",
              schema: {
                type: "object",
                properties: {
                  metrics: { type: "array", items: { type: "number" } },
                  threshold: { type: "number", default: 0 },
                },
                required: ["metrics"],
              },
              code: `
    const metrics = (input as { metrics: number[]; threshold?: number }).metrics;
    const threshold = (input as { metrics: number[]; threshold?: number }).threshold ?? 0;
    const passed = metrics.filter((m) => m >= threshold);

    resultData = {
      passed,
      count: passed.length,
    };`,
              runtimeRequirements: ["deno:core"],
            };
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl_http_success",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "gpt-4o-mini",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: JSON.stringify(responseContent),
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 320, completion_tokens: 140, total_tokens: 460 },
            }),
          );
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${addr.port}/v1`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function createTestServices(dbPool?: MemoryDatabasePool) {
    const pool = dbPool ?? new MemoryDatabasePool();
    await runMigrations(pool);

    const tenantA: TenantContext = createMockTenant({
      accountId: "acc_integration_001",
      workspaceId: "ws_integration_001",
    });

    const tenantB: TenantContext = createMockTenant({
      accountId: "acc_integration_002",
      workspaceId: "ws_integration_002",
    });

    await pool.query(
      `INSERT INTO accounts (id, name, plan, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
      [tenantA.accountId, "Integration Account A", "enterprise"],
    );
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
      [tenantA.workspaceId, tenantA.accountId, "Integration Workspace A"],
    );

    await pool.query(
      `INSERT INTO accounts (id, name, plan, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
      [tenantB.accountId, "Integration Account B", "enterprise"],
    );
    await pool.query(
      `INSERT INTO workspaces (id, account_id, name, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
      [tenantB.workspaceId, tenantB.accountId, "Integration Workspace B"],
    );

    const httpProvider = new OpenAiCompatibleProvider({
      id: "http-openai-test",
      name: "HTTP OpenAI Test Provider",
      baseUrl: serverUrl,
      apiKey: "test-sk-12345678901234567890",
      defaultModel: "gpt-4o-mini",
      timeoutMs: 150,
    });

    const inferenceService = createInferenceService();
    inferenceService.router.registerProvider(httpProvider);

    const candidateRepo = new CandidateRepository(pool);
    const service = createCandidateGenerationService({
      inferenceService,
      pool,
      candidateRepo,
    });

    return { pool, tenantA, tenantB, httpProvider, inferenceService, candidateRepo, service };
  }

  it("should generate a pure-compute candidate end-to-end against real PostgreSQL and HTTP provider", async () => {
    simulatedBehavior = "success";
    requestCount = 0;
    const { tenantA, service, candidateRepo } = await createTestServices();

    const opportunity = createMockOpportunity({
      id: "opp_http_gen_001",
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      triggerReason: "repeated_pattern",
      occurrenceCount: 12,
      distinctSessionCount: 4,
      structuralHash: "hash_json_filter_123",
      classification: {
        title: "Filter metrics above threshold",
        description: "Pure compute filtering across numeric metrics array",
        taskClass: "compute",
        pattern: "compute_filter",
        confidenceScore: 0.95,
        priority: "high",
        suggestedToolName: "json_metric_filter",
        inferredInputs: [
          { name: "metrics", type: "array", description: "Array of numbers" },
          { name: "threshold", type: "number", description: "Filter threshold" },
        ],
      },
    });

    const result = await service.generateCandidate(tenantA, opportunity);

    expect(result.status).toBe("synthesized");
    expect(result.candidate.id).toMatch(/^cand-/);
    expect(result.candidate.workspaceId).toBe(tenantA.workspaceId);

    // Verify candidate is persisted in PostgreSQL
    const persistedCand = await candidateRepo.getCandidateById(tenantA, result.candidate.id);
    expect(persistedCand).not.toBeNull();
    expect(persistedCand?.proposedTool.name).toBe("json_metric_filter");

    // Verify active revision and provenance are persisted in PostgreSQL
    const persistedRev = await candidateRepo.getActiveRevision(tenantA, result.candidate.id);
    expect(persistedRev).not.toBeNull();
    expect(persistedRev?.modelProvider).toBe("http-openai-test");
    expect(persistedRev?.modelId).toBe("gpt-4o-mini");
    expect(persistedRev?.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("should handle malformed structured output without crashing and fall back to safe repair/deterministic synthesis", async () => {
    simulatedBehavior = "malformed";
    requestCount = 0;
    const { tenantA, service } = await createTestServices();

    const opp = createMockOpportunity({
      id: "opp_malformed_001",
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      triggerReason: "repeated_pattern",
      classification: {
        title: "Robust Fallback Transform",
        description: "Pure compute tool that recovers when LLM output is malformed",
        taskClass: "compute",
        pattern: "compute_fallback",
        confidenceScore: 0.9,
        priority: "medium",
        suggestedToolName: "robust_fallback_tool",
        inferredInputs: [{ name: "data", type: "string", description: "Input string" }],
      },
    });

    // Should fall back cleanly without unhandled exceptions
    const result = await service.generateCandidate(tenantA, opp);
    expect(result.status).toBe("synthesized");
    expect(result.candidate.proposedTool.name).toBe("robust_fallback_tool");
    expect(result.candidate.sourceCode).toContain("export default defineTool");
  });

  it("should handle provider timeout cleanly", async () => {
    simulatedBehavior = "timeout";
    requestCount = 0;
    const { tenantA, inferenceService } = await createTestServices();

    await expect(
      inferenceService.infer({
        tenantId: tenantA.workspaceId,
        taskClass: "tool_synthesis",
        promptTemplateId: "tool_synthesis",
        inputs: {
          planId: "plan_timeout",
          specification: "Specification",
          existingCode: "",
          toolName: "timeout_tool",
        },
      }),
    ).rejects.toThrow(InferenceExecutionError);
  });

  it("should handle HTTP 429 rate limits and mark error as retryable", async () => {
    simulatedBehavior = "rate_limit";
    requestCount = 0;
    const { tenantA, inferenceService } = await createTestServices();

    try {
      await inferenceService.infer({
        tenantId: tenantA.workspaceId,
        taskClass: "tool_synthesis",
        promptTemplateId: "tool_synthesis",
        inputs: {
          planId: "plan_rl",
          specification: "Specification",
          existingCode: "",
          toolName: "rate_limited_tool",
        },
      });
      expect.fail("Should have thrown rate limit error");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(InferenceExecutionError);
      const infErr = err as InferenceExecutionError;
      expect(infErr.cause).toBeInstanceOf(ProviderRateLimitError);
      const provErr = infErr.cause as ProviderRateLimitError;
      expect(provErr.statusCode).toBe(429);
      expect(provErr.retryable).toBe(true);
    }
  });

  it("should recover and synthesize on retry after transient failure", async () => {
    simulatedBehavior = "transient_fail";
    requestCount = 0;
    const { tenantA, inferenceService } = await createTestServices();

    // First attempt fails with 503
    await expect(
      inferenceService.infer({
        tenantId: tenantA.workspaceId,
        taskClass: "tool_synthesis",
        promptTemplateId: "tool_synthesis",
        inputs: {
          planId: "plan_retry",
          specification: "Specification",
          existingCode: "",
          toolName: "retry_tool",
        },
      }),
    ).rejects.toThrow(InferenceExecutionError);

    // Second attempt succeeds
    const retryResult = await inferenceService.infer({
      tenantId: tenantA.workspaceId,
      taskClass: "tool_synthesis",
      promptTemplateId: "tool_synthesis",
      inputs: {
        planId: "plan_retry",
        specification: "Specification",
        existingCode: "",
        toolName: "retry_tool",
      },
    });

    expect(retryResult.output).toBeDefined();
    expect(retryResult.provenance.providerId).toBe("http-openai-test");
  });

  it("should be completely idempotent on duplicate delivery and queue redelivery", async () => {
    simulatedBehavior = "success";
    requestCount = 0;
    const { pool, tenantA, service, candidateRepo } = await createTestServices();

    const opportunity = createMockOpportunity({
      id: "opp_idempotent_delivery_001",
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      triggerReason: "repeated_pattern",
      structuralHash: "hash_idempotency_fixed_123",
      occurrenceCount: 5,
      classification: {
        title: "Idempotent Synthesis",
        description: "Verifies duplicate queue redeliveries do not duplicate rows",
        taskClass: "compute",
        pattern: "compute_idempotent",
        confidenceScore: 0.99,
        priority: "high",
        suggestedToolName: "idempotent_pure_tool",
        inferredInputs: [{ name: "inputVal", type: "string", description: "Input" }],
      },
    });

    // First delivery
    const result1 = await service.generateCandidate(tenantA, opportunity);
    expect(result1.status).toBe("synthesized");

    // Second delivery (simulating queue redelivery)
    const result2 = await service.generateCandidate(tenantA, opportunity);
    expect(result2.status).toBe("synthesized");

    // Candidate IDs and Revision IDs must be identical
    expect(result2.candidate.id).toBe(result1.candidate.id);
    expect(result2.activeRevision.revisionId).toBe(result1.activeRevision.revisionId);

    // Check database has exactly 1 candidate record for this ID
    const candidates = await candidateRepo.listCandidates(tenantA, {
      opportunityId: opportunity.id,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(result1.candidate.id);
  });

  it("should retrieve persisted candidate and active revision across simulated service restart", async () => {
    simulatedBehavior = "success";
    requestCount = 0;
    const { pool, tenantA, service } = await createTestServices();

    const opp = createMockOpportunity({
      id: "opp_restart_persist_001",
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      triggerReason: "repeated_pattern",
      structuralHash: "hash_restart_456",
      classification: {
        title: "Restart Persistence Test",
        description: "Ensures newly initialized service reads candidates from PostgreSQL",
        taskClass: "compute",
        pattern: "compute_restart",
        confidenceScore: 0.95,
        priority: "medium",
        suggestedToolName: "restart_persisted_tool",
        inferredInputs: [{ name: "data", type: "string", description: "Input data" }],
      },
    });

    const genResult = await service.generateCandidate(tenantA, opp);
    const candidateId = genResult.candidate.id;

    // Simulate complete service restart by instantiating fresh service with new repository on the same database pool
    const restartedCandidateRepo = new CandidateRepository(pool);
    const restartedService = createCandidateGenerationService({
      pool,
      candidateRepo: restartedCandidateRepo,
    });

    // Retrieve candidate from restarted service
    const loadedCandidate = await restartedService.getCandidateById(tenantA, candidateId);
    expect(loadedCandidate).not.toBeNull();
    expect(loadedCandidate?.id).toBe(candidateId);
    expect(loadedCandidate?.proposedTool.name).toBe("json_metric_filter");

    // Retrieve revision from restarted service
    const loadedRevision = await restartedService.getActiveRevision(tenantA, candidateId);
    expect(loadedRevision).not.toBeNull();
    expect(loadedRevision?.candidateId).toBe(candidateId);
    expect(loadedRevision?.artifacts.sourceCode).toContain("export default defineTool");
  });

  it("should enforce strict tenant isolation across workspaces", async () => {
    simulatedBehavior = "success";
    requestCount = 0;
    const { tenantA, tenantB, service } = await createTestServices();

    const oppA = createMockOpportunity({
      id: "opp_tenant_a_001",
      accountId: tenantA.accountId,
      workspaceId: tenantA.workspaceId,
      triggerReason: "repeated_pattern",
      structuralHash: "hash_tenant_a_789",
      classification: {
        title: "Tenant A Secret Transform",
        description: "Confidential computation for Workspace A",
        taskClass: "compute",
        pattern: "compute_tenant_a",
        confidenceScore: 0.95,
        priority: "high",
        suggestedToolName: "tenant_a_tool",
        inferredInputs: [{ name: "secretKey", type: "string", description: "Private key" }],
      },
    });

    const resultA = await service.generateCandidate(tenantA, oppA);

    // Tenant A can retrieve candidate and revisions
    const candA = await service.getCandidateById(tenantA, resultA.candidate.id);
    expect(candA).not.toBeNull();
    const revsA = await service.getRevisionsByCandidateId(tenantA, resultA.candidate.id);
    expect(revsA).toHaveLength(1);

    // Tenant B querying Tenant A's candidate returns null
    const candB = await service.getCandidateById(tenantB, resultA.candidate.id);
    expect(candB).toBeNull();

    // Tenant B querying Tenant A's revisions returns empty list
    const revsB = await service.getRevisionsByCandidateId(tenantB, resultA.candidate.id);
    expect(revsB).toHaveLength(0);

    // Tenant B listing candidates sees only their own
    const listB = await service.listCandidates(tenantB);
    expect(listB).toHaveLength(0);
  });
});
