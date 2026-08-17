import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tenant context propagating through execution pipelines.
 */
export interface TenantContext {
  accountId: string;
  workspaceId: string;
  userId?: string;
  deviceId?: string;
  roles?: string[];
  traceId?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Error raised when tenant context is required but missing from current execution storage.
 */
export class TenantContextMissingError extends Error {
  readonly code = "TENANT_CONTEXT_MISSING";
  constructor(message = "Tenant context is required but was not found in active execution scope") {
    super(message);
    this.name = "TenantContextMissingError";
  }
}

/**
 * Error raised when access to a resource belonging to a different tenant is denied.
 */
export class TenantAccessDeniedError extends Error {
  readonly code = "TENANT_ACCESS_DENIED";
  readonly accountId?: string;
  readonly workspaceId?: string;
  readonly targetAccountId?: string;
  readonly targetWorkspaceId?: string;

  constructor(
    message: string,
    details?: {
      accountId?: string;
      workspaceId?: string;
      targetAccountId?: string;
      targetWorkspaceId?: string;
    },
  ) {
    super(message);
    this.name = "TenantAccessDeniedError";
    this.accountId = details?.accountId;
    this.workspaceId = details?.workspaceId;
    this.targetAccountId = details?.targetAccountId;
    this.targetWorkspaceId = details?.targetWorkspaceId;
  }
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Execute an asynchronous function within a specific tenant context.
 */
export function runWithTenant<T>(context: TenantContext, fn: () => Promise<T> | T): Promise<T> {
  return tenantStorage.run(context, async () => fn());
}

/**
 * Retrieve the current tenant context, or undefined if not running within a tenant scope.
 */
export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Retrieve the current tenant context, throwing TenantContextMissingError if not set.
 */
export function requireTenantContext(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx || !ctx.accountId || !ctx.workspaceId) {
    throw new TenantContextMissingError();
  }
  return ctx;
}

/**
 * Tenant Guard: Enforces account and workspace boundaries on all operations (deny-by-default).
 */
export class TenantGuard {
  /**
   * Assert that the active tenant context has permission to access a target resource.
   */
  static assertAccess(
    resource: { accountId: string; workspaceId?: string },
    explicitContext?: TenantContext,
  ): void {
    const current = explicitContext ?? requireTenantContext();

    if (current.accountId !== resource.accountId) {
      throw new TenantAccessDeniedError(
        `Cross-account access denied: active account '${current.accountId}' cannot access resource for account '${resource.accountId}'`,
        {
          accountId: current.accountId,
          workspaceId: current.workspaceId,
          targetAccountId: resource.accountId,
          targetWorkspaceId: resource.workspaceId,
        },
      );
    }

    if (resource.workspaceId && current.workspaceId !== resource.workspaceId) {
      throw new TenantAccessDeniedError(
        `Cross-workspace access denied: active workspace '${current.workspaceId}' cannot access resource for workspace '${resource.workspaceId}'`,
        {
          accountId: current.accountId,
          workspaceId: current.workspaceId,
          targetAccountId: resource.accountId,
          targetWorkspaceId: resource.workspaceId,
        },
      );
    }
  }

  /**
   * Enforce tenant boundary on a resource entity, returning the entity if valid or throwing.
   */
  static enforceScope<T extends { accountId: string; workspaceId?: string }>(
    entity: T,
    explicitContext?: TenantContext,
  ): T {
    this.assertAccess(entity, explicitContext);
    return entity;
  }

  /**
   * Injects tenant scope parameters (accountId and workspaceId) into a query parameters map.
   */
  static scopeParams(
    params: Record<string, unknown> = {},
    explicitContext?: TenantContext,
  ): Record<string, unknown> {
    const current = explicitContext ?? requireTenantContext();
    return {
      ...params,
      accountId: current.accountId,
      workspaceId: current.workspaceId,
    };
  }

  /**
   * Execute a query callback with guaranteed tenant context.
   */
  static async wrapQuery<T>(queryFn: (tenant: TenantContext) => Promise<T>): Promise<T> {
    const tenant = requireTenantContext();
    return queryFn(tenant);
  }
}
