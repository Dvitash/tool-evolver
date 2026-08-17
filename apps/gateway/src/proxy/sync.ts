import type { ToolManifest } from "@tool-evolver/contracts";
import type { CatalogSnapshotResponse, StreamCatalogInvalidation } from "@tool-evolver/protocol";
import type { ToolRegistry } from "../registry/index.js";
import type { RegistryTool } from "../registry/types.js";
import { CloudCatalogCache } from "./cache.js";
import { CloudCircuitBreaker } from "./circuit-breaker.js";
import { CloudCatalogClient } from "./client.js";
import { CloudInvocationRouter } from "./router.js";

export interface CloudCatalogSyncOptions {
  client: CloudCatalogClient;
  cache: CloudCatalogCache;
  router: CloudInvocationRouter;
  registry?: ToolRegistry;
  workspaceId?: string;
  autoRegisterInRegistry?: boolean;
  syncIntervalMs?: number;
  onSyncSuccess?: (snapshot: CatalogSnapshotResponse) => void;
  onSyncError?: (error: unknown) => void;
}

export class CloudCatalogSyncCoordinator {
  readonly client: CloudCatalogClient;
  readonly cache: CloudCatalogCache;
  readonly router: CloudInvocationRouter;
  readonly registry?: ToolRegistry;
  readonly workspaceId: string;
  private readonly autoRegisterInRegistry: boolean;
  private readonly circuitBreaker: CloudCircuitBreaker;

  private syncIntervalMs: number;
  private syncTimer?: NodeJS.Timeout;
  private activeSyncPromise: Promise<CatalogSnapshotResponse | null> | null = null;
  private lastSnapshotVersion?: string;
  private isRunningPeriodic = false;

  private readonly onSyncSuccess?: (snapshot: CatalogSnapshotResponse) => void;
  private readonly onSyncError?: (error: unknown) => void;

  constructor(options: CloudCatalogSyncOptions) {
    this.client = options.client;
    this.cache = options.cache;
    this.router = options.router;
    this.registry = options.registry;
    this.workspaceId = options.workspaceId || options.client.workspaceId || "default";
    this.autoRegisterInRegistry = options.autoRegisterInRegistry ?? true;
    this.circuitBreaker = options.client.getCircuitBreaker();
    this.syncIntervalMs = options.syncIntervalMs ?? 60000;
    this.onSyncSuccess = options.onSyncSuccess;
    this.onSyncError = options.onSyncError;

    // Listen to circuit breaker state changes
    this.circuitBreaker.onHealthChange(async (report) => {
      if (report.status === "offline" || report.status === "unauthorized" || report.status === "upgrade_required") {
        await this.markOffline(report.lastErrorReason || `Cloud entered ${report.status} state`);
      } else if (report.status === "online") {
        await this.markOnline();
      }
    });
  }

  /**
   * Synchronizes the catalog from the cloud.
   * If network is down or circuit is open, gracefully marks cached tools stale
   * and preserves local tool functionality without crashing.
   */
  async sync(options: {
    forceFullSnapshot?: boolean;
    filterScopes?: string[];
    signal?: AbortSignal;
  } = {}): Promise<CatalogSnapshotResponse | null> {
    // If a sync is already in flight, return the active promise
    if (this.activeSyncPromise) {
      return await this.activeSyncPromise;
    }

    this.activeSyncPromise = this.executeSync(options);
    try {
      return await this.activeSyncPromise;
    } finally {
      this.activeSyncPromise = null;
    }
  }

  private async executeSync(options: {
    forceFullSnapshot?: boolean;
    filterScopes?: string[];
    signal?: AbortSignal;
  }): Promise<CatalogSnapshotResponse | null> {
    // 1. Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      const reason = "Cloud service circuit breaker is open / offline";
      this.cache.markAllStale(reason, this.workspaceId);
      return null;
    }

