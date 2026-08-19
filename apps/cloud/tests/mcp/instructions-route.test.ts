import { describe, expect, it } from "vitest";
import { createCloudService } from "../../src/index.js";

describe("GET /v1/evolution/catalog/instructions endpoint", () => {
  const tenantHeaders = {
    "x-account-id": "acc-inst-1",
    "x-workspace-id": "ws-inst-1",
  };

  it("returns comment block when catalog is empty or has no evolved tools", async () => {
    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
        environment: "development",
      },
    });

    await cloud.initialize();
    const port = await cloud.server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${baseUrl}/v1/evolution/catalog/instructions`, {
        headers: tenantHeaders,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { markdown: string };
      expect(data).toHaveProperty("markdown");
      expect(data.markdown).toContain("<!-- No evolved tools currently active in this workspace catalog. -->");
    } finally {
      await cloud.shutdown();
    }
  });

  it("returns markdown containing tool name and description when catalog contains an evolved tool", async () => {
    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
        environment: "development",
      },
    });

    await cloud.initialize();

    // Register an evolved tool in the catalog
    cloud.catalogService.registerTool({
      name: "git_status_checker",
      description:
        "Inspects Git working tree status. Use this instead of running: git status --porcelain — one call replaces the repeated command(s).",
      source: "registry",
      scope: "workspace",
      inputSchema: {
        type: "object",
        properties: {
          targetPaths: {
            type: "array",
            description: "Target paths to inspect",
          },
        },
        required: ["targetPaths"],
      },
      handler: async () => ({ content: [], isError: false }),
    });

    // Populate catalog snapshot for the workspace
    await cloud.catalogService.getCatalogSnapshot({
      accountId: tenantHeaders["x-account-id"],
      workspaceId: tenantHeaders["x-workspace-id"],
    });

    const port = await cloud.server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${baseUrl}/v1/evolution/catalog/instructions`, {
        headers: tenantHeaders,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { markdown: string };
      expect(data).toHaveProperty("markdown");
      expect(data.markdown).toContain("## Evolved Tools");
      expect(data.markdown).toContain("git_status_checker");
      expect(data.markdown).toContain(
        "Inspects Git working tree status. Use this instead of running: git status --porcelain — one call replaces the repeated command(s).",
      );
      expect(data.markdown).toContain("targetPaths (array, required): Target paths to inspect");
    } finally {
      await cloud.shutdown();
    }
  });
});
