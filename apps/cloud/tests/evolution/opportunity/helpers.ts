import { type DatabasePool, MemoryDatabasePool, OutboxPublisher } from "../../../src/db/index.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  type OpportunityDetectionService,
  OpportunityRepository,
  createOpportunityDetectionService,
} from "../../../src/evolution/opportunity/index.js";
import type { OpportunityDetection } from "../../../src/evolution/opportunity/types.js";
import type { TenantContext } from "../../../src/tenant.js";

export const TEST_WORKSPACE_ID = "ws_opp_test_001";
export const TEST_ACCOUNT_ID = "acc_opp_test_001";

export const TEST_TENANT: TenantContext = {
  accountId: TEST_ACCOUNT_ID,
  workspaceId: TEST_WORKSPACE_ID,
};

export interface TestOpportunityEnvironment {
  pool: DatabasePool;
  repository: OpportunityRepository;
  service: OpportunityDetectionService;
  outboxPublisher: OutboxPublisher;
}

/**
 * Creates a fully initialized in-memory database and opportunity test environment.
 */
export async function createTestOpportunityEnvironment(): Promise<TestOpportunityEnvironment> {
  const pool = new MemoryDatabasePool();
  await runMigrations(pool);

  // Create default account and workspace for foreign key integrity
  await pool.query(
    `INSERT INTO accounts (id, name, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
    [
      TEST_ACCOUNT_ID,
      "Test Account",
      "standard",
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
  await pool.query(
    `INSERT INTO workspaces (id, account_id, name, slug, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      TEST_WORKSPACE_ID,
      TEST_ACCOUNT_ID,
      "Test Workspace",
      "test-ws",
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  const repository = new OpportunityRepository(pool);
  const service = createOpportunityDetectionService({ pool, repository });
  const outboxPublisher = new OutboxPublisher(pool);

  return {
    pool,
    repository,
    service,
    outboxPublisher,
  };
}

/**
 * Creates a mock OpportunityDetection entity.
 */
export function createMockOpportunity(
  overrides: Partial<OpportunityDetection> = {},
): OpportunityDetection {
  const id = overrides.id ?? "opp_mock_001";
  const structuralHash = overrides.structuralHash ?? "sha256_mock_struct_hash_001";
  const idempotencyKey = overrides.idempotencyKey ?? `opp_ik_${structuralHash}`;
  const now = new Date().toISOString();

  return {
    id,
    accountId: overrides.accountId ?? TEST_ACCOUNT_ID,
    workspaceId: overrides.workspaceId ?? TEST_WORKSPACE_ID,
    clusterId: overrides.clusterId ?? "cluster_test_001",
    structuralHash,
    idempotencyKey,
    status: overrides.status ?? "eligible",
    triggerType: overrides.triggerType ?? "normal_frequency",
    triggerReason: overrides.triggerReason ?? "frequency_threshold_met",
    occurrenceCount: overrides.occurrenceCount ?? 3,
    distinctSessionCount: overrides.distinctSessionCount ?? 2,
    evidenceEventIds: overrides.evidenceEventIds ?? ["evt_1", "evt_2", "evt_3"],
    coverage: overrides.coverage ?? {
      status: "eligible",
      reason: "No covering tool detected",
    },
    suppression: overrides.suppression ?? {
      suppressed: false,
      reason: "none",
      details: "",
    },
    classification: overrides.classification ?? {
      title: "Batch CSV Converter",
      description: "Converts multiple CSV files to JSON",
      taskClass: "data_transform",
      pattern: "file_read -> data_transform -> file_write",
      confidenceScore: 0.95,
      priority: "high",
      suggestedToolName: "batch_csv_converter",
      provenance: { model: "claude-3-7-sonnet" },
    },
    metrics: overrides.metrics ?? {
      totalDurationMs: 4500,
      avgDurationMs: 1500,
      totalTokens: 1200,
      totalRetries: 0,
      totalCostUsd: 0.0036,
    },
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

import {
  type NormalizedCommandExecEvent,
  type NormalizedErrorEvent,
  type NormalizedFileEditEvent,
  type NormalizedMessageEvent,
  NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
} from "@tool-evolver/contracts";

export function createMessageEvent(options: {
  eventId: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  causalSequence?: number;
}): NormalizedMessageEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "message",
    role: options.role,
    content: options.content,
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 1,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createToolCallEvent(options: {
  eventId: string;
  sessionId: string;
  toolName: string;
  parameters?: Record<string, unknown>;
  timestamp?: string;
  causalSequence?: number;
}): NormalizedToolCallEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "tool_call",
    toolName: options.toolName,
    parameters: options.parameters ?? {},
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 2,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createToolResultEvent(options: {
  eventId: string;
  sessionId: string;
  toolCallId: string;
  result: unknown;
  isError?: boolean;
  timestamp?: string;
  durationMs?: number;
  causalSequence?: number;
}): NormalizedToolResultEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "tool_result",
    toolCallId: options.toolCallId,
    result: options.result,
    isError: options.isError ?? false,
    durationMs: options.durationMs ?? 100,
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 3,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createCommandExecEvent(options: {
  eventId: string;
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  timestamp?: string;
  causalSequence?: number;
}): NormalizedCommandExecEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "command_exec",
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd,
    exitCode: options.exitCode ?? 0,
    durationMs: options.durationMs ?? 200,
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 4,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createFileEditEvent(options: {
  eventId: string;
  sessionId: string;
  filePath: string;
  operation?: "create" | "update" | "delete" | "patch";
  timestamp?: string;
  causalSequence?: number;
}): NormalizedFileEditEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "file_edit",
    filePath: options.filePath,
    operation: options.operation ?? "update",
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 5,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createErrorEvent(options: {
  eventId: string;
  sessionId: string;
  message: string;
  code?: string;
  isFatal?: boolean;
  timestamp?: string;
  causalSequence?: number;
}): NormalizedErrorEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "error",
    message: options.message,
    code: options.code ?? "EXEC_ERROR",
    isFatal: options.isFatal ?? false,
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 6,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}
