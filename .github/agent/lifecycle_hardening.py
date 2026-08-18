from __future__ import annotations

from pathlib import Path
import re

ROOT = Path.cwd()


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def write(rel: str, text: str) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def replace_once(rel: str, old: str, new: str) -> None:
    text = read(rel)
    if old not in text:
        raise SystemExit(f"marker not found in {rel}: {old[:120]!r}")
    write(rel, text.replace(old, new, 1))


def regex_once(rel: str, pattern: str, replacement: str, flags: int = re.S) -> None:
    text = read(rel)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"regex marker not found in {rel}: {pattern[:120]!r}")
    write(rel, updated)


# Provider-neutral model configuration and production readiness.
config = "apps/cloud/src/config.ts"
replace_once(
    config,
    "/**\n * Comprehensive Cloud Configuration schema.\n */\nexport const CloudConfigSchema = z.object({\n",
    '''/** Model provider used by the structured inference gateway. */
export const ModelProviderSchema = z
  .enum(["disabled", "openai-compatible"])
  .default("disabled");
export type ModelProviderKind = z.infer<typeof ModelProviderSchema>;

export const ModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  providerId: z.string().min(1).default("primary"),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  organizationId: z.string().optional(),
  model: z.string().min(1).default("gpt-4o-mini"),
  timeoutMs: z.coerce.number().int().positive().default(30000),
  allowDeterministicFallback: z.boolean().default(true),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Comprehensive Cloud Configuration schema.
 */
export const CloudConfigSchema = z.object({
''',
)
replace_once(
    config,
    "  auth: AuthConfigSchema,\n  server: ServerConfigSchema,\n});",
    "  auth: AuthConfigSchema,\n  models: ModelConfigSchema.default({}),\n  server: ServerConfigSchema,\n});",
)
replace_once(
    config,
    "  queue: QueueConfig;\n  auth: Omit<AuthConfig, \"jwtSecret\" | \"deviceTokenSecret\"> & {",
    "  queue: QueueConfig;\n  models: Omit<ModelConfig, \"apiKey\"> & { apiKey?: string };\n  auth: Omit<AuthConfig, \"jwtSecret\" | \"deviceTokenSecret\"> & {",
)
replace_once(
    config,
    "    queue: {\n      ...config.queue,\n    },\n    auth: {",
    "    queue: {\n      ...config.queue,\n    },\n    models: {\n      ...config.models,\n      apiKey: config.models.apiKey ? \"[REDACTED]\" : undefined,\n    },\n    auth: {",
)
replace_once(
    config,
    "  if (config.database.url.startsWith(\"memory://\")) violations.push(\"memory database is configured\");\n",
    '''  if (config.database.url.startsWith("memory://")) violations.push("memory database is configured");
  if (config.models.provider === "disabled") {
    violations.push("structured inference provider is disabled");
  }
  if (config.models.provider === "openai-compatible" && !config.models.baseUrl) {
    violations.push("structured inference base URL is missing");
  }
  if (config.models.allowDeterministicFallback) {
    violations.push("deterministic synthesis fallback is enabled");
  }
''',
)
replace_once(
    config,
    "    auth: {\n      jwtSecret: env.AUTH_JWT_SECRET ?? \"dev-jwt-secret-min-16-characters-long\",",
    '''    models: {
      provider:
        (env.MODEL_PROVIDER as "disabled" | "openai-compatible" | undefined) ?? "disabled",
      providerId: env.MODEL_PROVIDER_ID ?? "primary",
      baseUrl: env.MODEL_BASE_URL,
      apiKey: env.MODEL_API_KEY,
      organizationId: env.MODEL_ORGANIZATION_ID,
      model: env.MODEL_ID ?? "gpt-4o-mini",
      timeoutMs: env.MODEL_TIMEOUT_MS ? Number(env.MODEL_TIMEOUT_MS) : 30000,
      allowDeterministicFallback: env.MODEL_ALLOW_DETERMINISTIC_FALLBACK
        ? env.MODEL_ALLOW_DETERMINISTIC_FALLBACK === "true" ||
          env.MODEL_ALLOW_DETERMINISTIC_FALLBACK === "1"
        : environment === "development" || environment === "test",
    },
    auth: {
      jwtSecret: env.AUTH_JWT_SECRET ?? "dev-jwt-secret-min-16-characters-long",''',
)
replace_once(
    config,
    "    queue: { ...rawFromEnv.queue, ...overrides?.queue },\n    auth: { ...rawFromEnv.auth, ...overrides?.auth },",
    "    queue: { ...rawFromEnv.queue, ...overrides?.queue },\n    models: { ...rawFromEnv.models, ...overrides?.models },\n    auth: { ...rawFromEnv.auth, ...overrides?.auth },",
)

