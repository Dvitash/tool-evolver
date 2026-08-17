import { randomUUID } from "node:crypto";
import {
  type EvolutionCandidate,
  type ToolManifest,
  type ToolVersion,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import { MemoryDatabasePool } from "../../../src/db/client.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { OutboxPublisher } from "../../../src/db/outbox.js";
import { ArtifactBuilder } from "../../../src/evolution/artifacts/builder.js";
import {
  SigningKeyRepository,
  ToolRegistryRepository,
} from "../../../src/evolution/artifacts/repositories/index.js";
import { ToolArtifactRegistryService } from "../../../src/evolution/artifacts/service.js";
import { ArtifactSigner } from "../../../src/evolution/artifacts/signer.js";
import { SemanticVersionClassifier } from "../../../src/evolution/artifacts/versioning.js";
import { RolloutAssignmentRouter } from "../../../src/evolution/rollout/assignment.js";
import {
  type CreateRolloutParams,
  RolloutController,
} from "../../../src/evolution/rollout/controller.js";
import { RolloutEvaluator } from "../../../src/evolution/rollout/evaluator.js";
import { RolloutPolicyRegistry } from "../../../src/evolution/rollout/policy.js";
import { RolloutRepository } from "../../../src/evolution/rollout/repositories/rollout-repository.js";
import type { RolloutEntity, RolloutTelemetryEvent } from "../../../src/evolution/rollout/types.js";
import { CloudCatalogService } from "../../../src/mcp/catalog-service.js";
import { MemoryObjectStore } from "../../../src/storage/object-store.js";
import type { TenantContext } from "../../../src/tenant.js";

export const TEST_WORKSPACE_ID = "ws_rollout_test_001";
export const TEST_ACCOUNT_ID = "acc_rollout_test_001";

export const TEST_TENANT: TenantContext = {
  accountId: TEST_ACCOUNT_ID,
  workspaceId: TEST_WORKSPACE_ID,
  roles: ["admin", "developer"],
};

export interface TestRolloutEnvironment {
  pool: MemoryDatabasePool;
  toolRegistryRepo: ToolRegistryRepository;
  signingKeyRepo: SigningKeyRepository;
  artifactService: ToolArtifactRegistryService;
  catalogService: CloudCatalogService;
  rolloutRepo: RolloutRepository;
  policyRegistry: RolloutPolicyRegistry;
  evaluator: RolloutEvaluator;
  assignmentRouter: RolloutAssignmentRouter;
  controller: RolloutController;
  outboxPublisher: OutboxPublisher;
}

/**
 * Creates a fully initialized in-memory test rollout environment.
 */
export async function createTestRolloutEnvironment(): Promise<TestRolloutEnvironment> {
  const pool = new MemoryDatabasePool();
  await runMigrations(pool);

  const outboxPublisher = new OutboxPublisher(pool);
  const toolRegistryRepo = new ToolRegistryRepository(pool);
  const signingKeyRepo = new SigningKeyRepository(pool);
  const objectStore = new MemoryObjectStore();

  const artifactService = new ToolArtifactRegistryService(pool, objectStore, {
    toolRegistryRepo,
    signingKeyRepo,
    builder: new ArtifactBuilder(),
    signer: new ArtifactSigner(),
    versioning: new SemanticVersionClassifier(),
    outboxPublisher,
  });

  const catalogService = new CloudCatalogService({
    dbPool: pool,
    toolRegistryRepo,
    outboxPublisher,
  });

  const rolloutRepo = new RolloutRepository(pool);
  const policyRegistry = new RolloutPolicyRegistry();
  const evaluator = new RolloutEvaluator();
  const assignmentRouter = new RolloutAssignmentRouter(rolloutRepo);

  const controller = new RolloutController(pool, {
    toolRegistryRepo,
    rolloutRepo,
    policyRegistry,
    evaluator,
    assignmentRouter,
    outboxPublisher,
    catalogService,
  });

  return {
    pool,
    toolRegistryRepo,
    signingKeyRepo,
    artifactService,
    catalogService,
    rolloutRepo,
    policyRegistry,
    evaluator,
    assignmentRouter,
    controller,
    outboxPublisher,
  };
}

/**
 * Creates a mock ToolManifest.
 */
export function createMockToolManifest(
  id = "csv_parser",
  version = "1.0.0",
  overrides?: Partial<ToolManifest>,
): ToolManifest {
  const base = {
    id,
    version,
    name: `Test Tool ${id}`,
    description: "Robust CSV Parser and transformer",
    parameters: {
      type: "object" as const,
      properties: {
        delimiter: { type: "string", default: "," },
        skipHeader: { type: "boolean", default: true },
      },
      required: ["delimiter"],
    },
    returns: {
      type: "object" as const,
      properties: {
        rowCount: { type: "number" },
        records: { type: "array" },
      },
    },
    capabilities: [
      {
        type: "filesystem",
        actions: ["read"],
        resources: ["/workspace/data/*"],
      },
    ],
    ...overrides,
  };

  const digest = hashCanonicalContent(base, { prefix: false });
  return {
    ...base,
    digest,
  };
}

/**
 * Creates a mock CreateRolloutParams object.
 */
export function createMockRolloutParams(
  toolId = "csv_parser",
  version = "1.1.0",
  overrides?: Partial<CreateRolloutParams>,
): CreateRolloutParams {
  return {
    toolId,
    version,
    artifactDigest: `art_${randomUUID().replace(/-/g, "")}`,
    manifestDigest: `mnf_${randomUUID().replace(/-/g, "")}`,
    riskTier: "tier1_low",
    previousVersion: "1.0.0",
    canaryTrafficPercentage: 10,
    ...overrides,
  };
}

/**
 * Creates a batch of mock telemetry events for testing evaluator and controller.
 */
export function createMockTelemetryBatch(
  workspaceId: string,
  toolId: string,
  version: string,
  count: number,
  options: {
    failureCount?: number;
    baseDurationMs?: number;
    latencySpike?: boolean;
    securityViolation?: boolean;
    quarantineSignal?: boolean;
    capabilityBreach?: boolean;
    signatureValid?: boolean;
  } = {},
): RolloutTelemetryEvent[] {
  const events: RolloutTelemetryEvent[] = [];
  const failureCount = options.failureCount ?? 0;
  const baseDuration = options.baseDurationMs ?? 50;

  for (let i = 0; i < count; i++) {
    const isFailure = i < failureCount;
    const duration = options.latencySpike ? baseDuration + i * 200 : baseDuration + (i % 10) * 5;

    events.push({
      id: randomUUID(),
      workspaceId,
      sessionId: `sess_${i % 5}`,
      deviceId: `dev_${i % 2}`,
      toolId,
      version,
      success: !isFailure,
      durationMs: duration,
      errorCode: isFailure ? "PARSING_ERROR" : undefined,
      errorMessage: isFailure ? "Invalid CSV format" : undefined,
      securityViolation: Boolean(options.securityViolation && i === 0),
      securityViolationReason: options.securityViolation
        ? "Attempted path traversal to /etc/shadow"
        : undefined,
      quarantineSignal: Boolean(options.quarantineSignal && i === 0),
      quarantineReason: options.quarantineSignal ? "signature_mismatch" : undefined,
      capabilityBreach: Boolean(options.capabilityBreach && i === 0),
      signatureValid: options.signatureValid ?? true,
      timestamp: new Date().toISOString(),
    });
  }

  return events;
}
