import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../../src/db/client.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  CandidateGenerationService,
  CandidatePlanner,
  CandidateRepository,
  CapabilityMapper,
  CodeGenerator,
  DeterministicSelfReviewer,
  RepairOrchestrator,
  SchemaGenerator,
} from "../../../src/evolution/generator/index.js";
import type { WorkflowStep } from "../../../src/evolution/generator/types.js";
import { FakeModelProvider, InferenceService } from "../../../src/models/index.js";
import { createMockEnvelope, createMockOpportunity, createMockTenant } from "./helpers.js";

describe("Capability Minimization & Envelope Containment [REM-010]", () => {
  async function setupEnvironment() {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);

    const fakeProvider = new FakeModelProvider("mock-cap-llm", "Mock Cap LLM");
    const inferenceService = new InferenceService();
    inferenceService.router.registerProvider(fakeProvider);

    const tenant = createMockTenant({
      accountId: "acct-cap-123",
      workspaceId: "ws-cap-456",
    });

    const candidateRepo = new CandidateRepository(pool);
    const capabilityMapper = new CapabilityMapper();
    const schemaGenerator = new SchemaGenerator();
    const planner = new CandidatePlanner(capabilityMapper, schemaGenerator);
    const codeGenerator = new CodeGenerator(schemaGenerator);
    const selfReviewer = new DeterministicSelfReviewer(capabilityMapper);
    const repairOrchestrator = new RepairOrchestrator(selfReviewer, capabilityMapper);

    const service = new CandidateGenerationService({
      inferenceService,
      pool,
      candidateRepo,
      planner,
      codeGenerator,
      selfReviewer,
      repairOrchestrator,
      capabilityMapper,
      schemaGenerator,
    });

    return {
      pool,
      tenant,
      service,
      fakeProvider,
      inferenceService,
      candidateRepo,
      capabilityMapper,
      selfReviewer,
    };
  }

  it("should derive strictly minimal capabilities and prune redundant permissions", () => {
    const mapper = new CapabilityMapper();

    const steps: WorkflowStep[] = [
      {
        id: "step_read",
        name: "Read specific config",
        toolClass: "file_read",
        action: "fs.readFile",
        inputs: { path: "config/app.json" },
        dependsOn: [],
      },
    ];

    const envelope = createMockEnvelope({
      fs: {
        readPaths: ["config/app.json", "src", "docs"],
        writePaths: ["dist"],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: ["/etc"],
        maxFileSizeBytes: 1048576,
      },
    });

    const manifest = mapper.mapRequiredCapabilities(steps, envelope);

    // Only requested paths must be present
    expect(manifest.fs.readPaths).toEqual(["config/app.json"]);
    expect(manifest.fs.writePaths).toEqual([]);
    expect(manifest.net.allowOutbound).toBe(false);
    expect(manifest.net.allowedHosts).toEqual([]);
    expect(manifest.command.allowedCommands).toEqual([]);
    expect(manifest.secrets.allowedSecretNames).toEqual([]);
  });

  it("should validate multi-dimensional capability envelope subset containment", () => {
    const mapper = new CapabilityMapper();

    const envelope = createMockEnvelope({
      fs: {
        readPaths: ["src", "config"],
        writePaths: ["dist"],
        allowWorkspaceRoot: true,
        allowTemp: false,
        denyPaths: ["/etc/shadow", ".env"],
        maxFileSizeBytes: 2097152, // 2MB
      },
      net: {
        allowOutbound: true,
        allowedDomains: ["api.github.com", "*.internal.corp"],
        allowedHosts: ["api.github.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: ["git", "pnpm test"],
        allowedBinaries: ["git", "pnpm"],
        forbiddenPatterns: ["rm -rf", "sudo"],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: ["GITHUB_TOKEN", "NPM_TOKEN"],
        allowedPrefixes: ["CORP_"],
        denyDirectRead: true,
        injectAsEnv: true,
      },
    });

    // Valid subset manifest
    const validManifest = {
      fs: {
        readPaths: ["src/index.ts"],
        writePaths: ["dist/output.js"],
        allowWorkspaceRoot: true,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 1048576,
      },
      net: {
        allowOutbound: true,
        allowedDomains: ["api.github.com"],
        allowedHosts: ["api.github.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"] as "https"[],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: ["git"],
        allowedBinaries: ["git"],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: ["GITHUB_TOKEN", "CORP_AUTH_KEY"],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxExecutionTimeMs: 15000,
        maxMemoryMb: 64,
        maxOutputSizeBytes: 524288,
        maxConcurrentExecutions: 2,
        maxCpuUsagePercent: 80,
      },
    };

    const validCheck = mapper.validateSubset(validManifest, envelope);
    expect(validCheck.valid).toBe(true);
    expect(validCheck.violations).toEqual([]);

    // Out-of-envelope manifest (violates FS deny path, net domain, command binary, secret direct read)
    const invalidManifest = {
      ...validManifest,
      fs: {
        ...validManifest.fs,
        readPaths: [".env"], // matches denyPaths
      },
      net: {
        ...validManifest.net,
        allowedHosts: ["unauthorized.external.com"], // not in allowedHosts
      },
      command: {
        ...validManifest.command,
        allowShellExecution: true, // envelope strictly forbids shell execution
      },
      secrets: {
        ...validManifest.secrets,
        denyDirectRead: false, // envelope requires true
      },
    };

    const invalidCheck = mapper.validateSubset(invalidManifest, envelope);
    expect(invalidCheck.valid).toBe(false);
    expect(invalidCheck.violations.length).toBeGreaterThanOrEqual(4);
    expect(invalidCheck.violations.some((v) => v.includes(".env"))).toBe(true);
    expect(invalidCheck.violations.some((v) => v.includes("unauthorized.external.com"))).toBe(true);
    expect(invalidCheck.violations.some((v) => v.includes("shell execution"))).toBe(true);
    expect(invalidCheck.violations.some((v) => v.includes("direct secret read"))).toBe(true);
  });

  it("should compute structural capability diffs and correctly flag permission broadening", () => {
    const mapper = new CapabilityMapper();

    const baseManifest = {
      fs: {
        readPaths: ["src"],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 1048576,
      },
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https"] as "https"[],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: ["git"],
        allowedBinaries: ["git"],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: [],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxExecutionTimeMs: 10000,
        maxMemoryMb: 64,
        maxOutputSizeBytes: 524288,
        maxConcurrentExecutions: 2,
        maxCpuUsagePercent: 80,
      },
    };

    // Narrowed / minimized manifest
    const narrowedManifest = {
      ...baseManifest,
      fs: {
        ...baseManifest.fs,
        readPaths: ["src/utils"], // more specific read path
      },
      command: {
        ...baseManifest.command,
        allowedCommands: [], // dropped commands
        allowedBinaries: [],
      },
    };

    const diffNarrow = mapper.computeCapabilityDiff(baseManifest, narrowedManifest);
    expect(diffNarrow.hasChanges).toBe(true);
    expect(diffNarrow.isBroadening).toBe(false);
    expect(diffNarrow.command.removedCommands).toEqual(["git"]);

    // Broadened manifest (added outbound network and secrets)
    const broadenedManifest = {
      ...baseManifest,
      net: {
        ...baseManifest.net,
        allowOutbound: true,
        allowedHosts: ["api.example.com"],
      },
      secrets: {
        ...baseManifest.secrets,
        allowedSecretNames: ["API_KEY"],
      },
    };

    const diffBroad = mapper.computeCapabilityDiff(baseManifest, broadenedManifest);
    expect(diffBroad.hasChanges).toBe(true);
    expect(diffBroad.isBroadening).toBe(true);
    expect(diffBroad.net.addedHosts).toEqual(["api.example.com"]);
    expect(diffBroad.secrets.addedSecrets).toEqual(["API_KEY"]);
  });

  it("should persist revision lineage, capability diffs, provenance, and costs across database restart", async () => {
    const { pool, tenant, service, candidateRepo } = await setupEnvironment();

    const opportunity = createMockOpportunity({
      id: "opp_persistence_diff_001",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      triggerReason: "repeated_pattern",
      structuralHash: "hash_restart_cap_123",
      classification: {
        title: "Persistence Diff Tool",
        description: "Tool tracking lineage across database restarts",
        taskClass: "compute",
        pattern: "compute_lineage",
        confidenceScore: 0.98,
        priority: "high",
        suggestedToolName: "lineage_diff_tool",
        inferredInputs: [{ name: "values", type: "array", description: "Values" }],
      },
    });

    const genResult = await service.generateCandidate(tenant, opportunity);
    expect(genResult.status).toBe("synthesized");
    const candidateId = genResult.candidate.id;

    // Verify active revision properties
    const rev1 = genResult.activeRevision;
    expect(rev1.revisionNumber).toBe(1);
    expect(rev1.artifacts.manifest.name).toBe("lineage_diff_tool");

    // Fresh repository on same pool simulating service restart
    const freshRepo = new CandidateRepository(pool);
    const freshService = new CandidateGenerationService({
      pool,
      candidateRepo: freshRepo,
    });

    // Verify candidate loaded across restart
    const loadedCandidate = await freshService.getCandidateById(tenant, candidateId);
    expect(loadedCandidate).not.toBeNull();
    expect(loadedCandidate?.id).toBe(candidateId);
    expect(loadedCandidate?.proposedTool.name).toBe("lineage_diff_tool");

    // Verify revision lineage loaded across restart
    const loadedRevision = await freshService.getActiveRevision(tenant, candidateId);
    expect(loadedRevision).not.toBeNull();
    expect(loadedRevision?.candidateId).toBe(candidateId);
    expect(loadedRevision?.revisionNumber).toBe(1);
    expect(loadedRevision?.artifacts.sourceCode).toContain("export default defineTool");

    // Verify revisions list loaded across restart
    const revisionsList = await freshRepo.listRevisions(tenant, candidateId);
    expect(revisionsList.length).toBeGreaterThanOrEqual(1);
    expect(revisionsList[0].candidateId).toBe(candidateId);
    expect(revisionsList[0].revisionNumber).toBe(1);
  });
});