# No silent production inference fallback.
codegen = "apps/cloud/src/evolution/generator/code-generator.ts"
replace_once(
    codegen,
    "      workflowEvidence?: string;\n    } = {},",
    "      workflowEvidence?: string;\n      allowDeterministicFallback?: boolean;\n    } = {},",
)
replace_once(
    codegen,
    "      } catch {\n        // Fall back to deterministic code generation on inference error\n      }\n    }\n\n    // 2. Deterministic Code Synthesis",
    '''      } catch (error) {
        const allowFallback = options.allowDeterministicFallback ?? false;
        if (!allowFallback) {
          throw error;
        }
      }
    } else if (options.allowDeterministicFallback === false) {
      throw new Error("Structured inference is required for candidate synthesis");
    }

    // 2. Deterministic Code Synthesis''',
)

candidate_service = "apps/cloud/src/evolution/generator/service.ts"
replace_once(
    candidate_service,
    "  candidateRepo?: CandidateRepository;\n}",
    "  candidateRepo?: CandidateRepository;\n  allowDeterministicFallback?: boolean;\n}",
)
replace_once(
    candidate_service,
    "  private readonly candidateRepo?: CandidateRepository;\n",
    "  private readonly candidateRepo?: CandidateRepository;\n  private readonly allowDeterministicFallback: boolean;\n",
)
replace_once(
    candidate_service,
    "    this.inferenceService = options.inferenceService;\n",
    "    this.inferenceService = options.inferenceService;\n    this.allowDeterministicFallback = options.allowDeterministicFallback ?? true;\n",
)
replace_once(
    candidate_service,
    "      workflowEvidence: opportunity.classification.description,\n    });",
    "      workflowEvidence: opportunity.classification.description,\n      allowDeterministicFallback: this.allowDeterministicFallback,\n    });",
)

# Artifact publication is immutable but inactive until rollout promotion.
artifact_service = "apps/cloud/src/evolution/artifacts/service.ts"
replace_once(
    artifact_service,
    "  readonly versioning: SemanticVersionClassifier;\n",
    "  readonly versioning: SemanticVersionClassifier;\n  private readonly allowEphemeralSigningKey: boolean;\n",
)
replace_once(
    artifact_service,
    "      outboxPublisher?: OutboxPublisher;\n    } = {},",
    "      outboxPublisher?: OutboxPublisher;\n      allowEphemeralSigningKey?: boolean;\n    } = {},",
)
replace_once(
    artifact_service,
    "    this.versioning = options.versioning ?? new SemanticVersionClassifier();\n",
    "    this.versioning = options.versioning ?? new SemanticVersionClassifier();\n    this.allowEphemeralSigningKey = options.allowEphemeralSigningKey ?? false;\n",
)
replace_once(
    artifact_service,
    '''        if (!signingKey) {
          // Initialize active key if none exists in store
          signingKey = this.signer.generateKeyPair(signingAlgorithm, "production");
          await this.signingKeyRepo.saveKey(signingKey);
        }''',
    '''        if (!signingKey) {
          if (!this.allowEphemeralSigningKey) {
            throw new Error(
              "No active artifact signing key is provisioned; publication is fail-closed",
            );
          }
          signingKey = this.signer.generateKeyPair(signingAlgorithm, "development");
          await this.signingKeyRepo.saveKey(signingKey);
        }''',
)
replace_once(
    artifact_service,
    '        synthesizerModel: options.synthesizerModel ?? "claude-3-7-sonnet",',
    '        synthesizerModel: options.synthesizerModel ?? options.revision?.modelId ?? "unknown",',
)
replace_once(
    artifact_service,
    '          runtime: "node",',
    '          runtime: "deno",',
)
replace_once(
    artifact_service,
    '        status: "active",',
    '        status: "draft",',
)
regex_once(
    artifact_service,
    r'''        // Save logical tool\n        await this\.toolRegistryRepo\.saveTool\([\s\S]*?        // Save immutable ToolVersion\n        await this\.toolRegistryRepo\.saveToolVersion\(tenant, toolVersion, txClient\);\n\n        // Update aliases\n        await this\.toolRegistryRepo\.setAlias\([\s\S]*?        await this\.toolRegistryRepo\.setAlias\(\n          tenant,\n          candidate\.proposedTool\.id,\n          "active",\n          targetVersion,\n          txClient,\n        \);''',
    '''        // Save the logical tool without changing the active version. Promotion owns that transition.
        await this.toolRegistryRepo.saveTool(
          tenant,
          {
            id: candidate.proposedTool.id,
            name: candidate.proposedTool.name,
            description: candidate.proposedTool.description,
            activeVersion: priorActiveVersion?.version,
          },
          txClient,
        );

        // Save immutable draft version and expose only the latest alias.
        await this.toolRegistryRepo.saveToolVersion(tenant, toolVersion, txClient);
        await this.toolRegistryRepo.setAlias(
          tenant,
          candidate.proposedTool.id,
          "latest",
          targetVersion,
          txClient,
        );''',
)
replace_once(
    artifact_service,
    "    outboxPublisher?: OutboxPublisher;\n  },",
    "    outboxPublisher?: OutboxPublisher;\n    allowEphemeralSigningKey?: boolean;\n  },",
)

