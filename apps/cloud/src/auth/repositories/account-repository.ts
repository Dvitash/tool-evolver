import { DatabasePool, Queryable } from "../../db/client.js";

/**
 * Account representation.
 */
export interface Account {
  id: string;
  name: string;
  plan: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Workspace representation.
 */
export interface Workspace {
  id: string;
  accountId: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Workspace Membership representation.
 */
export interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  accountId: string;
  userId: string;
  role: "admin" | "member" | "viewer";
  createdAt: string;
}

/**
 * Device representation.
 */
export interface Device {
  id: string;
  accountId: string;
  workspaceId: string;
  installationId?: string;
  name: string;
  platform: string;
  arch?: string;
  status: "registered" | "active" | "revoked";
  publicKey?: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Installation identity representation.
 */
export interface Installation {
  id: string;
  deviceId: string;
  accountId: string;
  workspaceId: string;
  clientVersion: string;
  hostname: string;
  status: "registered" | "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

/**
 * Common Account Repository interface.
 */
export interface AccountRepository {
  getAccount(id: string): Promise<Account | null>;
  createAccount(account: { id: string; name: string; plan?: string }): Promise<Account>;

  getWorkspace(id: string): Promise<Workspace | null>;
  createWorkspace(workspace: { id: string; accountId: string; name: string; slug: string }): Promise<Workspace>;
  listWorkspacesForAccount(accountId: string): Promise<Workspace[]>;

  getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
  addMembership(membership: {
    workspaceId: string;
    accountId: string;
    userId: string;
    role?: "admin" | "member" | "viewer";
  }): Promise<WorkspaceMembership>;
  isUserInWorkspace(userId: string, workspaceId: string, accountId?: string): Promise<boolean>;

  getDevice(id: string): Promise<Device | null>;
  createOrUpdateDevice(device: {
    id: string;
    accountId: string;
    workspaceId: string;
    installationId?: string;
    name?: string;
    platform?: string;
    arch?: string;
    status?: "registered" | "active" | "revoked";
    publicKey?: string;
    lastSeenAt?: string;
  }): Promise<Device>;
  revokeDevice(id: string): Promise<boolean>;
  isDeviceRevoked(id: string): Promise<boolean>;

  getInstallation(id: string): Promise<Installation | null>;
  createOrUpdateInstallation(installation: {
    id: string;
    deviceId: string;
    accountId: string;
    workspaceId: string;
    clientVersion?: string;
    hostname?: string;
    status?: "registered" | "active" | "revoked";
  }): Promise<Installation>;
  revokeInstallation(id: string): Promise<boolean>;
  isInstallationRevoked(id: string): Promise<boolean>;
}

/**
 * In-Memory implementation of AccountRepository for tests and local setups.
 */
export class MemoryAccountRepository implements AccountRepository {
  private accounts = new Map<string, Account>();
  private workspaces = new Map<string, Workspace>();
  private memberships = new Map<string, WorkspaceMembership>(); // key: `${workspaceId}:${userId}`
  private devices = new Map<string, Device>();
  private installations = new Map<string, Installation>();

  async getAccount(id: string): Promise<Account | null> {
    return this.accounts.get(id) ?? null;
  }

