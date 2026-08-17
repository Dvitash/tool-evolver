import { randomUUID } from "node:crypto";
import { CapabilityEnvelope } from "@tool-evolver/contracts";
import { OpportunityDetection } from "../../../src/evolution/opportunity/types.js";
import { TenantContext } from "../../../src/tenant.js";

export function createMockTenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    accountId: overrides.accountId ?? "acct-test-123",
    workspaceId: overrides.workspaceId ?? "ws-test-456",
    userId: overrides.userId ?? "user-test-789",
    roles: overrides.roles ?? ["developer"],
    ...overrides,
  };
}

export function createMockOpportunity(overrides: Partial<OpportunityDetection> = {}): OpportunityDetection {
  const id = overrides.id ?? `opp-${randomUUID().slice(0, 8)}`;
  return {
    id,
    accountId: overrides.accountId ?? "acct-test-123",
    workspaceId: overrides.workspaceId ?? "ws-test-456",
    clusterId: overrides.clusterId ?? `cluster-${randomUUID().slice(0, 8)}`,
    structuralHash: overrides.structuralHash ?? "hash-abc123def456",
    status: overrides.status ?? "eligible",
    triggerType: overrides.triggerType ?? "normal_frequency",
    triggerReason: overrides.triggerReason ?? "repeated_pattern",
    occurrenceCount: overrides.occurrenceCount ?? 3,
    distinctSessionCount: overrides.distinctSessionCount ?? 2,
    evidenceEventIds: overrides.evidenceEventIds ?? [randomUUID(), randomUUID()],
    coverage: overrides.coverage ?? {
      status: "net_new",
      similarityScore: 0.1,
      overlapRatio: 0.1,
      reason: "Net-new workflow",
    },
    suppression: overrides.suppression ?? {
      suppressed: false,
      reason: "none",
      details: "",
    },
    classification: {
      title: "Batch Format and Verify Files",
      description: "Automatically formats changed files and executes test runner",
      taskClass: "multi_step",
      pattern: "file_read -> file_edit -> command",
      confidenceScore: 0.92,
      priority: "high",
      suggestedToolName: "batch_format_and_verify",
      inferredInputs: [
        {
          name: "path",
          type: "string",
          description: "Target directory path to inspect and format",
        },
        {
          name: "fix",
          type: "boolean",
          description: "Whether to apply fixes automatically",
        },
      ],
      candidateOutputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          filesFormatted: { type: "number" },
          testPassed: { type: "boolean" },
        },
      },
      ...overrides.classification,
    },
    metrics: {
      avgTokens: 500,
      avgDurationMs: 1200,
      totalTokens: 1500,
      totalRetries: 0,
      totalCostUsd: 0.05,
      ...overrides.metrics,
    },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

export function createMockEnvelope(overrides: Partial<CapabilityEnvelope> = {}): CapabilityEnvelope {
  return {
    envelopeId: overrides.envelopeId ?? `env-${randomUUID().slice(0, 8)}`,
    workspaceId: overrides.workspaceId ?? "ws-test-456",
    version: overrides.version ?? "1.0.0",
    fs: {
      readPaths: ["."],
      writePaths: ["."],
      allowWorkspaceRoot: true,
      allowTemp: true,
      denyPaths: [".env", ".git/secrets"],
      maxFileSizeBytes: 10485760,
      ...overrides.fs,
    },
    net: {
      allowOutbound: true,
      allowedDomains: ["api.example.com", "registry.npmjs.org"],
      allowedHosts: ["api.example.com", "registry.npmjs.org"],
      allowedPorts: [443, 80],
      allowedProtocols: ["https"],
      allowLocalhost: false,
      denyPrivateRanges: true,
      ...overrides.net,
    },
    command: {
      allowShellExecution: false,
      allowedCommands: ["git status", "pnpm test", "npm run build"],
      allowedBinaries: ["git", "pnpm", "npm", "node"],
      forbiddenPatterns: ["rm -rf /", "mkfs", "> /dev/"],
      allowEnvPassthrough: ["PATH", "NODE_ENV"],
      ...overrides.command,
    },
    secrets: {
      allowedSecretNames: ["API_KEY", "NPM_TOKEN"],
      allowedPrefixes: ["APP_"],
      denyDirectRead: true,
      injectAsEnv: true,
      ...overrides.secrets,
    },
    limits: {
      maxConcurrentExecutions: 4,
      maxCpuUsagePercent: 100,
      maxMemoryMb: 256,
      maxExecutionTimeMs: 60000,
      maxOutputSizeBytes: 2097152,
      ...overrides.limits,
    },
    isFrozen: overrides.isFrozen ?? false,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}