# Remove draft catalog registration from lifecycle publication.
lifecycle = "apps/cloud/src/evolution/lifecycle/orchestrator.ts"
regex_once(
    lifecycle,
    r'''      // 6\. Register in CloudCatalogService\n      if \(this\.catalogService\) \{[\s\S]*?      \}\n\n      const publicationRecordId''',
    "      const publicationRecordId",
)

# CloudService: configured provider, authoritative lifecycle, ID-only workers/routes.
index = "apps/cloud/src/index.ts"
replace_once(index, 'import crypto from "node:crypto";\n', "")
replace_once(
    index,
    'import { type InferenceService, createInferenceService } from "./models/index.js";',
    '''import {
  type InferenceService,
  OpenAiCompatibleProvider,
  createInferenceService,
} from "./models/index.js";''',
)
replace_once(
    index,
    '''import {
  type OpportunityDetectionService,
  createOpportunityDetectionService,
} from "./evolution/opportunity/index.js";''',
    '''import {
  type CandidateLifecycleOrchestrator,
  createCandidateLifecycleOrchestrator,
} from "./evolution/lifecycle/index.js";
import {
  type OpportunityDetectionService,
  createOpportunityDetectionService,
} from "./evolution/opportunity/index.js";''',
)
replace_once(
    index,
    "  readonly candidateValidationService: CandidateValidationService;\n",
    "  readonly candidateValidationService: CandidateValidationService;\n  readonly candidateLifecycleOrchestrator: CandidateLifecycleOrchestrator;\n",
)
replace_once(
    index,
    "    this.inferenceService = createInferenceService();\n",
    '''    this.inferenceService = createInferenceService();
    if (this.config.models.provider === "openai-compatible") {
      if (!this.config.models.baseUrl) {
        throw new Error("MODEL_BASE_URL is required for the openai-compatible provider");
      }
      this.inferenceService.router.registerProvider(
        new OpenAiCompatibleProvider({
          id: this.config.models.providerId,
          name: `OpenAI-compatible (${this.config.models.providerId})`,
          baseUrl: this.config.models.baseUrl,
          apiKey: this.config.models.apiKey,
          organizationId: this.config.models.organizationId,
          defaultModel: this.config.models.model,
          timeoutMs: this.config.models.timeoutMs,
        }),
      );
    }
''',
)
replace_once(
    index,
    "      candidateRepo: this.candidateRepo,\n    });",
    "      candidateRepo: this.candidateRepo,\n      allowDeterministicFallback: this.config.models.allowDeterministicFallback,\n    });",
)
replace_once(
    index,
    "      { outboxPublisher: this.outboxPublisher },\n    );",
    '''      {
        outboxPublisher: this.outboxPublisher,
        allowEphemeralSigningKey:
          this.config.environment === "development" || this.config.environment === "test",
      },
    );''',
)
replace_once(
    index,
    "    this.candidateEvaluationService = createCandidateEvaluationService();\n",
    '''    this.candidateEvaluationService = createCandidateEvaluationService();
    this.candidateLifecycleOrchestrator = createCandidateLifecycleOrchestrator(this.dbPool, {
      validationService: this.candidateValidationService,
      replayService: this.historicalReplayService,
      evaluationService: this.candidateEvaluationService,
      artifactService: this.artifactRegistryService,
      catalogService: this.catalogService,
      candidateRepo: this.candidateRepo,
      outboxPublisher: this.outboxPublisher,
      queue: this.queue,
      objectStore: this.objectStore,
    });
''',
)