    try {
      // 2. Fetch snapshot from cloud client
      const currentVersion = options.forceFullSnapshot ? undefined : this.lastSnapshotVersion;
      const snapshot = await this.client.fetchCatalogSnapshot({
        currentVersion,
        filterScopes: options.filterScopes,
        signal: options.signal,
      });

      this.lastSnapshotVersion = snapshot.snapshotVersion;

      // 3. Populate local cache
      this.cache.setSnapshot(snapshot, { workspaceId: this.workspaceId });
      this.cache.markOnline(this.workspaceId);

      // 4. Reconcile with ToolRegistry if configured
      if (this.registry && this.autoRegisterInRegistry) {
        await this.reconcileRegistry(snapshot.tools);
      }

      this.onSyncSuccess?.(snapshot);
      return snapshot;
    } catch (error) {
      // Degrade gracefully into offline mode
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.cache.markAllStale(errorMsg, this.workspaceId);

      this.onSyncError?.(error);
      return null;
    }
  }

  /**
   * Handles control-stream catalog invalidation events.
   */
  async handleInvalidation(event: StreamCatalogInvalidation): Promise<void> {
    if (event.workspaceId && event.workspaceId !== this.workspaceId && event.workspaceId !== "*") {
      return;
    }

    if (event.reason === "emergency_revocation" || event.reason === "tool_deprecated") {
      // 1. Invalidate from cache immediately
      this.cache.invalidateTools(event.toolIds, this.workspaceId, event.reason);

      // 2. Deactivate / remove from registry if present
      if (this.registry) {
        for (const toolId of event.toolIds) {
          try {
            await this.registry.deactivateTool(this.workspaceId, toolId);
          } catch {
            // ignore if not active
          }
        }
      }
    } else {
      // Incremental resync or version published: trigger fresh sync
      await this.sync({ forceFullSnapshot: false });
    }
  }

  /**
   * Marks cloud catalog as offline and degrades cached tools to stale status.
   */
  async markOffline(reason = "Cloud connection offline"): Promise<void> {
    this.cache.markAllStale(reason, this.workspaceId);

    // If registry is active, update registry tools' metadata availability
    if (this.registry) {
      const cachedTools = this.cache.listTools(this.workspaceId);
      for (const cached of cachedTools) {
        const existing = await this.registry.getTool(cached.toolId, this.workspaceId);
        if (existing && existing.metadata?.source === "cloud") {
          existing.metadata = {
            ...existing.metadata,
            availability: cached.availability,
            staleReason: cached.staleReason,
          };
        }
      }
    }
  }

  /**
   * Marks cloud catalog as online and restores active fresh status.
   */
  async markOnline(): Promise<void> {
    this.cache.markOnline(this.workspaceId);

    if (this.registry) {
      const cachedTools = this.cache.listTools(this.workspaceId);
      for (const cached of cachedTools) {
        const existing = await this.registry.getTool(cached.toolId, this.workspaceId);
        if (existing && existing.metadata?.source === "cloud") {
          existing.metadata = {
            ...existing.metadata,
            availability: cached.availability,
            staleReason: undefined,
          };
        }
      }
    }
  }

  /**
   * Starts background periodic synchronization.
   */
  startPeriodicSync(intervalMs?: number): void {
    if (intervalMs) {
      this.syncIntervalMs = intervalMs;
    }
    this.stopPeriodicSync();
    this.isRunningPeriodic = true;

    this.syncTimer = setInterval(async () => {
      try {
        await this.sync();
      } catch {
        // Handled internally in executeSync
      }
    }, this.syncIntervalMs);
  }

  /**
   * Stops background periodic synchronization.
   */
  stopPeriodicSync(): void {
    this.isRunningPeriodic = false;
    clearInterval(this.syncTimer);
  }

  isRunning(): boolean {
    return this.isRunningPeriodic;
  }

  /**
   * Registers/updates all cloud tools in ToolRegistry.
   */
  private async reconcileRegistry(tools: ToolManifest[]): Promise<void> {
    if (!this.registry) {
      return;
    }

    for (const manifest of tools) {
      const registryTool: RegistryTool = {
        toolId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        manifest,
        scope: "global",
        status: "active",
        exposedName: manifest.name,
        description: manifest.description,
        parameters: manifest.parameters,
        outputSchema: manifest.outputSchema,
        handler: this.router.createToolHandler(manifest.id),
        metadata: {
          source: "cloud",
          availability: "fresh",
          cloudToolId: manifest.id,
          syncedAt: new Date().toISOString(),
        },
      };

      this.registry.registerToolSync(registryTool);
    }

    // Trigger catalog changed event if event emitter exists
    const resolvedSnapshot = await this.registry.resolveCatalog(this.workspaceId);
    this.registry.events?.emit({
      workspaceId: this.workspaceId,
      revision: "revision" in resolvedSnapshot ? (resolvedSnapshot.revision as number) : 1,
      snapshot: resolvedSnapshot,
      changedToolIds: tools.map((t) => t.id),
      timestamp: new Date().toISOString(),
    });
  }
}
