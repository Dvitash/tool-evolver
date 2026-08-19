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
import {
  FakeToolBrokerClient,
  ValidationSandbox,
} from "../../../src/evolution/testing/validation-sandbox.js";
import { FakeModelProvider, InferenceService } from "../../../src/models/index.js";
import { createMockEnvelope, createMockOpportunity, createMockTenant } from "./helpers.js";

describe("Brokered Tool Synthesis [REM-010]", () => {
  async function setupEnvironment() {
    const pool = new MemoryDatabasePool();
    await runMigrations(pool);

    const fakeProvider = new FakeModelProvider("mock-primary", "Mock Primary Provider");
    const inferenceService = new InferenceService();
    inferenceService.router.registerProvider(fakeProvider);

    const tenant = createMockTenant({
      accountId: "acct-brokered-123",
      workspaceId: "ws-brokered-456",
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
      sandbox: new ValidationSandbox(),
    };
  }

  it("should synthesize a brokered filesystem read/write tool using context.fs", async () => {
    const { tenant, service, sandbox } = await setupEnvironment();

    const opportunity = createMockOpportunity({
      id: "opp_fs_read_write_001",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      triggerReason: "repeated_pattern",
      classification: {
        title: "Workspace File Processor",
        description: "Reads configuration file, updates timestamp, and writes back to workspace",
        taskClass: "file_edit",
        pattern: "file_edit",
        confidenceScore: 0.95,
        priority: "high",
        suggestedToolName: "fs_config_updater",
        inferredInputs: [
          { name: "path", type: "string", description: "Target file path" },
          { name: "content", type: "string", description: "Updated content" },
        ],
      },
    });

    const envelope = createMockEnvelope({
      fs: {
        readPaths: ["./config.json", "./src"],
        writePaths: ["./config.json", "./dist"],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: ["/etc", "/root"],
        maxFileSizeBytes: 1048576,
      },
    });

    const genResult = await service.generateCandidate(tenant, opportunity, { envelope });

    expect(genResult.status).toBe("synthesized");
    expect(genResult.candidate.state).toBe("synthesized");
    expect(genResult.candidate.sourceCode).toBeDefined();

    const sourceCode = genResult.candidate.sourceCode!;
    expect(sourceCode).toContain('from "@tool-evolver/runtime"');
    expect(sourceCode).toContain("broker.fs.writeFile");
    expect(sourceCode).not.toContain('require("fs")');
    expect(sourceCode).not.toContain('from "node:fs"');

    // Capabilities must be minimal and explicit
    expect(genResult.candidate.requiredCapabilities.fs.allowWorkspaceRoot).toBe(true);
    expect(genResult.candidate.requiredCapabilities.net.allowOutbound).toBe(false);
    expect(genResult.candidate.requiredCapabilities.command.allowedCommands).toEqual([]);

    // Execute in sandbox with mock broker
    const mockBroker = new FakeToolBrokerClient({
      fs: {
        files: {
          "config.json": '{"version": 1}',
        },
      },
    });

    const runResult = await sandbox.executeCandidate(
      sourceCode,
      genResult.candidate.proposedTool,
      { path: "config.json", content: '{"version": 2}' },
      mockBroker,
    );

    expect(runResult.error).toBeUndefined();
    expect(runResult.output).toEqual({
      success: true,
      data: {
        filePath: "config.json",
        written: true,
        bytes: 14,
      },
    });
  });

  it("should synthesize an authenticated network tool using non-disclosing secret references", async () => {
    const { tenant, service, sandbox } = await setupEnvironment();

    const opportunity = createMockOpportunity({
      id: "opp_auth_net_001",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      triggerReason: "repeated_pattern",
      classification: {
        title: "GitHub Issue Fetcher",
        description: "Fetches repository issues from GitHub API using Bearer authentication",
        taskClass: "network",
        pattern: "http_auth_fetch",
        confidenceScore: 0.96,
        priority: "high",
        suggestedToolName: "github_issue_fetcher",
        inferredInputs: [{ name: "url", type: "string", description: "GitHub API endpoint" }],
      },
      evidenceEventIds: ["ev_github_token_auth"],
    });

    const envelope = createMockEnvelope({
      net: {
        allowOutbound: true,
        allowedDomains: ["api.github.com"],
        allowedHosts: ["api.github.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      secrets: {
        allowedSecretNames: ["GITHUB_TOKEN"],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
    });

    const genResult = await service.generateCandidate(tenant, opportunity, { envelope });
    expect(genResult.status).toBe("synthesized");
    expect(genResult.candidate.state).toBe("synthesized");

    const sourceCode = genResult.candidate.sourceCode!;
    expect(sourceCode).toContain("broker.secret.createReference");
    expect(sourceCode).toContain("broker.net.fetch");
    expect(sourceCode).not.toContain(".secretValue");
    expect(sourceCode).not.toContain(".value");
    expect(sourceCode).not.toContain("getSecret(");

    expect(genResult.candidate.requiredCapabilities.net.allowOutbound).toBe(true);
    expect(genResult.candidate.requiredCapabilities.secrets.allowedSecretNames).toContain(
      "GITHUB_TOKEN",
    );
    expect(genResult.candidate.requiredCapabilities.secrets.denyDirectRead).toBe(true);
    const mockBroker = new FakeToolBrokerClient({
      secrets: {
        values: {
          GITHUB_TOKEN: "ghp_mockSecretValueDoNotDisclose12345",
        },
      },
      net: {
        routes: {
          "https://api.github.com/repos/owner/repo/issues": {
            status: 200,
            body: [{ id: 1, title: "Found Issue" }],
          },
        },
      },
    });

    const runResult = await sandbox.executeCandidate(
      sourceCode,
      genResult.candidate.proposedTool,
      { url: "https://api.github.com/repos/owner/repo/issues" },
      mockBroker,
    );

    expect(runResult.error).toBeUndefined();
    expect(runResult.output).toEqual({
      success: true,
      data: {
        status: 200,
        data: [{ id: 1, title: "Found Issue" }],
      },
    });
  });

  it("should synthesize an approved command tool using context.cmd with secret env mediation", async () => {
    const { tenant, service, sandbox } = await setupEnvironment();

    const opportunity = createMockOpportunity({
      id: "opp_cmd_exec_001",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      triggerReason: "repeated_pattern",
      classification: {
        title: "Git Status Checker",
        description: "Executes git status with auth token injected via environment",
        taskClass: "command",
        pattern: "vcs_command",
        confidenceScore: 0.92,
        priority: "medium",
        suggestedToolName: "git_status_checker",
        inferredInputs: [{ name: "args", type: "array", description: "Git subcommand arguments" }],
      },
      evidenceEventIds: ["ev_git_token"],
    });

    const envelope = createMockEnvelope({
      command: {
        allowShellExecution: false,
        allowedCommands: ["git"],
        allowedBinaries: ["git"],
        forbiddenPatterns: ["rm -rf", "sudo"],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: ["GITHUB_TOKEN"],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
    });

    const genResult = await service.generateCandidate(tenant, opportunity, { envelope });

    expect(genResult.status).toBe("synthesized");
    const sourceCode = genResult.candidate.sourceCode!;
    expect(sourceCode).toContain("broker.cmd.exec");
    expect(sourceCode).toContain("broker.secret.createReference");

    // Capabilities must forbid shell execution
    expect(genResult.candidate.requiredCapabilities.command.allowShellExecution).toBe(false);
    expect(genResult.candidate.requiredCapabilities.command.allowedBinaries).toContain("git");

    // Execute in sandbox with mock broker
    const mockBroker = new FakeToolBrokerClient({
      secrets: {
        values: {
          GITHUB_TOKEN: "token_abc123",
        },
      },
      cmd: {
        commands: {
          "git status": {
            stdout: "On branch main\nnothing to commit, working tree clean\n",
            exitCode: 0,
          },
          git: {
            stdout: "On branch main\nnothing to commit, working tree clean\n",
            exitCode: 0,
          },
        },
      },
    });

    const runResult = await sandbox.executeCandidate(
      sourceCode,
      genResult.candidate.proposedTool,
      { args: ["status"] },
      mockBroker,
    );

    expect(runResult.error).toBeUndefined();
    expect(runResult.output).toEqual({
      success: true,
      data: {
        stdout: "On branch main\nnothing to commit, working tree clean\n",
        stderr: "",
        exitCode: 0,
      },
    });
  });

  it("should never embed raw private values into schemas, invariants, or parameter documentation", async () => {
    const { tenant, service } = await setupEnvironment();

    const opportunity = createMockOpportunity({
      id: "opp_secrets_safety_001",
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      triggerReason: "repeated_pattern",
      classification: {
        title: "Secure API Query",
        description:
          "Queries external service with confidential Bearer authorization token API_KEY",
        taskClass: "network",
        pattern: "http_secret",
        confidenceScore: 0.97,
        priority: "high",
        suggestedToolName: "secure_api_query",
        inferredInputs: [{ name: "url", type: "string", description: "Target URL" }],
      },
      evidenceEventIds: ["ev_api_key_secret"],
    });

    const genResult = await service.generateCandidate(tenant, opportunity);
    expect(genResult.status).toBe("synthesized");

    const manifest = genResult.candidate.proposedTool;
    const manifestJson = JSON.stringify(manifest);

    // No raw secrets in manifest
    expect(manifestJson).not.toContain("sk_");
    expect(manifestJson).not.toContain("secret_value");
    expect(manifestJson).not.toContain("rawSecret");

    // Parameter schema must only have 'url'
    expect(Object.keys(manifest.parameters.properties)).toEqual(["url"]);
  });
});