regex_once(
    index,
    r'''    this\.worker\.registerHandler\("candidate\.generate", async \(job\) => \{[\s\S]*?    \}\);\n\n    this\.worker\.registerHandler\("store-observation-batch"''',
    '''    this.worker.registerHandler("candidate.generate", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as
        | { opportunityId?: string; options?: Record<string, unknown> }
        | undefined;
      if (!payload?.opportunityId) {
        throw new Error("candidate.generate requires opportunityId");
      }
      const opportunity = await this.opportunityService.getOpportunityById(
        tenant,
        payload.opportunityId,
      );
      if (!opportunity || opportunity.status !== "eligible") {
        throw new Error(`Eligible opportunity '${payload.opportunityId}' was not found`);
      }
      const generated = await this.candidateGenerationService.generateCandidate(
        tenant,
        opportunity,
        payload.options,
      );
      await this.candidateLifecycleOrchestrator.startLifecycle(
        tenant,
        generated.candidate,
        generated.activeRevision,
      );
    });

    this.worker.registerHandler("store-observation-batch"''',
)
regex_once(
    index,
    r'''    this\.worker\.registerHandler\("candidate\.validate", async \(job\) => \{[\s\S]*?    this\.worker\.registerHandler\("rollout\.create"''',
    '''    this.worker.registerHandler("candidate.validate", async (job) => {
      const payload = job.payload as { candidateId?: string } | undefined;
      if (!payload?.candidateId) throw new Error("candidate.validate requires candidateId");
      await this.candidateLifecycleOrchestrator.stepValidate(
        job.tenantContext,
        payload.candidateId,
      );
    });

    this.worker.registerHandler("candidate.replay", async (job) => {
      const payload = job.payload as { candidateId?: string } | undefined;
      if (!payload?.candidateId) throw new Error("candidate.replay requires candidateId");
      await this.candidateLifecycleOrchestrator.stepReplay(
        job.tenantContext,
        payload.candidateId,
      );
    });

    this.worker.registerHandler("candidate.evaluate", async (job) => {
      const payload = job.payload as { candidateId?: string } | undefined;
      if (!payload?.candidateId) throw new Error("candidate.evaluate requires candidateId");
      await this.candidateLifecycleOrchestrator.stepEvaluate(
        job.tenantContext,
        payload.candidateId,
      );
    });

    this.worker.registerHandler("candidate.publish", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as { candidateId?: string } | undefined;
      if (!payload?.candidateId) throw new Error("candidate.publish requires candidateId");
      const { toolVersion } = await this.candidateLifecycleOrchestrator.stepPublish(
        tenant,
        payload.candidateId,
      );
      await this.rolloutController.createRolloutForPublishedVersion(tenant, {
        toolId: toolVersion.toolId,
        version: toolVersion.version,
        artifactDigest: toolVersion.artifactDigest,
        manifestDigest: toolVersion.manifestDigest,
      });
    });

    this.worker.registerHandler("rollout.create"''',
)

