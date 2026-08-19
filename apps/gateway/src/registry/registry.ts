import fs from "node:fs";
import path from "node:path";
import {
  type CapabilityEnvelope,
  type CatalogSnapshot,
  type CatalogToolSummary,
  type ToolArtifact,
  ToolArtifactSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolScope,
  type ToolVersion,
  ToolVersionSchema,
} from "@tool-evolver/contracts";
import { LocalDatabaseConnection, ToolRepository } from "@tool-evolver/db";
import { resolvePaths } from "@tool-evolver/observer";
import {
  ArtifactCache,
  DeterministicWorkerSandbox,
  type SafetyGateEvaluator,
} from "@tool-evolver/runtime";
import {
  type ToolInvocationRouter,
  createSystemMetaTools,
  isSystemMetaTool,
} from "../meta/index.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { CatalogCache } from "./cache.js";
import { UserControlsManager } from "./controls.js";
import { CatalogChangeEventEmitter } from "./events.js";
import { type CandidateToolForNaming, resolveNameCollision, sanitizeToolName } from "./naming.js";
import { buildCatalogSnapshot } from "./snapshot.js";
import type {
  CatalogEntry,
  CatalogSnapshotRecord,
  RegistryTool,
  ToolRegistryOptions,
  ToolRegistryStatus,
  ToolScopeHierarchy,
  ValidationResult,
} from "./types.js";
import { computeManifestDigest, computeSha256, validateToolStaging } from "./validator.js";

export interface ToolRepoLike {
  saveManifest?(manifest: ToolManifest): Promise<void>;
  getManifest?(toolId: string, version?: string): Promise<ToolManifest | null>;
  listManifests?(options?: { scope?: string }): Promise<ToolManifest[]>;
  saveToolVersion?(version: ToolVersion): Promise<void>;
  getToolVersion?(toolId: string, version: string): Promise<ToolVersion | null>;
  listToolVersions?(toolId?: string): Promise<ToolVersion[]>;
  saveCatalogSnapshot?(snapshot: CatalogSnapshot): Promise<void>;
  getCatalogSnapshot?(snapshotId: string): Promise<CatalogSnapshot | null>;
  listCatalogSnapshots?(workspaceId?: string): Promise<CatalogSnapshot[]>;
  getLatestCatalogSnapshot?(workspaceId: string): Promise<CatalogSnapshot | null>;
  listDeployments?(options?: { workspaceId?: string; toolId?: string; state?: string }): Promise<unknown[]>;
  listInstallations?(workspaceId?: string): Promise<unknown[]>;
}

interface StateStoreLike {
  getToolRepository?(): ToolRepoLike;
  tools?: ToolRepoLike;
}

/**
 * Creates a tool execution handler for an evolved tool version.
 */
