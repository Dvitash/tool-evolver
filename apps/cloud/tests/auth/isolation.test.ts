import { describe, expect, it } from "vitest";
import { AuthService, createAuthService } from "../../src/auth/index.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool } from "../../src/db/index.js";
import { MemoryDurableQueue } from "../../src/queue/index.js";
import { CloudServer, createCloudServer } from "../../src/server/index.js";
import { MemoryObjectStore } from "../../src/storage/index.js";
import { TenantGuard, runWithTenant } from "../../src/tenant.js";

describe("Workspace & Tenant Membership Isolation", () => {
  it("should enforce tenant boundaries and prevent cross-account access", async () => {
    const tenantA = {
      accountId: "acc_tenant_aaa",
      workspaceId: "ws_tenant_aaa",
    };

    const tenantB = {
      accountId: "acc_tenant_bbb",
      workspaceId: "ws_tenant_bbb",
    };

    // Inside Tenant A context
    await runWithTenant(tenantA, async () => {
      // Accessing Tenant A resource should succeed
      expect(() => {
        TenantGuard.assertAccess({ accountId: "acc_tenant_aaa", workspaceId: "ws_tenant_aaa" });
      }).not.toThrow();

      // Accessing Tenant B resource should throw TenantAccessDeniedError
      expect(() => {
        TenantGuard.assertAccess({ accountId: "acc_tenant_bbb", workspaceId: "ws_tenant_bbb" });
      }).toThrow(/Cross-account access denied/i);
    });
  });

  it("should isolate data access between accounts via authenticated HTTP requests", async () => {
    const dbPool = new MemoryDatabasePool();
    const objectStore = new MemoryObjectStore();
    const queue = new MemoryDurableQueue();
    const authService = createAuthService();

    const config = loadConfig({
      server: { port: 0, host: "127.0.0.1" },
    });

    const server = createCloudServer({
      config,
      dbPool,
      objectStore,
      queue,
      authService,
    });

    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Issue tokens for Tenant A and Tenant B
      const tokenA = authService.tokens.issueAccessToken({
        accountId: "acc_tenant_aaa",
        workspaceId: "ws_tenant_aaa",
        deviceId: "dev_aaa",
        installationId: "inst_aaa",
        scopes: ["device:connect", "artifacts:read"],
      });

      const tokenB = authService.tokens.issueAccessToken({
        accountId: "acc_tenant_bbb",
        workspaceId: "ws_tenant_bbb",
        deviceId: "dev_bbb",
        installationId: "inst_bbb",
        scopes: ["device:connect", "artifacts:read"],
      });

      // 2. Tenant A creates a device
      const createResA = await fetch(`${baseUrl}/v1/devices`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "dev-isolated-aaa",
          name: "Tenant A Device",
        }),
      });
      expect(createResA.status).toBe(201);

      // 3. Tenant B lists devices -> Tenant B should NOT see Tenant A's device
      const listResB = await fetch(`${baseUrl}/v1/devices`, {
        headers: {
          Authorization: `Bearer ${tokenB.accessToken}`,
        },
      });
      expect(listResB.status).toBe(200);
      const listDataB = (await listResB.json()) as { devices: Array<{ id: string }> };
      const foundAInB = listDataB.devices.some((d) => d.id === "dev-isolated-aaa");
      expect(foundAInB).toBe(false);

      // 4. Tenant A uploads an object
      const putObjResA = await fetch(`${baseUrl}/v1/objects/secret-report.json`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenA.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ secret: "Tenant A Data" }),
      });
      expect([200, 201]).toContain(putObjResA.status);

      // 5. Tenant B attempts to read the same object key -> should get 404 (isolated namespace)
      const getObjResB = await fetch(`${baseUrl}/v1/objects/secret-report.json`, {
        headers: {
          Authorization: `Bearer ${tokenB.accessToken}`,
        },
      });
      expect(getObjResB.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