regex_once(
    index,
    r'''        if \(path === "/v1/evolution/opportunity/detect" && req\.method === "POST"\) \{[\s\S]*?        if \(path === "/v1/evolution/candidates/generate"''',
    '''        if (path === "/v1/evolution/opportunity/detect" && req.method === "POST") {
          const events = (parsedObj.events as NormalizedSessionEvent[] | undefined) ?? [];
          const result = await this.opportunityService.processSessionEvents(tenant, events);
          sendJson(res, 200, { opportunities: result.opportunities }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/generate"''',
)
regex_once(
    index,
    r'''        if \(path === "/v1/evolution/candidates/generate" && req\.method === "POST"\) \{[\s\S]*?        if \(path === "/v1/evolution/candidates/validate"''',
    '''        if (path === "/v1/evolution/candidates/generate" && req.method === "POST") {
          const submittedOpportunity = parsedObj.opportunity as { id?: string } | undefined;
          const opportunityId =
            (parsedObj.opportunityId as string | undefined) ?? submittedOpportunity?.id;
          if (!opportunityId) {
            sendJson(res, 400, { error: "opportunityId is required" }, headers);
            return true;
          }
          const opportunity = await this.opportunityService.getOpportunityById(tenant, opportunityId);
          if (!opportunity) {
            sendJson(res, 404, { error: "Opportunity not found" }, headers);
            return true;
          }
          if (opportunity.status !== "eligible") {
            sendJson(res, 409, { error: `Opportunity is ${opportunity.status}` }, headers);
            return true;
          }
          const generated = await this.candidateGenerationService.generateCandidate(
            tenant,
            opportunity,
            parsedObj.options as Record<string, unknown> | undefined,
          );
          const lifecycle = await this.candidateLifecycleOrchestrator.startLifecycle(
            tenant,
            generated.candidate,
            generated.activeRevision,
          );
          sendJson(
            res,
            202,
            { candidate: generated.candidate, candidateId: generated.candidate.id, lifecycle },
            headers,
          );
          return true;
        }

        if (path === "/v1/evolution/candidates/validate"''',
)
regex_once(
    index,
    r'''        if \(path === "/v1/evolution/candidates/validate" && req\.method === "POST"\) \{[\s\S]*?        if \(path === "/v1/evolution/candidates/replay"''',
    '''        if (path === "/v1/evolution/candidates/validate" && req.method === "POST") {
          const candidateId =
            (parsedObj.candidateId as string | undefined) ??
            (parsedObj.candidate as { id?: string } | undefined)?.id;
          if (!candidateId) {
            sendJson(res, 400, { error: "candidateId is required" }, headers);
            return true;
          }
          const lifecycle = await this.candidateLifecycleOrchestrator.stepValidate(
            tenant,
            candidateId,
          );
          sendJson(res, 200, { lifecycle }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/replay"''',
)
regex_once(
    index,
    r'''        if \(path === "/v1/evolution/candidates/replay" && req\.method === "POST"\) \{[\s\S]*?        if \(path === "/v1/evolution/candidates/evaluate"''',
    '''        if (path === "/v1/evolution/candidates/replay" && req.method === "POST") {
          const candidateId =
            (parsedObj.candidateId as string | undefined) ??
            (parsedObj.candidate as { id?: string } | undefined)?.id;
          if (!candidateId) {
            sendJson(res, 400, { error: "candidateId is required" }, headers);
            return true;
          }
          const lifecycle = await this.candidateLifecycleOrchestrator.stepReplay(
            tenant,
            candidateId,
          );
          sendJson(res, 200, { lifecycle }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/evaluate"''',
)
regex_once(
    index,
    r'''        if \(path === "/v1/evolution/candidates/evaluate" && req\.method === "POST"\) \{[\s\S]*?        if \(path === "/v1/evolution/candidates/publish"''',
    '''        if (path === "/v1/evolution/candidates/evaluate" && req.method === "POST") {
          const candidateId =
            (parsedObj.candidateId as string | undefined) ??
            (parsedObj.candidate as { id?: string } | undefined)?.id;
          if (!candidateId) {
            sendJson(res, 400, { error: "candidateId is required" }, headers);
            return true;
          }
          const lifecycle = await this.candidateLifecycleOrchestrator.stepEvaluate(
            tenant,
            candidateId,
          );
          sendJson(res, 200, { lifecycle }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/publish"''',
)
regex_once(
    index,
    r'''        if \(path === "/v1/evolution/candidates/publish" && req\.method === "POST"\) \{[\s\S]*?        if \(path === "/v1/evolution/rollout/promote"''',
    '''        if (path === "/v1/evolution/candidates/publish" && req.method === "POST") {
          const candidateId =
            (parsedObj.candidateId as string | undefined) ??
            (parsedObj.candidate as { id?: string } | undefined)?.id;
          if (!candidateId) {
            sendJson(res, 400, { error: "candidateId is required" }, headers);
            return true;
          }
          const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
          if (!candidate) {
            sendJson(res, 404, { error: "Candidate not found" }, headers);
            return true;
          }
          const revision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
          const { record, toolVersion } = await this.candidateLifecycleOrchestrator.driveToCompletion(
            tenant,
            candidate,
            revision,
          );
          const rollout = await this.rolloutController.createRolloutForPublishedVersion(tenant, {
            toolId: toolVersion.toolId,
            version: toolVersion.version,
            artifactDigest: toolVersion.artifactDigest,
            manifestDigest: toolVersion.manifestDigest,
          });
          sendJson(
            res,
            202,
            {
              published: true,
              candidateId,
              bundleDigest: toolVersion.artifactDigest,
              toolName: toolVersion.manifest.name,
              version: toolVersion.version,
              lifecycle: record,
              rolloutId: rollout.id,
              state: rollout.state,
            },
            headers,
          );
          return true;
        }

        if (path === "/v1/evolution/rollout/promote"''',
)
regex_once(
    index,
    r'''        if \(path === "/v1/evolution/rollout/promote" && req\.method === "POST"\) \{[\s\S]*?        if \(path === "/v1/evolution/rollout/rollback"''',
    '''        if (path === "/v1/evolution/rollout/promote" && req.method === "POST") {
          const rolloutId = parsedObj.rolloutId as string | undefined;
          if (!rolloutId) {
            sendJson(res, 400, { error: "rolloutId is required" }, headers);
            return true;
          }
          const result = await this.rolloutController.executeManualPromotion(
            tenant,
            rolloutId,
            (parsedObj.reason as string | undefined) ?? "Manual promotion",
          );
          sendJson(res, 200, { result }, headers);
          return true;
        }

        if (path === "/v1/evolution/rollout/rollback"''',
)