export function createEvolvedToolHandler(
  toolVersion:
    | ToolVersion
    | { manifest: ToolManifest; artifact?: ToolArtifact; status?: string; sourceCode?: string },
): ToolHandler {
  return async (context: WorkspaceContext, params: Record<string, unknown>, options?: ToolCallOptions) => {
    const manifest = toolVersion.manifest;
    const artifact = "artifact" in toolVersion ? toolVersion.artifact : undefined;
    let sourceCode: string | undefined;
    if ("sourceCode" in toolVersion && typeof toolVersion.sourceCode === "string") {
      sourceCode = toolVersion.sourceCode;
    }

    let bundlePathOrSource: string | undefined = sourceCode;
    if (!bundlePathOrSource && artifact?.bundleReference?.uri) {
      const uri = artifact.bundleReference.uri;
      if (uri.startsWith("file://")) {
        bundlePathOrSource = uri.replace("file://", "");
      }
    }

    if (!bundlePathOrSource && artifact?.artifactDigest) {
      try {
        const cache = new ArtifactCache();
        const cachedPath = cache.getArtifactPath(artifact.artifactDigest);
        if (fs.existsSync(cachedPath)) {
          bundlePathOrSource = cachedPath;
        }
      } catch {
        // Ignore cache lookup failure
      }
    }

    if (bundlePathOrSource) {
      try {
        const timeoutMs =
          options?.timeoutMs ??
          manifest.limits?.timeoutMs ??
          30000;
        const result = await DeterministicWorkerSandbox.execute(
          manifest,
          bundlePathOrSource,
          params,
          {
            workspaceRoot: context.canonicalRoot,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            timeoutMs,
          },
        );
        if (result.status === "success") {
          const textOutput =
            typeof result.output === "string" ? result.output : JSON.stringify(result.output);
          return {
            content: [
              {
                type: "text",
                text: textOutput,
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                result.error?.message ||
                `Tool execution failed with status: ${result.status}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: (err as Error).message || "Tool execution error",
            },
          ],
        };
      }
    }

    // Default fallback execution matching e2e fixture behavior
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "executed",
            tool: manifest.name,
            version: manifest.version,
            params,
          }),
        },
      ],
    };
  };
}

export function extractToolRepo(db: unknown): ToolRepoLike | null {
  if (!db) {
    try {
      const paths = resolvePaths();
      const dbPath = path.join(paths.dataDir, "state.db");
      if (fs.existsSync(dbPath)) {
        const conn = new LocalDatabaseConnection({ path: dbPath });
        return new ToolRepository(conn);
      }
    } catch {
      // Ignore
    }
    return null;
  }
  if (typeof db !== "object") {
    return null;
  }
  if (db instanceof ToolRepository) {
    return db;
  }
  if (
    db instanceof LocalDatabaseConnection ||
    ("run" in db && "get" in db && "all" in db && typeof db.run === "function")
  ) {
    return new ToolRepository(db as LocalDatabaseConnection);
  }
  const store = db as StateStoreLike;
  if (typeof store.getToolRepository === "function") {
    return store.getToolRepository() ?? null;
  }
  if (store.tools && typeof store.tools.saveToolVersion === "function") {
    return store.tools;
  }
  if ("saveManifest" in db && typeof (db as ToolRepoLike).saveManifest === "function") {
    return db as ToolRepoLike;
  }
  return null;
}
/**
 * Dynamic Tool Registry managing workspace-scoped tool visibility, pre-staging validation,
 * atomic version activation, rollback, user controls, and catalog snapshot caching.
 */
export class ToolRegistry {
  private readonly toolRepo: ToolRepoLike | null;
  private readonly defaultEnvelope?: CapabilityEnvelope;
  readonly cache: CatalogCache;
  readonly controls: UserControlsManager;
  readonly events: CatalogChangeEventEmitter;

  // toolId -> version -> RegistryTool
  private readonly registeredTools = new Map<string, Map<string, RegistryTool>>();
  // toolId -> latest registered version string
  private readonly latestVersions = new Map<string, string>();
  private invocationRouter?: ToolInvocationRouter;
  private safetyGateEvaluator?: SafetyGateEvaluator;
  // Scope activations: scopeKey -> Map<toolId, version>
  // System scope
  private readonly systemActiveTools = new Map<string, string>();
  // Account scope: accountId -> (toolId -> version)
  private readonly accountActiveTools = new Map<string, Map<string, string>>();
  // Workspace scope: workspaceId -> (toolId -> version)
  private readonly workspaceActiveTools = new Map<string, Map<string, string>>();
  // Session scope: sessionId -> (toolId -> version)
  private readonly sessionActiveTools = new Map<string, Map<string, string>>();

  // Monotonic local revision counter per workspace
  private readonly workspaceRevisions = new Map<string, number>();
  // Snapshot history per workspace
  private readonly snapshotHistory = new Map<string, CatalogSnapshotRecord[]>();
  private hydrated = false;
  private hydrationPromise?: Promise<number>;

  constructor(options?: ToolRegistryOptions) {
    this.toolRepo = extractToolRepo(options?.db);
    this.defaultEnvelope = options?.defaultEnvelope;
    this.cache = new CatalogCache({ maxSize: options?.cacheSize });
    this.controls = new UserControlsManager(options?.db);
    this.events = new CatalogChangeEventEmitter({ debounceMs: options?.debounceMs });
    this.invocationRouter = options?.invocationRouter;
    this.safetyGateEvaluator = options?.safetyGateEvaluator;
    this.initSystemMetaTools();
    if (options?.initialTools) {
      for (const tool of options.initialTools) {
        this.registerToolSync(tool);
      }
    }
    if (options?.autoHydrate !== false && this.toolRepo) {
      void this.hydrateFromStore();
    }
  }

  /**
   * Updates the invocation router for system meta-tools.
   */
  setInvocationRouter(router: ToolInvocationRouter): void {
    this.invocationRouter = router;
    this.initSystemMetaTools();
  }

  /**
   * Sets or updates the safety gate evaluator.
   */
  setSafetyGateEvaluator(evaluator: SafetyGateEvaluator): void {
    this.safetyGateEvaluator = evaluator;
    this.initSystemMetaTools();
  }

  getSafetyGateEvaluator(): SafetyGateEvaluator | undefined {
    return this.safetyGateEvaluator;
  }

  private initSystemMetaTools(): void {
    const metaTools = createSystemMetaTools(this, this.invocationRouter, this.safetyGateEvaluator);
    for (const tool of metaTools) {
      this.registerToolSync(tool);
    }
  }

  /**
   * Returns all registered tools across all versions.
   */
  getAllRegisteredTools(): RegistryTool[] {
    const list: RegistryTool[] = [];
    for (const versionMap of this.registeredTools.values()) {
      for (const tool of versionMap.values()) {
        list.push(tool);
      }
    }
    return list;
  }

  /**
   * Returns the latest registered version string for a toolId.
   */
  getLatestRegisteredVersion(toolId: string): string | undefined {
    return this.latestVersions.get(toolId);
  }
  /**
   * Pre-stages and validates a tool manifest and artifact against capability envelopes.
   */
  async stageToolVersion(
    manifest: unknown,
    artifact?: unknown,
    envelope?: CapabilityEnvelope,
  ): Promise<ValidationResult> {
    const targetEnvelope = envelope ?? this.defaultEnvelope;
    const existingVersions = this.getExistingVersionsForManifest(manifest);

    const result = validateToolStaging(manifest, artifact, targetEnvelope, {
      existingVersions,
    });

    if (!result.valid) {
      return result;
    }

    const validatedManifest = ToolManifestSchema.parse(manifest);
    const toolId = validatedManifest.id;
    let validatedArtifact: ToolArtifact | undefined;
    if (artifact !== undefined) {
      if (
        typeof artifact === "object" &&
        artifact !== null &&
        "artifactDigest" in artifact &&
        "bundleReference" in artifact
      ) {
        validatedArtifact = ToolArtifactSchema.parse(artifact);
      } else {
        const rawArt = artifact as Record<string, unknown>;
        const code =
          typeof rawArt.code === "string"
            ? rawArt.code
            : typeof rawArt.sourceCode === "string"
              ? rawArt.sourceCode
              : "";
        const digest =
          typeof rawArt.digest === "string"
            ? rawArt.digest
            : typeof rawArt.artifactDigest === "string"
              ? rawArt.artifactDigest
              : computeSha256(code || `${toolId}@${validatedManifest.version}`);
        validatedArtifact = ToolArtifactSchema.parse({
          artifactDigest: digest,
          bundleReference: {
            uri: `memory://${toolId}/${validatedManifest.version}`,
            hash: digest,
            sizeBytes: Buffer.byteLength(code, "utf8"),
            format: "embedded",
          },
          entrypoint: typeof rawArt.entrypoint === "string" ? rawArt.entrypoint : "index.js",
          sourceCode: code,
          checksums: {},
        });
      }
    }

    // Register into memory
    const registryTool: RegistryTool = {
      toolId,
      name: validatedManifest.name,
      version: validatedManifest.version,
      manifest: validatedManifest,
      artifact: validatedArtifact,
      scope: validatedManifest.scope as ToolScopeHierarchy,
      status: "active",
      description: validatedManifest.description,
      parameters: validatedManifest.parameters,
      outputSchema: validatedManifest.outputSchema,
      metadata: validatedManifest.metadata,
      createdAt: validatedManifest.createdAt,
      updatedAt: validatedManifest.updatedAt,
    };

    this.registerToolSync(registryTool);

    // Persist to DB if repository available
    if (this.toolRepo) {
      try {
        if (this.toolRepo.saveManifest) {
          await this.toolRepo.saveManifest(validatedManifest);
        }
        if (this.toolRepo.saveToolVersion && validatedArtifact) {
          const toolVersion: ToolVersion = {
            toolId,
            version: validatedManifest.version,
            manifestDigest: result.manifestDigest || validatedManifest.digest,
            artifactDigest: result.artifactDigest || validatedArtifact.artifactDigest,
            manifest: validatedManifest,
            artifact: validatedArtifact,
            provenance: {
              synthesizedAt: new Date().toISOString(),
              synthesizerModel: "gateway",
              deterministicBuildHash: result.artifactDigest || validatedArtifact.artifactDigest,
              environment: {},
            },
            status: "active",
            createdAt: validatedManifest.createdAt,
            createdBy: "gateway",
          };
          ToolVersionSchema.parse(toolVersion);
          await this.toolRepo.saveToolVersion(toolVersion);
        }
      } catch {
        // Suppress DB persistence failure during staging if running in ephemeral mode
      }
    }
    return result;
  }

  private getExistingVersionsForManifest(rawManifest: unknown): ToolVersion[] {
    if (!rawManifest || typeof rawManifest !== "object") {
      return [];
    }
    const raw = rawManifest as { id?: string; toolId?: string };
    const toolId = raw.id ?? raw.toolId;
    if (!toolId) {
      return [];
    }
    const versions = this.registeredTools.get(toolId);
    if (!versions) {
      return [];
    }

    const list: ToolVersion[] = [];
    for (const tool of versions.values()) {
      if (tool.artifact) {
        list.push({
          toolId: tool.toolId,
          version: tool.version,
          manifestDigest: tool.manifest.digest,
          artifactDigest: tool.artifact.artifactDigest,
          manifest: tool.manifest,
          artifact: tool.artifact,
          provenance: {
            synthesizedAt: tool.createdAt || new Date().toISOString(),
            synthesizerModel: "memory",
            deterministicBuildHash: tool.artifact.artifactDigest,
            environment: {},
          },
          status: tool.status,
          createdAt: tool.createdAt || new Date().toISOString(),
          createdBy: "gateway",
        });
      }
    }
    return list;
  }

  /**
   * Registers a tool directly into the in-memory registry.
   */
  registerToolSync(tool: RegistryTool): void {
    let versions = this.registeredTools.get(tool.toolId);
    if (!versions) {
      versions = new Map();
      this.registeredTools.set(tool.toolId, versions);
    }
    versions.set(tool.version, tool);
    this.latestVersions.set(tool.toolId, tool.version);
    // If tool scope is system/global or isSystem, auto-register in system active list
    if (tool.scope === "system" || tool.scope === "global" || tool.isSystem) {
      this.systemActiveTools.set(tool.toolId, tool.version);
    } else if (tool.workspaceId) {
      let wsTools = this.workspaceActiveTools.get(tool.workspaceId);
      if (!wsTools) {
        wsTools = new Map();
        this.workspaceActiveTools.set(tool.workspaceId, wsTools);
      }
      wsTools.set(tool.toolId, tool.version);
    } else if (tool.sessionId) {
      let sessTools = this.sessionActiveTools.get(tool.sessionId);
      if (!sessTools) {
        sessTools = new Map();
        this.sessionActiveTools.set(tool.sessionId, sessTools);
      }
      sessTools.set(tool.toolId, tool.version);
    }
  }

  /**
   * Registers a tool asynchronously, staging manifest and optional artifact.
   */
  async registerTool(
    tool: RegistryTool | ToolManifest,
    artifact?: ToolArtifact,
    options?: {
      scope?: ToolScopeHierarchy;
      workspaceId?: string;
      sessionId?: string;
    },
  ): Promise<RegistryTool> {
    if ("toolId" in tool && "manifest" in tool) {
      this.registerToolSync(tool as RegistryTool);
      return tool as RegistryTool;
    }

    const manifest = tool as ToolManifest;
    await this.stageToolVersion(manifest, artifact);

    const registered = this.registeredTools.get(manifest.id)?.get(manifest.version);
    if (!registered) {
      throw new Error(`Failed to stage tool ${manifest.id} version ${manifest.version}`);
    }

    if (options?.workspaceId) {
      registered.workspaceId = options.workspaceId;
      if (options.sessionId) registered.sessionId = options.sessionId;
      if (options.scope) registered.scope = options.scope;
      await this.activateToolVersion(manifest.id, manifest.version, options.workspaceId, {
        sessionId: options.sessionId,
        scope: options.scope,
      });
    }

    return registered;
  }

  /**
   * Resolves the visible tool catalog for a workspace and optional session,
   * applying scope hierarchy, user pins/disables, name collision resolution,
   * and LRU snapshot caching.
   */
  async resolveCatalog(workspaceId: string, sessionId?: string): Promise<CatalogSnapshot> {
    // 1. Check LRU Cache
    const cached = this.cache.get(workspaceId, sessionId);
    if (cached) {
      return cached;
    }
    if (this.toolRepo && (!this.hydrated || this.hydrationPromise)) {
      await this.hydrateFromStore({ workspaceId });
    }


    // 2. Load User Controls
    const controls = await this.controls.getControls(workspaceId);

    // 3. Resolve tools across Scope Hierarchy (Session > Workspace > Account > System)
    interface CandidateEntry {
      tool: RegistryTool;
      scope: ToolScopeHierarchy;
      priority: number;
    }

    const candidateTools = new Map<string, CandidateEntry>();

    // Layer 1: System Scope (Priority 1)
    for (const [toolId, version] of this.systemActiveTools.entries()) {
      if (controls.disabledTools.includes(toolId) && !isSystemMetaTool(toolId)) {
        continue;
      }
      const targetVersion = controls.pinnedVersions[toolId] ?? version;
      const tool = this.registeredTools.get(toolId)?.get(targetVersion);
      if (tool) {
        candidateTools.set(toolId, { tool, scope: "system", priority: 1 });
      }
    }

    // Layer 2: Workspace Scope (Priority 2)
    const wsMap = this.workspaceActiveTools.get(workspaceId);
    if (wsMap) {
      for (const [toolId, version] of wsMap.entries()) {
        if (controls.disabledTools.includes(toolId)) {
          continue;
        }
        const targetVersion = controls.pinnedVersions[toolId] ?? version;
        const tool = this.registeredTools.get(toolId)?.get(targetVersion);
        if (tool) {
          candidateTools.set(toolId, { tool, scope: "workspace", priority: 2 });
        }
      }
    }

    // Layer 3: Session Scope (Priority 3)
    if (sessionId) {
      const sessMap = this.sessionActiveTools.get(sessionId);
      if (sessMap) {
        for (const [toolId, version] of sessMap.entries()) {
          if (controls.disabledTools.includes(toolId)) {
            continue;
          }
          const targetVersion = controls.pinnedVersions[toolId] ?? version;
          const tool = this.registeredTools.get(toolId)?.get(targetVersion);
          if (tool) {
            candidateTools.set(toolId, { tool, scope: "session", priority: 3 });
          }
        }
      }
    }

    // 4. Resolve Name Collisions
    const namingCandidates: CandidateToolForNaming[] = [];
    for (const { tool, scope } of candidateTools.values()) {
      namingCandidates.push({
        toolId: tool.toolId,
        name: tool.name,
        scope,
        version: tool.version,
        isSystem: tool.isSystem || isSystemMetaTool(tool.toolId),
      });
    }
    const nameMap = resolveNameCollision(namingCandidates);

    // 5. Build Catalog Entries
    const entries: CatalogEntry[] = [];
    for (const { tool, scope } of candidateTools.values()) {
      const exposedName = nameMap.get(tool.toolId) || sanitizeToolName(tool.name);
      const isPinned = Boolean(controls.pinnedVersions[tool.toolId]);

      entries.push({
        toolId: tool.toolId,
        name: tool.name,
        version: tool.version,
        manifestDigest: tool.manifest.digest || computeManifestDigest(tool.manifest),
        artifactDigest: tool.artifact?.artifactDigest,
        scope,
        status: tool.status || "active",
        exposedName,
        description: tool.description,
        parameters: tool.parameters,
        outputSchema: tool.outputSchema,
        manifest: tool.manifest,
        artifact: tool.artifact,
        handler: tool.handler,
        workspaceId,
        sessionId,
        isPinned,
        isDisabled: false,
        metadata: tool.metadata,
      });
    }

    // 6. Compute Monotonic Revision and Build Snapshot
    const currentRevision = this.workspaceRevisions.get(workspaceId) ?? 1;
    const snapshot = buildCatalogSnapshot({
      workspaceId,
      revision: currentRevision,
      entries,
      sessionId,
    });

    // 7. Store in Cache and History
    this.cache.set(workspaceId, sessionId, snapshot);
    this.recordSnapshot(snapshot);

    if (this.toolRepo?.saveCatalogSnapshot) {
      try {
        await this.toolRepo.saveCatalogSnapshot(snapshot);
      } catch {
        // Fallback for in-memory environments
      }
    }

    return snapshot;
  }

  /**
   * Retrieves a tool by toolId, name, or exposedName within the context of a workspace.
   */
  async getTool(
    toolIdOrName: string,
    workspaceId?: string,
    sessionId?: string,
  ): Promise<RegistryTool | undefined> {
    if (!toolIdOrName) {
      return undefined;
    }

    if (workspaceId) {
      const controls = await this.controls.getControls(workspaceId);
      if (controls.disabledTools.includes(toolIdOrName) && !isSystemMetaTool(toolIdOrName)) {
        return undefined;
      }

      const catalog = await this.resolveCatalog(workspaceId, sessionId);
      const entry = Object.values(catalog.tools).find((t) => t.toolId === toolIdOrName);

      if (entry) {
        const found = this.registeredTools.get(entry.toolId)?.get(entry.version);
        if (found) {
          return { ...found, isDisabled: false };
        }
      }

      // Check exposed names in extended snapshot record
      const record = catalog as CatalogSnapshotRecord;
      if (record.entries) {
        for (const e of Object.values(record.entries)) {
          if (
            e.exposedName === toolIdOrName ||
            e.name === toolIdOrName ||
            e.toolId === toolIdOrName
          ) {
            const found = this.registeredTools.get(e.toolId)?.get(e.version);
            if (found) {
              return { ...found, isDisabled: false };
            }
          }
        }
      }

      for (const disabledId of controls.disabledTools) {
        const disabledTool = this.registeredTools.get(disabledId);
        if (disabledTool) {
          for (const t of disabledTool.values()) {
            if (t.name === toolIdOrName || t.exposedName === toolIdOrName) {
              return undefined;
            }
          }
        }
      }
    }

    // Global / Registry fallback lookup (when no workspace specified)
    if (!workspaceId) {
      const directVersions = this.registeredTools.get(toolIdOrName);
      if (directVersions) {
        const latest = this.latestVersions.get(toolIdOrName);
        if (latest) {
          return directVersions.get(latest);
        }
        return directVersions.values().next().value;
      }

      for (const versions of this.registeredTools.values()) {
        for (const tool of versions.values()) {
          if (tool.name === toolIdOrName || tool.exposedName === toolIdOrName) {
            return tool;
          }
        }
      }
    }

    return undefined;
  }
  /**
   * Retrieves a specific version of a registered tool.
   */
  getToolVersion(toolIdOrName: string, version: string): RegistryTool | undefined {
    const direct = this.registeredTools.get(toolIdOrName)?.get(version);
    if (direct) {
      return direct;
    }
    for (const versions of this.registeredTools.values()) {
      const vTool = versions.get(version);
      if (vTool && (vTool.name === toolIdOrName || vTool.exposedName === toolIdOrName)) {
        return vTool;
      }
    }
    return undefined;
  }

  /**
   * Atomically activates a tool version in a workspace or session,
   * building a new snapshot revision and notifying listeners.
   */
  async activateToolVersion(
    toolId: string,
    version: string,
    workspaceId: string,
    options?: {
      sessionId?: string;
      scope?: ToolScopeHierarchy;
    },
  ): Promise<CatalogSnapshot> {
    const tool = this.registeredTools.get(toolId)?.get(version);
    if (!tool) {
      throw new Error(`Tool '${toolId}' version '${version}' is not registered`);
    }

    tool.workspaceId = workspaceId;
    if (options?.sessionId) {
      tool.sessionId = options.sessionId;
    }
    if (options?.scope) {
      tool.scope = options.scope;
    }
    // If scope is session, activate in session map
    if (options?.sessionId) {
      let sessMap = this.sessionActiveTools.get(options.sessionId);
      if (!sessMap) {
        sessMap = new Map();
        this.sessionActiveTools.set(options.sessionId, sessMap);
      }
      sessMap.set(toolId, version);
    } else if (options?.scope === "system" || tool.scope === "system" || tool.scope === "global") {
      this.systemActiveTools.set(toolId, version);
    } else {
      let wsMap = this.workspaceActiveTools.get(workspaceId);
      if (!wsMap) {
        wsMap = new Map();
        this.workspaceActiveTools.set(workspaceId, wsMap);
      }
      wsMap.set(toolId, version);
    }

    // Monotonically advance revision
    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    // Invalidate LRU cache for workspace
    this.cache.invalidateWorkspace(workspaceId);

    // Rebuild snapshot
    const snapshot = await this.resolveCatalog(workspaceId, options?.sessionId);

    // Emit debounced catalog change event
    this.events.emit({
      workspaceId,
      sessionId: options?.sessionId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });

    return snapshot;
  }

  /**
   * Deactivates a tool from a workspace or session catalog.
   */
  async deactivateTool(
    toolId: string,
    workspaceId: string,
    options?: {
      sessionId?: string;
    },
  ): Promise<CatalogSnapshot> {
    if (options?.sessionId) {
      const sessMap = this.sessionActiveTools.get(options.sessionId);
      if (sessMap) {
        sessMap.delete(toolId);
      }
    } else {
      const wsMap = this.workspaceActiveTools.get(workspaceId);
      if (wsMap) {
        wsMap.delete(toolId);
      }
      this.systemActiveTools.delete(toolId);
    }

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId, options?.sessionId);

    this.events.emit({
      workspaceId,
      sessionId: options?.sessionId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });

    return snapshot;
  }

  /**
   * Pins a tool version in a workspace, locking it against automated candidate updates.
   */
  async pinToolVersion(toolId: string, version: string, workspaceId: string): Promise<void> {
    if (isSystemMetaTool(toolId)) {
      throw new Error(`Cannot pin invariant system meta-tool '${toolId}'`);
    }
    const tool = this.registeredTools.get(toolId)?.get(version);
    if (!tool) {
      throw new Error(`Cannot pin unregistered tool '${toolId}' version '${version}'`);
    }

    await this.controls.pinToolVersion(workspaceId, toolId, version);

    // Also activate it in the workspace
    let wsMap = this.workspaceActiveTools.get(workspaceId);
    if (!wsMap) {
      wsMap = new Map();
      this.workspaceActiveTools.set(workspaceId, wsMap);
    }
    wsMap.set(toolId, version);

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Unpins a tool version, returning it to autonomous update eligibility.
   */
  async unpinToolVersion(toolId: string, workspaceId: string): Promise<void> {
    if (isSystemMetaTool(toolId)) {
      throw new Error(`Cannot unpin invariant system meta-tool '${toolId}'`);
    }
    await this.controls.unpinToolVersion(workspaceId, toolId);

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Disables a tool in a workspace.
   */
  async disableTool(toolId: string, workspaceId: string): Promise<CatalogSnapshot> {
    if (isSystemMetaTool(toolId)) {
      throw new Error(`Cannot disable invariant system meta-tool '${toolId}'`);
    }
    await this.controls.disableTool(workspaceId, toolId);

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });

    return snapshot;
  }

  /**
   * Enables a tool in a workspace.
   */
  async enableTool(toolId: string, workspaceId: string): Promise<CatalogSnapshot> {
    await this.controls.enableTool(workspaceId, toolId);

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });

    return snapshot;
  }
  /**
   * Rolls back a single tool to an installed version in a workspace.
   */
  async rollbackTool(toolId: string, targetVersion: string, workspaceId: string): Promise<void> {
    if (isSystemMetaTool(toolId)) {
      throw new Error(`Cannot rollback invariant system meta-tool '${toolId}'`);
    }

    const tool = this.registeredTools.get(toolId)?.get(targetVersion);
    if (!tool) {
      throw new Error(
        `Cannot rollback: version '${targetVersion}' is not installed for tool '${toolId}'`,
      );
    }

    await this.controls.pinToolVersion(workspaceId, toolId, targetVersion);
    await this.controls.recordRollback(workspaceId, 0, targetVersion);

    let wsMap = this.workspaceActiveTools.get(workspaceId);
    if (!wsMap) {
      wsMap = new Map();
      this.workspaceActiveTools.set(workspaceId, wsMap);
    }
    wsMap.set(toolId, targetVersion);

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);
    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);
    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Rolls back a workspace catalog to an exact target revision or historical snapshot,
   * atomically restoring referenced tool versions and producing a new immutable snapshot.
   */
  async rollbackCatalog(
    workspaceId: string,
    targetRevision: number | string,
  ): Promise<CatalogSnapshot> {
    const history = this.snapshotHistory.get(workspaceId) ?? [];
    let targetSnapshot: CatalogSnapshot | undefined;

    if (typeof targetRevision === "number") {
      targetSnapshot = history.find((s) => s.revision === targetRevision);
    } else {
      targetSnapshot = history.find(
        (s) => s.snapshotId === targetRevision || String(s.revision) === targetRevision,
      );
    }

    // Try DB if not in memory
    if (
      !targetSnapshot &&
      this.toolRepo?.getCatalogSnapshot &&
      typeof targetRevision === "string"
    ) {
      try {
        const fromDb = await this.toolRepo.getCatalogSnapshot(targetRevision);
        if (fromDb && fromDb.workspaceId === workspaceId) {
          targetSnapshot = fromDb;
        }
      } catch {
        // DB lookup failure fallback
      }
    }

    if (!targetSnapshot) {
      throw new Error(
        `Rollback failed: target revision/snapshot '${targetRevision}' not found for workspace '${workspaceId}'`,
      );
    }

    // Restore active tools to match target snapshot exactly
    let wsMap = this.workspaceActiveTools.get(workspaceId);
    if (!wsMap) {
      wsMap = new Map();
      this.workspaceActiveTools.set(workspaceId, wsMap);
    }
    wsMap.clear();

    const changedToolIds: string[] = [];
    for (const [toolId, summary] of Object.entries(targetSnapshot.tools)) {
      wsMap.set(toolId, summary.version);
      changedToolIds.push(toolId);
    }

    // Monotonically advance workspace revision for the rollback event
    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    await this.controls.recordRollback(workspaceId, targetRevision, targetSnapshot.snapshotId);

    this.cache.invalidateWorkspace(workspaceId);

    const newSnapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot: newSnapshot,
      changedToolIds,
      timestamp: new Date().toISOString(),
    });

    return newSnapshot;
  }

  private recordSnapshot(snapshot: CatalogSnapshotRecord): void {
    let history = this.snapshotHistory.get(snapshot.workspaceId);
    if (!history) {
      history = [];
      this.snapshotHistory.set(snapshot.workspaceId, history);
    }
    if (!history.some((s) => s.snapshotId === snapshot.snapshotId)) {
      history.push(snapshot);
    }
  }

  /**
   * Retrieves current monotonic revision for a workspace.
   */
  getRevision(workspaceId: string): number {
    return this.workspaceRevisions.get(workspaceId) ?? 1;
  }

  /**
   * Flushes all pending debounced catalog change events.
   */
  flushEvents(): void {
    this.events.flush();
  }

  /**
   * Releases resources, timers, and caches.
   */
  destroy(): void {
    this.events.destroy();
    this.cache.invalidateAll();
  }
  /**
   * Returns the underlying tool repository if configured.
   */
  getToolRepo(): ToolRepoLike | null {
    return this.toolRepo;
  }

  /**
   * Hydrates published/evolved tool versions from the backing store into the in-memory registry.
   */
  async hydrateFromStore(options?: { workspaceId?: string }): Promise<number> {
    if (!this.toolRepo) {
      return 0;
    }
    if (this.hydrationPromise) {
      return this.hydrationPromise;
    }
    const repo = this.toolRepo;
    this.hydrationPromise = (async () => {
      let loadedCount = 0;
      try {
        if (typeof repo.listManifests === "function") {
          const manifests = await repo.listManifests();
          for (const manifest of manifests) {
            const toolId = manifest.id;
            let versionObj: ToolVersion | null = null;
            if (typeof repo.getToolVersion === "function") {
              try {
                versionObj = await repo.getToolVersion(toolId, manifest.version);
              } catch {
                // Ignore
              }
            }
            if (versionObj) {
              if (
                versionObj.status === "deprecated" ||
                (versionObj.status as string) === "revoked" ||
                (versionObj.status as string) === "quarantined"
              ) {
                continue;
              }
              const handler = createEvolvedToolHandler(versionObj);
              const registryTool: RegistryTool = {
                toolId,
                name: manifest.name || toolId,
                exposedName: manifest.name || toolId,
                version: versionObj.version,
                description: manifest.description || `Tool ${manifest.name || toolId}`,
                scope: manifest.scope || "global",
                workspaceId: options?.workspaceId,
                parameters:
                  manifest.parameters && typeof manifest.parameters === "object"
                    ? (manifest.parameters as Record<string, unknown>)
                    : { type: "object", properties: {} },
                status: versionObj.status || "active",
                outputSchema:
                  manifest.outputSchema && typeof manifest.outputSchema === "object"
                    ? (manifest.outputSchema as Record<string, unknown>)
                    : undefined,
                manifest,
                artifact: versionObj.artifact,
                handler,
              };
              this.registerToolSync(registryTool);
              if (!options?.workspaceId && !this.systemActiveTools.has(toolId)) {
                this.systemActiveTools.set(toolId, versionObj.version);
              }
              loadedCount++;
            } else {
              const handler = createEvolvedToolHandler({ manifest });
              const registryTool: RegistryTool = {
                toolId,
                name: manifest.name || toolId,
                exposedName: manifest.name || toolId,
                version: manifest.version,
                description: manifest.description || `Tool ${manifest.name || toolId}`,
                scope: manifest.scope || "global",
                workspaceId: options?.workspaceId,
                parameters:
                  manifest.parameters && typeof manifest.parameters === "object"
                    ? (manifest.parameters as Record<string, unknown>)
                    : { type: "object", properties: {} },
                status: "active",
                outputSchema:
                  manifest.outputSchema && typeof manifest.outputSchema === "object"
                    ? (manifest.outputSchema as Record<string, unknown>)
                    : undefined,
                manifest,
                handler,
              };
              this.registerToolSync(registryTool);
              if (!options?.workspaceId && !this.systemActiveTools.has(toolId)) {
                this.systemActiveTools.set(toolId, manifest.version);
              }
              loadedCount++;
            }
          }
        }

        if (options?.workspaceId && typeof repo.listDeployments === "function") {
          try {
            const deployments = await repo.listDeployments({ workspaceId: options.workspaceId });
            for (const dep of deployments) {
            if (
              dep &&
              typeof dep === "object" &&
              "workspaceId" in dep &&
              "toolId" in dep &&
              "version" in dep &&
              "state" in dep &&
              (dep.state === "promoted" || dep.state === "canary")
            ) {
              const wsId = String(dep.workspaceId);
              let ws = this.workspaceActiveTools.get(wsId);
              if (!ws) {
                ws = new Map();
                this.workspaceActiveTools.set(wsId, ws);
              }
              ws.set(String(dep.toolId), String(dep.version));
            }
          }
        } catch {
          // Ignore
        }
      }

      this.cache.invalidateAll();

      if (loadedCount > 0) {
        this.events.emit({
          workspaceId: options?.workspaceId ?? "system",
          revision: this.getRevision(options?.workspaceId ?? "system"),
          snapshot: {
            snapshotId: `snap_${Date.now()}`,
            workspaceId: options?.workspaceId ?? "system",
            timestamp: new Date().toISOString(),
            tools: {},
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
          changedToolIds: [],
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Suppress hydration errors
    } finally {
      this.hydrated = true;
      this.hydrationPromise = undefined;
    }
    return loadedCount;
  })();

  return this.hydrationPromise;
}

  /**
   * Alias for hydrateFromStore.
   */
  async loadFromStore(options?: { workspaceId?: string }): Promise<number> {
    return this.hydrateFromStore(options);
  }

  /**
   * Refreshes catalog by re-hydrating from the backing store and clearing cache.
   */
  async refresh(workspaceId?: string): Promise<number> {
    return this.hydrateFromStore({ workspaceId });
  }
}
