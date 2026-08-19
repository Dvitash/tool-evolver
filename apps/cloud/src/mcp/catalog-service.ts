/**
 * @tool-evolver/cloud - Cloud MCP Catalog Service & Snapshot Manager
 */

import { randomUUID } from "node:crypto";
import {
  type DeploymentRecord,
  type ToolManifest,
  ToolManifestSchema,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import type { CatalogSnapshotResponse, StreamCatalogInvalidation } from "@tool-evolver/protocol";
import type { DatabasePool } from "../db/client.js";
import { type OutboxPublisher, OutboxRepository } from "../db/outbox.js";
import type { ToolRegistryRepository } from "../evolution/artifacts/repositories/tool-registry-repository.js";
import type { TenantContext } from "../tenant.js";
import {
  echoFixtureTool,
  createGetEvolutionStatusTool,
  createGetToolLineageTool,
  statusFixtureTool,
  testFailureFixtureTool,
} from "./tools/index.js";
import type {
  CatalogInvalidationListener,
  CatalogInvalidationReason,
  CloudCatalogSnapshotRecord,
  CloudMcpToolDefinition,
  CloudToolProvider,
} from "./types.js";

/**
 * Options for configuring CloudCatalogService.
 */
export interface CloudCatalogServiceOptions {
  dbPool?: DatabasePool;
  toolRegistryRepo?: ToolRegistryRepository;
  outboxPublisher?: OutboxPublisher;
  initialTools?: CloudMcpToolDefinition[];
  includeDefaultPlatformTools?: boolean;
}

/**
 * Cloud Catalog Service managing tenant/workspace-scoped tool definitions,
 * snapshot generation, revision tracking, and invalidation events.
 */
export class CloudCatalogService {
  private readonly dbPool?: DatabasePool;
  private readonly toolRegistryRepo?: ToolRegistryRepository;
  private readonly outboxPublisher?: OutboxPublisher;

  // Registered providers and tools
  private readonly providers: CloudToolProvider[] = [];
  private readonly directTools = new Map<string, CloudMcpToolDefinition>();

  // Workspace snapshot caches and revision counters
  private readonly revisions = new Map<string, number>();
  private readonly snapshots = new Map<string, CloudCatalogSnapshotRecord>();

  // Invalidation listeners
  private readonly invalidationListeners = new Set<CatalogInvalidationListener>();

  constructor(options: CloudCatalogServiceOptions = {}) {
    this.dbPool = options.dbPool;
    this.toolRegistryRepo = options.toolRegistryRepo;
    this.outboxPublisher = options.outboxPublisher;

    // Register initial tools
    if (options.initialTools) {
      for (const tool of options.initialTools) {
        this.registerTool(tool);
      }
    }

    // Register default platform tools unless explicitly disabled
    if (options.includeDefaultPlatformTools !== false) {
      this.registerTool(
        createGetEvolutionStatusTool({
          dbPool: options.dbPool,
          toolRegistryRepo: options.toolRegistryRepo,
        }),
      );
      this.registerTool(
        createGetToolLineageTool({
          dbPool: options.dbPool,
          toolRegistryRepo: options.toolRegistryRepo,
        }),
      );
      this.registerTool(echoFixtureTool);
      this.registerTool(statusFixtureTool);
      this.registerTool(testFailureFixtureTool);
    }
  }

  /**
   * Register a dynamic tool provider.
   */
  registerProvider(provider: CloudToolProvider): void {
    this.providers.push(provider);
  }

  /**
   * Register a standalone tool definition.
   */
  registerTool(tool: CloudMcpToolDefinition): void {
    this.directTools.set(tool.name, tool);
  }

  /**
   * Unregister a tool by name.
   */
  unregisterTool(toolName: string): boolean {
    return this.directTools.delete(toolName);
  }

  /**
   * Subscribe to catalog invalidation events.
   */
  onInvalidation(listener: CatalogInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  /**
   * Get the current snapshot revision number for a workspace.
   */
  getSnapshotRevision(workspaceId: string): number {
    return this.revisions.get(workspaceId) ?? 1;
  }

  /**
   * Get the cached snapshot record for a workspace if present.
   */
  getSnapshot(workspaceId: string): CloudCatalogSnapshotRecord | null {
    return this.snapshots.get(workspaceId) ?? null;
  }

  /**
   * Resolve all tools accessible to a given tenant context.
   * Enforces tenant isolation: workspace-scoped tools are filtered to caller's workspace.
   */
  async getTools(tenant: TenantContext): Promise<CloudMcpToolDefinition[]> {
    const toolsMap = new Map<string, CloudMcpToolDefinition>();

    // 1. Direct tools
    for (const tool of this.directTools.values()) {
      if (this.isToolAccessibleToTenant(tool, tenant)) {
        toolsMap.set(tool.name, tool);
      }
    }

    // 2. Provider tools
    for (const provider of this.providers) {
      try {
        const providerTools = await provider.getTools(tenant);
        for (const tool of providerTools) {
          if (this.isToolAccessibleToTenant(tool, tenant)) {
            toolsMap.set(tool.name, tool);
          }
        }
      } catch (err) {
        // Graceful partial degradation: provider error does not block other tools
      }
    }

    // 3. Database Tool Registry tools (if available)
    if (this.toolRegistryRepo) {
      try {
        const dbTools = await this.toolRegistryRepo.listTools(tenant);
        for (const entity of dbTools) {
          if (!toolsMap.has(entity.id)) {
            const manifest = this.convertToolEntityToManifest(entity, tenant);
            toolsMap.set(entity.id, {
              name: entity.name,
              description: entity.description ?? `Evolved tool ${entity.name}`,
              inputSchema: manifest.parameters ?? { type: "object", properties: {} },
              source: "registry",
              scope: "workspace",
              manifest,
              version: entity.activeVersion ?? "1.0.0",
              handler: async (params, ctx) => {
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        toolId: entity.id,
                        status: "executed",
                        workspaceId: ctx.tenant.workspaceId,
                        params,
                      }),
                    },
                  ],
                  isError: false,
                };
              },
            });
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    return Array.from(toolsMap.values());
  }

  /**
   * Lookup a specific tool by name for a given tenant context.
   */
  async getTool(tenant: TenantContext, toolName: string): Promise<CloudMcpToolDefinition | null> {
    // 1. Direct tools
    const directTool = this.directTools.get(toolName);
    if (directTool && this.isToolAccessibleToTenant(directTool, tenant)) {
      return directTool;
    }

    // 2. Provider tools
    for (const provider of this.providers) {
      try {
        const tool = await provider.getTool(tenant, toolName);
        if (tool && this.isToolAccessibleToTenant(tool, tenant)) {
          return tool;
        }
      } catch {
        // Fall through
      }
    }

    // 3. Database registry lookup
    if (this.toolRegistryRepo) {
      try {
        const entity = await this.toolRegistryRepo.getTool(tenant, toolName);
        if (entity) {
          const manifest = this.convertToolEntityToManifest(entity, tenant);
          return {
            name: entity.id,
            description: entity.description ?? `Evolved tool ${entity.name}`,
            inputSchema: manifest.parameters ?? { type: "object", properties: {} },
            source: "registry",
            scope: "workspace",
            manifest,
            version: entity.activeVersion ?? "1.0.0",
            handler: async (params, ctx) => {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      toolId: entity.id,
                      status: "executed",
                      workspaceId: ctx.tenant.workspaceId,
                      params,
                    }),
                  },
                ],
                isError: false,
              };
            },
          };
        }
      } catch {
        // Fall through
      }
    }

    return null;
  }

  /**
   * Generates or retrieves a versioned catalog snapshot for a tenant workspace.
   */
  async getCatalogSnapshot(
    tenant: TenantContext,
    currentVersion?: string,
    filterScopes?: string[],
  ): Promise<CatalogSnapshotResponse> {
    const workspaceId = tenant.workspaceId;
    const revision = this.revisions.get(workspaceId) ?? 1;
    const cacheKey = `${workspaceId}:${revision}:${(filterScopes ?? []).join(",")}`;

    const cached = this.snapshots.get(cacheKey);
    if (cached) {
      return {
        snapshotVersion: cached.snapshotVersion,
        generatedAt: cached.generatedAt,
        checksum: cached.checksum,
        tools: cached.tools,
        activeDeployments: cached.activeDeployments,
      };
    }

    // Collect all accessible tools
    const tools = await this.getTools(tenant);

    // Filter tools if filterScopes specified
    const filteredTools =
      filterScopes && filterScopes.length > 0
        ? tools.filter((t) => !t.scope || filterScopes.includes(t.scope) || t.scope === "platform")
        : tools;

    // Convert tool definitions to ToolManifest records
    const manifests: ToolManifest[] = filteredTools.map((t) => this.convertToManifest(t, tenant));

    // Build active deployments
    const activeDeployments: DeploymentRecord[] = [];
    for (const manifest of manifests) {
      activeDeployments.push({
        deploymentId: `dep_${manifest.id}_${manifest.version}`,
        workspaceId,
        toolId: manifest.id,
        toolVersion: manifest.version,
        state: "promoted",
        activeTrafficPercentage: 100,
        history: [],
        createdAt: manifest.createdAt,
      });
    }

    // Compute deterministic canonical checksum
    const checksumPayload = {
      tools: manifests,
      activeDeployments,
    };
    const checksum = hashCanonicalContent(checksumPayload, { prefix: false });
    const snapshotVersion = `v${revision}-${checksum.slice(0, 12)}`;

    // Cache the snapshot record
    const snapshotRecord: CloudCatalogSnapshotRecord = {
      snapshotVersion,
      revision,
      tenantId: tenant.accountId,
      workspaceId,
      checksum,
      generatedAt: new Date().toISOString(),
      tools: manifests,
      activeDeployments,
      filterScopes,
    };
    this.snapshots.set(cacheKey, snapshotRecord);
    this.snapshots.set(workspaceId, snapshotRecord);

    return {
      snapshotVersion,
      generatedAt: snapshotRecord.generatedAt,
      checksum,
      tools: manifests,
      activeDeployments,
    };
  }
  /**
   * Invalidate workspace catalog revision and emit invalidation events.
   */
  async invalidateWorkspaceCatalog(
    tenant: TenantContext,
    reason: CatalogInvalidationReason = "config_changed",
    toolIds: string[] = [],
  ): Promise<void> {
    const workspaceId = tenant.workspaceId;
    const currentRev = this.revisions.get(workspaceId) ?? 1;
    const nextRev = currentRev + 1;
    this.revisions.set(workspaceId, nextRev);

    // Regenerate snapshot
    await this.getCatalogSnapshot(tenant);

    // Create Invalidation Event
    const invalidationEvent: StreamCatalogInvalidation = {
      type: "server.catalog_invalidation",
      workspaceId,
      toolIds,
      reason,
      timestamp: new Date().toISOString(),
    };

    // 1. Notify local in-memory listeners
    for (const listener of this.invalidationListeners) {
      try {
        await listener(invalidationEvent);
      } catch {
        // Non-blocking
      }
    }

    // 2. Publish Outbox event if publisher available
    if (this.dbPool) {
      try {
        await OutboxRepository.insert(this.dbPool, {
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          aggregateType: "workspace_catalog",
          aggregateId: workspaceId,
          eventType: "catalog.invalidated",
          payload: invalidationEvent as unknown as Record<string, unknown>,
          headers: {
            "x-workspace-id": workspaceId,
            "x-account-id": tenant.accountId,
          },
        });
      } catch {
        // Non-blocking outbox error
      }
    }
  }

  /**
   * Helper to check if a tool is accessible to a tenant context.
   */
  private isToolAccessibleToTenant(tool: CloudMcpToolDefinition, tenant: TenantContext): boolean {
    if (tool.scope === "platform" || tool.scope === "public") {
      return true;
    }

    if (tool.manifest?.metadata?.workspaceId) {
      return tool.manifest.metadata.workspaceId === tenant.workspaceId;
    }

    return true;
  }

  /**
   * Helper to convert a tool definition to a ToolManifest.
   */
  private convertToManifest(tool: CloudMcpToolDefinition, tenant: TenantContext): ToolManifest {
    if (tool.manifest) {
      return tool.manifest;
    }

    const rawSchema = (tool.inputSchema ?? { type: "object", properties: {} }) as Record<
      string,
      unknown
    >;
    const parameters = {
      type: "object" as const,
      properties: (rawSchema.properties as Record<string, Record<string, unknown>>) ?? {},
      required: Array.isArray(rawSchema.required) ? (rawSchema.required as string[]) : [],
      additionalProperties: false,
    };

    const manifestDigest = hashCanonicalContent(
      {
        id: tool.name,
        version: tool.version ?? "1.0.0",
        parameters,
      },
      { prefix: false },
    );

    return {
      id: tool.name,
      name: tool.name,
      version: tool.version ?? "1.0.0",
      description: tool.description,
      parameters,
      runtime: {
        runtime: "builtin",
        timeoutMs: tool.timeoutMs ?? 30000,
        memoryLimitMb: 128,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
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
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
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
        timeoutMs: tool.timeoutMs ?? 30000,
        maxOutputBytes: 1048576,
        maxMemoryBytes: 134217728,
        maxConcurrentInvocations: 4,
      },
      scope: tool.scope === "platform" ? "global" : "workspace",
      digest: `sha256:${manifestDigest}`,
      metadata: {
        source: tool.source ?? "platform",
        scope: tool.scope ?? "platform",
        classification: tool.classification ?? "read_only",
        workspaceId: tool.scope === "platform" ? undefined : tenant.workspaceId,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  /**
   * Helper to convert a DB ToolEntity to a ToolManifest.
   */
  private convertToolEntityToManifest(
    entity: {
      id: string;
      name: string;
      description?: string | null;
      activeVersion?: string | null;
    },
    tenant: TenantContext,
  ): ToolManifest {
    const parameters = {
      type: "object" as const,
      properties: {},
      required: [],
      additionalProperties: false,
    };

    const manifestDigest = hashCanonicalContent(
      {
        id: entity.id,
        version: entity.activeVersion ?? "1.0.0",
        parameters,
      },
      { prefix: false },
    );

    return {
      id: entity.id,
      name: entity.name,
      version: entity.activeVersion ?? "1.0.0",
      description: entity.description ?? "",
      parameters,
      runtime: {
        runtime: "builtin",
        timeoutMs: 30000,
        memoryLimitMb: 128,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
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
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
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
        timeoutMs: 30000,
        maxOutputBytes: 1048576,
        maxMemoryBytes: 134217728,
        maxConcurrentInvocations: 4,
      },
      scope: "workspace",
      digest: `sha256:${manifestDigest}`,
      metadata: {
        source: "registry",
        scope: "workspace",
        workspaceId: tenant.workspaceId,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }
}

/**
 * Factory function creating a CloudCatalogService instance.
 */
export function createCloudCatalogService(
  options: CloudCatalogServiceOptions = {},
): CloudCatalogService {
  return new CloudCatalogService(options);
}

const BUILTIN_TOOL_NAMES: Record<string, true> = {
  get_evolution_status: true,
  get_tool_lineage: true,
  echo: true,
  status: true,
  test_failure: true,
  echo_fixture: true,
  status_fixture: true,
  test_failure_fixture: true,
};

const BUILTIN_SOURCES: Record<string, true> = {
  platform: true,
  fixture: true,
};

function formatInputHint(parameters?: {
  properties?: Record<string, unknown>;
  required?: string[];
}): string {
  if (!parameters || !parameters.properties || Object.keys(parameters.properties).length === 0) {
    return "Inputs: none";
  }

  const requiredList = Array.isArray(parameters.required) ? parameters.required : [];
  const entries = Object.entries(parameters.properties).map(([name, rawProp]) => {
    const prop = (rawProp && typeof rawProp === "object" ? rawProp : {}) as {
      type?: string;
      description?: string;
    };
    const isReq = requiredList.includes(name);
    const reqStr = isReq ? "required" : "optional";
    const typeStr = prop.type ?? "any";
    const desc = prop.description ? `: ${prop.description}` : "";
    return `${name} (${typeStr}, ${reqStr})${desc}`;
  });

  return `Inputs: ${entries.join("; ")}`;
}

/**
 * Renders a markdown harness-instructions fragment from a catalog snapshot record or response.
 */
export function renderCatalogInstructions(
  snapshot: CloudCatalogSnapshotRecord | CatalogSnapshotResponse | null | undefined,
): string {
  if (!snapshot || !Array.isArray(snapshot.tools) || snapshot.tools.length === 0) {
    return "<!-- No evolved tools currently active in this workspace catalog. -->";
  }

  const evolvedTools = snapshot.tools.filter(
    (tool) =>
      !BUILTIN_SOURCES[tool.metadata?.source as string] &&
      !BUILTIN_TOOL_NAMES[tool.name] &&
      !BUILTIN_TOOL_NAMES[tool.id],
  );

  if (evolvedTools.length === 0) {
    return "<!-- No evolved tools currently active in this workspace catalog. -->";
  }

  const lines: string[] = [
    "## Evolved Tools",
    "",
    "The following workspace-specific tools have been evolved from observed workflows. Prefer these over running equivalent manual CLI commands:",
    "",
  ];

  for (const tool of evolvedTools) {
    const rawSchema = tool.parameters as
      | {
          properties?: Record<string, unknown>;
          required?: string[];
        }
      | undefined;
    const inputHint = formatInputHint(rawSchema);

    lines.push(`### \`${tool.name}\``);
    lines.push(`- **Description**: ${tool.description}`);
    lines.push(`- **${inputHint}**`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