server_api = "apps/cloud/src/server/api.ts"
replace_once(
    server_api,
    "    if (this.customRouteHandler) {\n",
    '''    if (this.customRouteHandler) {
      if (path.startsWith("/v1/evolution/")) {
        assertRequestScope(
          authContext,
          path === "/v1/evolution/catalog" && req.method === "GET"
            ? "catalog:read"
            : "deployments:write",
        );
      }
''',
)

write(
    "apps/cloud/src/bin/worker.ts",
    '''#!/usr/bin/env node
import process from "node:process";
import { createCloudService } from "../index.js";

async function main(): Promise<void> {
  const service = createCloudService();
  await service.initialize();

  console.log("[Worker] Durable cloud worker and scheduler started");

  const shutdown = async () => {
    console.log("[Worker] Shutting down gracefully...");
    await service.shutdown();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1]?.endsWith("worker.js") || process.argv[1]?.endsWith("worker.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
''',
)

write(
    "apps/cloud/tests/models/production-provider-config.test.ts",
    '''import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("production model configuration", () => {
  it("requires a configured provider and disables deterministic fallback", () => {
    expect(() =>
      loadConfig({
        environment: "production",
        database: {
          url: "postgres://app:strong-password@db.example.com:5432/tool_evolver",
          host: "db.example.com",
          port: 5432,
          database: "tool_evolver",
          user: "app",
          password: "strong-password",
          ssl: true,
          maxConnections: 20,
          idleTimeoutMs: 30000,
          connectionTimeoutMs: 5000,
        },
        storage: {
          provider: "s3",
          bucket: "artifacts",
          region: "us-east-1",
          accessKeyId: "key",
          secretAccessKey: "secret",
          forcePathStyle: false,
        },
        queue: {
          provider: "postgres",
          concurrency: 10,
          pollIntervalMs: 1000,
          visibilityTimeoutMs: 30000,
          maxAttempts: 3,
          deadLetterThreshold: 3,
          backoffBaseMs: 1000,
        },
        auth: {
          jwtSecret: "production-jwt-secret-32-characters",
          deviceTokenSecret: "production-device-secret-32-chars",
          issuer: "tool-evolver",
          audience: "tool-evolver-client",
          tokenTtlSeconds: 3600,
          allowDevAuth: false,
        },
        models: {
          provider: "disabled",
          providerId: "primary",
          model: "model",
          timeoutMs: 30000,
          allowDeterministicFallback: true,
        },
        server: {
          host: "0.0.0.0",
          port: 8080,
          logLevel: "info",
          bodyLimitBytes: 1048576,
          requestTimeoutMs: 30000,
          corsOrigins: ["https://app.example.com"],
        },
      }),
    ).toThrow(/structured inference provider is disabled/);
  });
});
''',
)
write(
    "apps/cloud/tests/evolution/lifecycle/authoritative-publication.test.ts",
    '''import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("authoritative lifecycle composition", () => {
  it("standalone worker uses the shared CloudService composition root", async () => {
    const source = await readFile(new URL("../../../src/bin/worker.ts", import.meta.url), "utf8");
    expect(source).toContain("createCloudService");
    expect(source).not.toContain("Processing observation for tenant");
    expect(source).not.toContain("Running evaluation for tenant");
  });

  it("public publication no longer accepts caller bundle source", async () => {
    const source = await readFile(new URL("../../../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("parsedObj.bundleCode");
    expect(source).toContain("candidateLifecycleOrchestrator.driveToCompletion");
  });
});
''',
)

print("lifecycle hardening patch applied")
