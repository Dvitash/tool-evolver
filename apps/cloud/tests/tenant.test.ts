import { describe, expect, it } from "vitest";
import {
  TenantAccessDeniedError,
  TenantContext,
  TenantContextMissingError,
  TenantGuard,
  getTenantContext,
  requireTenantContext,
  runWithTenant,
} from "../src/tenant.js";

describe("Tenant Context & TenantGuard", () => {
  it("should propagate tenant context using AsyncLocalStorage", async () => {
    const context: TenantContext = {
      accountId: "acc-123",
      workspaceId: "ws-456",
      userId: "usr-789",
      traceId: "trace-abc",
    };

    expect(getTenantContext()).toBeUndefined();
    expect(() => requireTenantContext()).toThrow(TenantContextMissingError);

    await runWithTenant(context, async () => {
      const active = getTenantContext();
      expect(active).toBeDefined();
      expect(active?.accountId).toBe("acc-123");
      expect(active?.workspaceId).toBe("ws-456");
      expect(active?.userId).toBe("usr-789");
      expect(requireTenantContext().traceId).toBe("trace-abc");
    });

    expect(getTenantContext()).toBeUndefined();
  });

  it("should enforce tenant access boundaries with TenantGuard (deny-by-default)", async () => {
    const tenantA: TenantContext = {
      accountId: "acc-alpha",
      workspaceId: "ws-alpha-1",
    };

    await runWithTenant(tenantA, async () => {
      // Same account and workspace: allowed
      expect(() => {
        TenantGuard.assertAccess({ accountId: "acc-alpha", workspaceId: "ws-alpha-1" });
      }).not.toThrow();

      // Same account, no workspace specified on resource: allowed
      expect(() => {
        TenantGuard.assertAccess({ accountId: "acc-alpha" });
      }).not.toThrow();

      // Cross-account access: denied
      expect(() => {
        TenantGuard.assertAccess({ accountId: "acc-beta", workspaceId: "ws-alpha-1" });
      }).toThrow(TenantAccessDeniedError);

      // Cross-workspace access: denied
      expect(() => {
        TenantGuard.assertAccess({ accountId: "acc-alpha", workspaceId: "ws-alpha-2" });
      }).toThrow(TenantAccessDeniedError);
    });
  });

  it("should enforce scope and return entity when valid", async () => {
    const context: TenantContext = {
      accountId: "acc-corp",
      workspaceId: "ws-dev",
    };

    await runWithTenant(context, async () => {
      const resource = {
        accountId: "acc-corp",
        workspaceId: "ws-dev",
        payload: "safe-data",
      };

      const result = TenantGuard.enforceScope(resource);
      expect(result).toBe(resource);
    });
  });

  it("should scope database query parameters with active tenant context", async () => {
    const context: TenantContext = {
      accountId: "acc-777",
      workspaceId: "ws-888",
    };

    await runWithTenant(context, async () => {
      const baseParams = { name: "Tool A", status: "active" };
      const scoped = TenantGuard.scopeParams(baseParams);

      expect(scoped).toEqual({
        name: "Tool A",
        status: "active",
        accountId: "acc-777",
        workspaceId: "ws-888",
      });
    });
  });

  it("should execute wrapQuery with required tenant context", async () => {
    const context: TenantContext = {
      accountId: "acc-999",
      workspaceId: "ws-000",
    };

    const res = await runWithTenant(context, async () => {
      return TenantGuard.wrapQuery(async (t) => {
        return `Query for account ${t.accountId} on workspace ${t.workspaceId}`;
      });
    });

    expect(res).toBe("Query for account acc-999 on workspace ws-000");
  });
});