  async createAccount(account: { id: string; name: string; plan?: string }): Promise<Account> {
    const now = new Date().toISOString();
    const created: Account = {
      id: account.id,
      name: account.name,
      plan: account.plan ?? "standard",
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.set(account.id, created);
    return created;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    return this.workspaces.get(id) ?? null;
  }

  async createWorkspace(workspace: {
    id: string;
    accountId: string;
    name: string;
    slug: string;
  }): Promise<Workspace> {
    const now = new Date().toISOString();
    const created: Workspace = {
      id: workspace.id,
      accountId: workspace.accountId,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.set(workspace.id, created);
    return created;
  }

  async listWorkspacesForAccount(accountId: string): Promise<Workspace[]> {
    const results: Workspace[] = [];
    for (const ws of this.workspaces.values()) {
      if (ws.accountId === accountId) {
        results.push(ws);
      }
    }
    return results;
  }

  async getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    return this.memberships.get(`${workspaceId}:${userId}`) ?? null;
  }

  async addMembership(membership: {
    workspaceId: string;
    accountId: string;
    userId: string;
    role?: "admin" | "member" | "viewer";
  }): Promise<WorkspaceMembership> {
    const now = new Date().toISOString();
    const created: WorkspaceMembership = {
      id: `mem_${membership.workspaceId}_${membership.userId}`,
      workspaceId: membership.workspaceId,
      accountId: membership.accountId,
      userId: membership.userId,
      role: membership.role ?? "member",
      createdAt: now,
    };
    this.memberships.set(`${membership.workspaceId}:${membership.userId}`, created);
    return created;
  }

  async isUserInWorkspace(userId: string, workspaceId: string, accountId?: string): Promise<boolean> {
    const membership = this.memberships.get(`${workspaceId}:${userId}`);
    if (!membership) return false;
    if (accountId && membership.accountId !== accountId) return false;
    return true;
  }

  async getDevice(id: string): Promise<Device | null> {
    return this.devices.get(id) ?? null;
  }

  async createOrUpdateDevice(device: {
    id: string;
    accountId: string;
    workspaceId: string;
    installationId?: string;
    name?: string;
    platform?: string;
    arch?: string;
    status?: "registered" | "active" | "revoked";
    publicKey?: string;
    lastSeenAt?: string;
  }): Promise<Device> {
    const existing = this.devices.get(device.id);
    const now = new Date().toISOString();

    const updated: Device = {
      id: device.id,
      accountId: device.accountId,
      workspaceId: device.workspaceId,
      installationId: device.installationId ?? existing?.installationId,
      name: device.name ?? existing?.name ?? `device-${device.id}`,
      platform: device.platform ?? existing?.platform ?? "linux",
      arch: device.arch ?? existing?.arch ?? "x64",
      status: device.status ?? existing?.status ?? "registered",
      publicKey: device.publicKey ?? existing?.publicKey,
      lastSeenAt: device.lastSeenAt ?? now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.devices.set(device.id, updated);
    return updated;
  }

  async revokeDevice(id: string): Promise<boolean> {
    const device = this.devices.get(id);
    if (!device) {
      // Record revocation marker even if device record didn't exist yet
      const now = new Date().toISOString();
      this.devices.set(id, {
        id,
        accountId: "unknown",
        workspaceId: "unknown",
        name: "revoked-device",
        platform: "unknown",
        status: "revoked",
        createdAt: now,
        updatedAt: now,
      });
      return true;
    }
    device.status = "revoked";
    device.updatedAt = new Date().toISOString();
    this.devices.set(id, device);
    return true;
  }

  async isDeviceRevoked(id: string): Promise<boolean> {
    const device = this.devices.get(id);
    return device ? device.status === "revoked" : false;
  }

  async getInstallation(id: string): Promise<Installation | null> {
    return this.installations.get(id) ?? null;
  }

  async createOrUpdateInstallation(installation: {
    id: string;
    deviceId: string;
    accountId: string;
    workspaceId: string;
    clientVersion?: string;
    hostname?: string;
    status?: "registered" | "active" | "revoked";
  }): Promise<Installation> {
    const existing = this.installations.get(installation.id);
    const now = new Date().toISOString();

    const updated: Installation = {
      id: installation.id,
      deviceId: installation.deviceId,
      accountId: installation.accountId,
      workspaceId: installation.workspaceId,
      clientVersion: installation.clientVersion ?? existing?.clientVersion ?? "1.0.0",
      hostname: installation.hostname ?? existing?.hostname ?? "localhost",
      status: installation.status ?? existing?.status ?? "registered",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.installations.set(installation.id, updated);
    return updated;
  }

  async revokeInstallation(id: string): Promise<boolean> {
    const installation = this.installations.get(id);
    if (!installation) {
      const now = new Date().toISOString();
      this.installations.set(id, {
        id,
        deviceId: "unknown",
        accountId: "unknown",
        workspaceId: "unknown",
        clientVersion: "1.0.0",
        hostname: "unknown",
        status: "revoked",
        createdAt: now,
        updatedAt: now,
      });
      return true;
    }
    installation.status = "revoked";
    installation.updatedAt = new Date().toISOString();
    this.installations.set(id, installation);
    return true;
  }

  async isInstallationRevoked(id: string): Promise<boolean> {
    const inst = this.installations.get(id);
    return inst ? inst.status === "revoked" : false;
  }

  clear(): void {
    this.accounts.clear();
    this.workspaces.clear();
    this.memberships.clear();
    this.devices.clear();
    this.installations.clear();
  }
}

/**
 * Database-backed implementation of AccountRepository using SQL DatabasePool.
 */
export class DatabaseAccountRepository implements AccountRepository {
  constructor(private pool: DatabasePool) {}

  async getAccount(id: string): Promise<Account | null> {
    const res = await this.pool.query<Account>(`SELECT * FROM accounts WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] ?? null;
  }

  async createAccount(account: { id: string; name: string; plan?: string }): Promise<Account> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO accounts (id, name, plan, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = $2, plan = $3, updated_at = $5`,
      [account.id, account.name, account.plan ?? "standard", now, now],
    );
    return (await this.getAccount(account.id))!;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const res = await this.pool.query<Workspace>(`SELECT * FROM workspaces WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] ?? null;
  }

  async createWorkspace(workspace: {
    id: string;
    accountId: string;
    name: string;
    slug: string;
  }): Promise<Workspace> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO workspaces (id, account_id, name, slug, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET name = $3, slug = $4, updated_at = $6`,
      [workspace.id, workspace.accountId, workspace.name, workspace.slug, now, now],
    );
    return (await this.getWorkspace(workspace.id))!;
  }

  async listWorkspacesForAccount(accountId: string): Promise<Workspace[]> {
    const res = await this.pool.query<Workspace>(
      `SELECT * FROM workspaces WHERE account_id = $1 ORDER BY created_at ASC`,
      [accountId],
    );
    return res.rows;
  }

  async getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    const res = await this.pool.query<WorkspaceMembership>(
      `SELECT * FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
      [workspaceId, userId],
    );
    return res.rows[0] ?? null;
  }

  async addMembership(membership: {
    workspaceId: string;
    accountId: string;
    userId: string;
    role?: "admin" | "member" | "viewer";
  }): Promise<WorkspaceMembership> {
    const id = `mem_${membership.workspaceId}_${membership.userId}`;
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO workspace_memberships (id, workspace_id, account_id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET role = $5`,
      [id, membership.workspaceId, membership.accountId, membership.userId, membership.role ?? "member", now],
    );
    return {
      id,
      workspaceId: membership.workspaceId,
      accountId: membership.accountId,
      userId: membership.userId,
      role: membership.role ?? "member",
      createdAt: now,
    };
  }

  async isUserInWorkspace(userId: string, workspaceId: string, accountId?: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 ${
        accountId ? "AND account_id = $3" : ""
      } LIMIT 1`,
      accountId ? [workspaceId, userId, accountId] : [workspaceId, userId],
    );
    return res.rowCount > 0;
  }

  async getDevice(id: string): Promise<Device | null> {
    const res = await this.pool.query<Device>(`SELECT * FROM devices WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] ?? null;
  }

  async createOrUpdateDevice(device: {
    id: string;
    accountId: string;
    workspaceId: string;
    installationId?: string;
    name?: string;
    platform?: string;
    arch?: string;
    status?: "registered" | "active" | "revoked";
    publicKey?: string;
    lastSeenAt?: string;
  }): Promise<Device> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO devices (id, account_id, workspace_id, name, platform, status, public_key, last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         account_id = $2,
         workspace_id = $3,
         name = COALESCE($4, devices.name),
         platform = COALESCE($5, devices.platform),
         status = COALESCE($6, devices.status),
         public_key = COALESCE($7, devices.public_key),
         last_seen_at = COALESCE($8, devices.last_seen_at),
         updated_at = $10`,
      [
        device.id,
        device.accountId,
        device.workspaceId,
        device.name ?? `device-${device.id}`,
        device.platform ?? "linux",
        device.status ?? "registered",
        device.publicKey ?? null,
        device.lastSeenAt ?? now,
        now,
        now,
      ],
    );
    return (await this.getDevice(device.id))!;
  }

  async revokeDevice(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE devices SET status = 'revoked', updated_at = $1 WHERE id = $2`,
      [now, id],
    );
    return true;
  }

