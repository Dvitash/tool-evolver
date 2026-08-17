/**
 * @tool-evolver/cloud - Cloud Catalog Service Tests
 */

import { describe, expect, it } from "vitest";
import {
  CloudCatalogService,
  createCloudCatalogService,
} from "../../src/mcp/index.js";
import { MemoryDatabasePool, OutboxRepository } from "../../src/db/index.js";
import type { StreamCatalogInvalidation } from "@tool-evolver/protocol";

describe("CloudCatalogService - Snapshots, Revisions & Invalidation", () => {
  const tenant = {
    accountId: "acc-cat-1",
    workspaceId: "ws-cat-1",
  };

  it("generates deterministic versioned snapshots with canonical checksums", async () => {
    const service = createCloudCatalogService();
    const snapshot1 = await service.getCatalogSnapshot(tenant);

    expect(snapshot1.snapshotVersion).toMatch(/^v1-[a-f0-9]{12}$/);
    expect(snapshot1.checksum).toHaveLength(64);
    expect(snapshot1.tools.length).toBeGreaterThanOrEqual(4);
    expect(snapshot1.activeDeployments.length).toBe(snapshot1.tools.length);

    // Fetch again without modifications: checksum must be identical
    const snapshot2 = await service.getCatalogSnapshot(tenant);
    expect(snapshot2.checksum).toBe(snapshot1.checksum);
    expect(snapshot2.snapshotVersion).toBe(snapshot1.snapshotVersion);
  });

  it("increments revision and emits invalidation events on catalog invalidation", async () => {
    const dbPool = new MemoryDatabasePool();
    const service = createCloudCatalogService({ dbPool });

    const receivedEvents: StreamCatalogInvalidation[] = [];
    service.onInvalidation((event) => {
      receivedEvents.push(event);
    });

    const initialRevision = service.getSnapshotRevision(tenant.workspaceId);
    expect(initialRevision).toBe(1);

    // Invalidate catalog
    await service.invalidateWorkspaceCatalog(tenant, "version_published", ["new_tool_1"]);

    // Revision must have incremented
    const nextRevision = service.getSnapshotRevision(tenant.workspaceId);
    expect(nextRevision).toBe(2);

    // Invalidation event received by listener
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe("server.catalog_invalidation");
    expect(receivedEvents[0].workspaceId).toBe(tenant.workspaceId);
    expect(receivedEvents[0].toolIds).toEqual(["new_tool_1"]);
    expect(receivedEvents[0].reason).toBe("version_published");

    // Outbox record persisted
    const outboxRows = await dbPool.query<{
      event_type: string;
      workspace_id: string;
      payload: string;
    }>("SELECT * FROM outbox WHERE workspace_id = $1", [tenant.workspaceId]);

    expect(outboxRows.rows.length).toBeGreaterThanOrEqual(1);
    expect(outboxRows.rows[0].event_type).toBe("catalog.invalidated");
  });

  it("supports dynamic tool provider registration", async () => {
    const service = createCloudCatalogService();

    service.registerProvider({
      name: "custom-provider",
      getTools: async (t) => [
        {
          name: "dynamic_tool_x",
          description: "A dynamically provided tool",
          source: "model",
          scope: "workspace",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          handler: async (p) => ({
            content: [{ type: "text", text: `dynamic result for ${p.q}` }],
            isError: false,
          }),
        },
      ],
      getTool: async (t, name) => {
        if (name === "dynamic_tool_x") {
          return {
            name: "dynamic_tool_x",
            description: "A dynamically provided tool",
            source: "model",
            scope: "workspace",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            handler: async (p) => ({
              content: [{ type: "text", text: `dynamic result for ${p.q}` }],
              isError: false,
            }),
          };
        }
        return null;
      },
    });

    const tools = await service.getTools(tenant);
    const names = tools.map((t) => t.name);
    expect(names).toContain("dynamic_tool_x");

    const tool = await service.getTool(tenant, "dynamic_tool_x");
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("dynamic_tool_x");
  });

  it("filters tools by scope when filterScopes is specified", async () => {
    const service = createCloudCatalogService();
    service.registerTool({
      name: "workspace_tool_y",
      description: "Workspace tool",
      source: "registry",
      scope: "workspace",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ content: [], isError: false }),
    });

    const fullSnapshot = await service.getCatalogSnapshot(tenant);
    expect(fullSnapshot.tools.map((t) => t.id)).toContain("workspace_tool_y");

    const platformOnlySnapshot = await service.getCatalogSnapshot(tenant, undefined, ["platform"]);
    // Platform tools like echo are kept, workspace_tool_y is filtered out
    expect(platformOnlySnapshot.tools.map((t) => t.id)).toContain("echo");
    expect(platformOnlySnapshot.tools.map((t) => t.id)).not.toContain("workspace_tool_y");
  });
});
