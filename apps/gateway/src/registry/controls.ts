import type { UserControls } from "./types.js";

interface DbConnectionLike {
  run(sql: string, params?: unknown[]): unknown;
  get<T = unknown>(sql: string, params?: unknown[]): T | undefined;
  all<T = unknown>(sql: string, params?: unknown[]): T[];
}

interface StateStoreLike {
  getConnection?(): DbConnectionLike;
  conn?: DbConnectionLike;
  db?: DbConnectionLike;
}

/**
 * Extracts a usable SQLite connection interface from various DB wrappers or stores.
 */
function extractConnection(db: unknown): DbConnectionLike | null {
  if (!db || typeof db !== "object") {
    return null;
  }
  const store = db as StateStoreLike;
  if (typeof store.getConnection === "function") {
    return store.getConnection() ?? null;
  }
  if (store.conn && typeof store.conn.run === "function") {
    return store.conn;
  }
  if (store.db && typeof store.db.run === "function") {
    return store.db;
  }
  if ("run" in db && typeof (db as DbConnectionLike).run === "function") {
    return db as DbConnectionLike;
  }
  return null;
}

/**
 * Manages user preferences and controls: version pinning, tool disabling, and manual rollbacks.
 * Persists data to SQLite via @tool-evolver/db when available, with resilient in-memory caching.
 */
export class UserControlsManager {
  private readonly conn: DbConnectionLike | null;
  private readonly memoryControls = new Map<string, UserControls>();

  constructor(db?: unknown) {
    this.conn = extractConnection(db);
    this.initDb();
  }

  private initDb(): void {
    if (!this.conn) {
      return;
    }
    try {
      this.conn.run(`
        CREATE TABLE IF NOT EXISTS user_tool_controls (
          workspace_id TEXT PRIMARY KEY,
          pinned_versions_json TEXT NOT NULL DEFAULT '{}',
          disabled_tools_json TEXT NOT NULL DEFAULT '[]',
          rollbacks_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL
        );
      `);
    } catch {
      // Ignore if table initialization is handled elsewhere or read-only
    }
  }

  /**
   * Retrieves full user controls for a workspace, checking in-memory cache then DB.
   */
  async getControls(workspaceId: string): Promise<UserControls> {
    const cached = this.memoryControls.get(workspaceId);
    if (cached) {
      return cached;
    }

    if (this.conn) {
      try {
        const row = this.conn.get<{
          workspace_id: string;
          pinned_versions_json: string;
          disabled_tools_json: string;
          rollbacks_json: string;
        }>("SELECT * FROM user_tool_controls WHERE workspace_id = ?;", [workspaceId]);

        if (row) {
          const controls: UserControls = {
            workspaceId: row.workspace_id,
            pinnedVersions: JSON.parse(row.pinned_versions_json || "{}"),
            disabledTools: JSON.parse(row.disabled_tools_json || "[]"),
            rollbacks: JSON.parse(row.rollbacks_json || "[]"),
          };
          this.memoryControls.set(workspaceId, controls);
          return controls;
        }
      } catch {
        // Fall back to blank controls on DB read error
      }
    }

    const defaultControls: UserControls = {
      workspaceId,
      pinnedVersions: {},
      disabledTools: [],
      rollbacks: [],
    };
    this.memoryControls.set(workspaceId, defaultControls);
    return defaultControls;
  }

  /**
   * Persists controls for a workspace to DB and updates in-memory cache.
   */
  private async persistControls(controls: UserControls): Promise<void> {
    this.memoryControls.set(controls.workspaceId, controls);

    if (this.conn) {
      try {
        const now = new Date().toISOString();
        this.conn.run(
          `INSERT INTO user_tool_controls (
            workspace_id, pinned_versions_json, disabled_tools_json, rollbacks_json, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            pinned_versions_json = excluded.pinned_versions_json,
            disabled_tools_json = excluded.disabled_tools_json,
            rollbacks_json = excluded.rollbacks_json,
            updated_at = excluded.updated_at;`,
          [
            controls.workspaceId,
            JSON.stringify(controls.pinnedVersions),
            JSON.stringify(controls.disabledTools),
            JSON.stringify(controls.rollbacks ?? []),
            now,
          ],
        );
      } catch {
        // Fallback silently if DB write fails
      }
    }
  }

  /**
   * Pins a specific tool version for a workspace.
   */
  async pinToolVersion(workspaceId: string, toolId: string, version: string): Promise<void> {
    const controls = await this.getControls(workspaceId);
    controls.pinnedVersions[toolId] = version;
    await this.persistControls(controls);
  }

  /**
   * Unpins a tool version, allowing autonomous updates.
   */
  async unpinToolVersion(workspaceId: string, toolId: string): Promise<void> {
    const controls = await this.getControls(workspaceId);
    delete controls.pinnedVersions[toolId];
    await this.persistControls(controls);
  }

  /**
   * Gets the pinned version of a tool, if pinned.
   */
  async getPinnedVersion(workspaceId: string, toolId: string): Promise<string | undefined> {
    const controls = await this.getControls(workspaceId);
    return controls.pinnedVersions[toolId];
  }

  /**
   * Lists all pinned tool versions in a workspace.
   */
  async listPinnedVersions(workspaceId: string): Promise<Record<string, string>> {
    const controls = await this.getControls(workspaceId);
    return { ...controls.pinnedVersions };
  }

  /**
   * Disables a tool in a workspace.
   */
  async disableTool(workspaceId: string, toolId: string): Promise<void> {
    const controls = await this.getControls(workspaceId);
    if (!controls.disabledTools.includes(toolId)) {
      controls.disabledTools.push(toolId);
      await this.persistControls(controls);
    }
  }

  /**
   * Enables a previously disabled tool in a workspace.
   */
  async enableTool(workspaceId: string, toolId: string): Promise<void> {
    const controls = await this.getControls(workspaceId);
    if (controls.disabledTools.includes(toolId)) {
      controls.disabledTools = controls.disabledTools.filter((id) => id !== toolId);
      await this.persistControls(controls);
    }
  }

  /**
   * Checks if a tool is disabled in a workspace.
   */
  async isToolDisabled(workspaceId: string, toolId: string): Promise<boolean> {
    const controls = await this.getControls(workspaceId);
    return controls.disabledTools.includes(toolId);
  }

  /**
   * Lists all disabled tools in a workspace.
   */
  async listDisabledTools(workspaceId: string): Promise<string[]> {
    const controls = await this.getControls(workspaceId);
    return [...controls.disabledTools];
  }

  /**
   * Records a manual rollback action.
   */
  async recordRollback(
    workspaceId: string,
    targetRevision: number | string,
    restoredSnapshotId?: string,
  ): Promise<void> {
    const controls = await this.getControls(workspaceId);
    if (!controls.rollbacks) {
      controls.rollbacks = [];
    }
    controls.rollbacks.push({
      targetRevision,
      timestamp: new Date().toISOString(),
      restoredSnapshotId,
    });
    await this.persistControls(controls);
  }
}