  async isDeviceRevoked(id: string): Promise<boolean> {
    const device = await this.getDevice(id);
    return device ? device.status === "revoked" : false;
  }

  async getInstallation(id: string): Promise<Installation | null> {
    const res = await this.pool.query<Installation>(`SELECT * FROM installations WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] ?? null;
  }

  async createOrUpdateInstallation(installation: {
    id: string;
    deviceId: string;
    accountId: string;
    workspaceId: string;
    clientVersion?: string;
    hostname?: string;
    status?: "registered" | "active" | "revoked";
  }): Promise<Installation> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO installations (id, device_id, account_id, workspace_id, client_version, hostname, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         status = COALESCE($7, installations.status),
         client_version = COALESCE($5, installations.client_version),
         hostname = COALESCE($6, installations.hostname),
         updated_at = $9`,
      [
        installation.id,
        installation.deviceId,
        installation.accountId,
        installation.workspaceId,
        installation.clientVersion ?? "1.0.0",
        installation.hostname ?? "localhost",
        installation.status ?? "registered",
        now,
        now,
      ],
    );
    return (await this.getInstallation(installation.id))!;
  }

  async revokeInstallation(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE installations SET status = 'revoked', updated_at = $1 WHERE id = $2`,
      [now, id],
    );
    return true;
  }

  async isInstallationRevoked(id: string): Promise<boolean> {
    const inst = await this.getInstallation(id);
    return inst ? inst.status === "revoked" : false;
  }
}
