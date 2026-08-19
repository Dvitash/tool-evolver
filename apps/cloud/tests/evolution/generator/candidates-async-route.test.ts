import { describe, expect, it } from "vitest";
import { OpportunityRepository } from "../../../src/evolution/opportunity/repositories/opportunity-repository.js";
import { createCloudService } from "../../../src/index.js";
import { createMockOpportunity, createMockTenant } from "./helpers.js";

describe("Async Candidate Generation Routes", () => {
  it("enqueues candidate generation, processes via worker, and serves candidate via GET /v1/evolution/candidates", async () => {
    const tenant = createMockTenant({
      accountId: "acct-test-async",
      workspaceId: "ws-test-async",
    });

    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
        models: { allowDeterministicFallback: true },
      },
    });

    await cloud.initialize();
    const port = await cloud.start(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const oppRepo = new OpportunityRepository(cloud.dbPool);
      const opportunity = createMockOpportunity({
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        status: "eligible",
        classification: {
          title: "Async Test Tool",
          description: "Async test tool description",
          suggestedToolName: "async_test_tool",
          taskClass: "compute",
          pattern: "compute.transform",
          confidenceScore: 0.95,
          priority: "high",
          inferredInputs: [{ name: "inputData", type: "string", description: "Input data" }],
        },
      });
      await oppRepo.saveOpportunity(tenant, opportunity);

      // 1. POST /v1/evolution/candidates/generate
      const postRes = await fetch(`${baseUrl}/v1/evolution/candidates/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({
          opportunityId: opportunity.id,
        }),
      });

      expect(postRes.status).toBe(202);
      const postBody = (await postRes.json()) as { jobId: string; opportunityId: string };
      expect(postBody.jobId).toBeDefined();
      expect(postBody.opportunityId).toBe(opportunity.id);

      interface PolledCandidate {
        id: string;
        status: string;
        toolName: string;
        sourceCode?: string;
        activeRevision?: { sourceCode: string };
      }
      let attempts = 0;
      let foundCandidate: PolledCandidate | null = null;
      while (attempts < 30) {
        const getRes = await fetch(
          `${baseUrl}/v1/evolution/candidates?opportunityId=${encodeURIComponent(opportunity.id)}`,
          {
            headers: {
              "x-account-id": tenant.accountId,
              "x-workspace-id": tenant.workspaceId,
            },
          },
        );
        expect(getRes.status).toBe(200);
        const getBody = (await getRes.json()) as {
          candidates: PolledCandidate[];
        };

        if (getBody.candidates.length > 0) {
          foundCandidate = getBody.candidates[0];
          break;
        }
        // Integration test polling interval for async worker execution
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 50);
        await promise;
        attempts++;
      }

      expect(foundCandidate).toBeDefined();
      expect(foundCandidate.id).toBeDefined();
      expect(foundCandidate.status).toBe("synthesized");
      expect(foundCandidate.toolName).toBe("async_test_tool");
      expect(foundCandidate.sourceCode).toBeDefined();
      expect(foundCandidate.sourceCode).toContain("defineTool");
    } finally {
      await cloud.shutdown();
    }
  });

  it("returns the same jobId on duplicate POST for the same opportunityId while pending (idempotency)", async () => {
    const tenant = createMockTenant({
      accountId: "acct-test-idemp",
      workspaceId: "ws-test-idemp",
    });

    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
        models: { allowDeterministicFallback: true },
      },
    });

    await cloud.initialize();
    const port = await cloud.start(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const oppRepo = new OpportunityRepository(cloud.dbPool);
      const opportunity = createMockOpportunity({
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        status: "eligible",
        classification: {
          title: "Idempotent Test Tool",
          description: "Idempotent test tool",
          suggestedToolName: "idemp_test_tool",
          taskClass: "compute",
          pattern: "compute.transform",
          confidenceScore: 0.9,
          priority: "medium",
          inferredInputs: [{ name: "data", type: "string", description: "Data input" }],
        },
      });
      await oppRepo.saveOpportunity(tenant, opportunity);

      // First POST
      const res1 = await fetch(`${baseUrl}/v1/evolution/candidates/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({ opportunityId: opportunity.id }),
      });
      expect(res1.status).toBe(202);
      const body1 = (await res1.json()) as { jobId: string; opportunityId: string };

      // Second POST immediately with same opportunityId
      const res2 = await fetch(`${baseUrl}/v1/evolution/candidates/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({ opportunityId: opportunity.id }),
      });
      expect(res2.status).toBe(202);
      const body2 = (await res2.json()) as { jobId: string; opportunityId: string };

      expect(body2.jobId).toBe(body1.jobId);
    } finally {
      await cloud.shutdown();
    }
  });

  it("handles error cases: missing opportunityId, not found, or ineligible", async () => {
    const tenant = createMockTenant({
      accountId: "acct-test-err",
      workspaceId: "ws-test-err",
    });

    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
      },
    });

    await cloud.initialize();
    const port = await cloud.start(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Missing opportunityId -> 400
      const res400 = await fetch(`${baseUrl}/v1/evolution/candidates/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({}),
      });
      expect(res400.status).toBe(400);

      // 2. Not found -> 404
      const res404 = await fetch(`${baseUrl}/v1/evolution/candidates/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({ opportunityId: "non-existent-opp" }),
      });
      expect(res404.status).toBe(404);

      // 3. Ineligible -> 409
      const oppRepo = new OpportunityRepository(cloud.dbPool);
      const suppressedOpp = createMockOpportunity({
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        status: "suppressed",
      });
      await oppRepo.saveOpportunity(tenant, suppressedOpp);

      const res409 = await fetch(`${baseUrl}/v1/evolution/candidates/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-account-id": tenant.accountId,
          "x-workspace-id": tenant.workspaceId,
        },
        body: JSON.stringify({ opportunityId: suppressedOpp.id }),
      });
      expect(res409.status).toBe(409);
    } finally {
      await cloud.shutdown();
    }
  });
});
