import { randomUUID } from "node:crypto";
import type { CapabilityEnvelope } from "@tool-evolver/contracts";
import type { OpportunityDetection } from "../../../src/evolution/opportunity/types.js";
import type { TenantContext } from "../../../src/tenant.js";

interface LegacyCapabilityOverrides {
  fs?: Partial<CapabilityEnvelope["fs"]>;
  net?: Partial<CapabilityEnvelope["net"]> & {
    denyHosts?: string[];
    allowInsecure?: boolean;
    maxResponseBodyBytes?: number;
  };
  command?: Partial<CapabilityEnvelope["command"]> & {
    environmentVariables?: Record<string, string>;
    denyCommands?: string[];
  };
  secret?: {
    allowedSecretNames?: string[];
    allowedKeyPrefixes?: string[];
    denyKeyPrefixes?: string[];
    denyDirectRead?: boolean;
    injectAsEnv?: boolean;
  };
  secrets?: Partial<CapabilityEnvelope["secrets"]>;
  limits?: Partial<CapabilityEnvelope["limits"]>;
}

type MockEnvelopeOverrides = Partial<CapabilityEnvelope> & {
  capabilities?: LegacyCapabilityOverrides;
};

export function createMockTenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    accountId: overrides.accountId ?? "acct-test-123",
    workspaceId: overrides.workspaceId ?? "ws-test-456",
    userId: overrides.userId ?? "user-test-789",
    roles: overrides.roles ?? ["developer"],
    ...overrides,
  };
}

export function createMockOpportunity(
  overrides: Partial<OpportunityDetection> = {},
): OpportunityDetection {
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

export function createMockEnvelope(overrides: MockEnvelopeOverrides = {}): CapabilityEnvelope {
  const legacy = overrides.capabilities;
  const legacySecret =
    legacy?.secrets ??
    (legacy?.secret
      ? {
          allowedSecretNames: legacy.secret.allowedSecretNames,
          allowedPrefixes: legacy.secret.allowedKeyPrefixes,
          denyDirectRead: legacy.secret.denyDirectRead,
          injectAsEnv: legacy.secret.injectAsEnv,
        }
      : undefined);
  const legacyCommands = legacy?.command?.allowedCommands ?? [];
  const legacyBinaries = [
    ...new Set(
      legacyCommands
        .map((command) => command.trim().split(/\s+/)[0])
        .filter((command): command is string => Boolean(command)),
    ),
  ];

  return {
    envelopeId: overrides.envelopeId ?? `env-${randomUUID().slice(0, 8)}`,
    workspaceId: overrides.workspaceId ?? "ws-test-456",
    version: overrides.version ?? "1.0.0",
    fs: {
      readPaths: overrides.fs?.readPaths ?? legacy?.fs?.readPaths ?? ["."],
      writePaths: overrides.fs?.writePaths ?? legacy?.fs?.writePaths ?? ["."],
      allowWorkspaceRoot:
        overrides.fs?.allowWorkspaceRoot ?? legacy?.fs?.allowWorkspaceRoot ?? true,
      allowTemp: overrides.fs?.allowTemp ?? legacy?.fs?.allowTemp ?? true,
      denyPaths: overrides.fs?.denyPaths ?? legacy?.fs?.denyPaths ?? [".env", ".git/secrets"],
      maxFileSizeBytes:
        overrides.fs?.maxFileSizeBytes ?? legacy?.fs?.maxFileSizeBytes ?? 10_485_760,
    },
    net: {
      allowOutbound: overrides.net?.allowOutbound ?? legacy?.net?.allowOutbound ?? !legacy?.net,
      allowedDomains:
        overrides.net?.allowedDomains ??
        legacy?.net?.allowedDomains ??
        (legacy?.net ? [] : ["api.example.com", "registry.npmjs.org"]),
      allowedHosts:
        overrides.net?.allowedHosts ??
        legacy?.net?.allowedHosts ??
        (legacy?.net ? [] : ["api.example.com", "registry.npmjs.org"]),
      allowedPorts:
        overrides.net?.allowedPorts ?? legacy?.net?.allowedPorts ?? (legacy?.net ? [] : [443, 80]),
      allowedProtocols:
        overrides.net?.allowedProtocols ??
        legacy?.net?.allowedProtocols ??
        (legacy?.net?.allowInsecure ? ["http", "https"] : ["https"]),
      allowLocalhost: overrides.net?.allowLocalhost ?? legacy?.net?.allowLocalhost ?? false,
      denyPrivateRanges:
        overrides.net?.denyPrivateRanges ?? legacy?.net?.denyPrivateRanges ?? true,
    },
    command: {
      allowShellExecution:
        overrides.command?.allowShellExecution ?? legacy?.command?.allowShellExecution ?? false,
      allowedCommands:
        overrides.command?.allowedCommands ??
        legacy?.command?.allowedCommands ??
        ["git status", "pnpm test", "npm run build"],
      allowedBinaries:
        overrides.command?.allowedBinaries ??
        legacy?.command?.allowedBinaries ??
        (legacy?.command ? legacyBinaries : ["git", "pnpm", "npm", "node"]),
      forbiddenPatterns:
        overrides.command?.forbiddenPatterns ??
        legacy?.command?.forbiddenPatterns ??
        legacy?.command?.denyCommands ??
        ["rm -rf /", "mkfs", "> /dev/"],
      allowEnvPassthrough:
        overrides.command?.allowEnvPassthrough ??
        legacy?.command?.allowEnvPassthrough ??
        (legacy?.command?.environmentVariables
          ? Object.keys(legacy.command.environmentVariables)
          : legacy?.command
            ? []
            : ["PATH", "NODE_ENV"]),
    },
    secrets: {
      allowedSecretNames:
        overrides.secrets?.allowedSecretNames ??
        legacySecret?.allowedSecretNames ??
        (legacySecret ? [] : ["API_KEY", "NPM_TOKEN"]),
      allowedPrefixes:
        overrides.secrets?.allowedPrefixes ??
        legacySecret?.allowedPrefixes ??
        (legacySecret ? [] : ["APP_"]),
      denyDirectRead: overrides.secrets?.denyDirectRead ?? legacySecret?.denyDirectRead ?? true,
      injectAsEnv: overrides.secrets?.injectAsEnv ?? legacySecret?.injectAsEnv ?? true,
    },
    limits: {
      maxConcurrentExecutions:
        overrides.limits?.maxConcurrentExecutions ??
        legacy?.limits?.maxConcurrentExecutions ??
        4,
      maxCpuUsagePercent:
        overrides.limits?.maxCpuUsagePercent ?? legacy?.limits?.maxCpuUsagePercent ?? 100,
      maxMemoryMb: overrides.limits?.maxMemoryMb ?? legacy?.limits?.maxMemoryMb ?? 256,
      maxExecutionTimeMs:
        overrides.limits?.maxExecutionTimeMs ?? legacy?.limits?.maxExecutionTimeMs ?? 60_000,
      maxOutputSizeBytes:
        overrides.limits?.maxOutputSizeBytes ?? legacy?.limits?.maxOutputSizeBytes ?? 2_097_152,
    },
    isFrozen: overrides.isFrozen ?? false,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}
