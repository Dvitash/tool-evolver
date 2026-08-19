import { describe, expect, it } from "vitest";
import { CapabilityMapper } from "../../../src/evolution/generator/capability-mapper.js";
import type { WorkflowStep } from "../../../src/evolution/generator/types.js";
import { createMockEnvelope } from "./helpers.js";

describe("CapabilityMapper", () => {
  const mapper = new CapabilityMapper();

  it("should map minimal filesystem read and write capabilities", () => {
    const steps: WorkflowStep[] = [
      {
        id: "step_1",
        name: "Read file",
        toolClass: "file_read",
        action: "fs.readFile",
        inputs: { path: "src/index.ts" },
        dependsOn: [],
      },
      {
        id: "step_2",
        name: "Write file",
        toolClass: "file_edit",
        action: "fs.writeFile",
        inputs: { path: "dist/bundle.js", content: "data" },
        dependsOn: ["step_1"],
      },
    ];

    const manifest = mapper.mapRequiredCapabilities(steps);

    expect(manifest.fs.allowWorkspaceRoot).toBe(true);
    expect(manifest.fs.readPaths).toContain("src/index.ts");
    expect(manifest.fs.writePaths).toContain("dist/bundle.js");
    expect(manifest.net.allowOutbound).toBe(false);
    expect(manifest.command.allowedBinaries).toHaveLength(0);
  });

  it("should map network capabilities from fetch actions and extract domains/protocols", () => {
    const steps: WorkflowStep[] = [
      {
        id: "step_net",
        name: "Fetch API",
        toolClass: "network",
        action: "net.fetch",
        inputs: { url: "https://api.github.com:443/repos/owner/repo" },
        dependsOn: [],
      },
    ];

    const manifest = mapper.mapRequiredCapabilities(steps);

    expect(manifest.net.allowOutbound).toBe(true);
    expect(manifest.net.allowedDomains).toContain("api.github.com");
    expect(manifest.net.allowedProtocols).toContain("https");
  });

  it("should map command capabilities and extract binary names", () => {
    const steps: WorkflowStep[] = [
      {
        id: "step_cmd",
        name: "Run test suite",
        toolClass: "test_runner",
        action: "cmd.exec",
        inputs: { command: "pnpm test --run" },
        dependsOn: [],
      },
    ];

    const manifest = mapper.mapRequiredCapabilities(steps);

    expect(manifest.command.allowedBinaries).toContain("pnpm");
    expect(manifest.command.allowedCommands).toContain("pnpm test --run");
    expect(manifest.command.allowShellExecution).toBe(false);
  });

  it("should map secret capabilities from getSecret action", () => {
    const steps: WorkflowStep[] = [
      {
        id: "step_sec",
        name: "Read API token",
        toolClass: "secrets",
        action: "secret.getSecret",
        inputs: { name: "GITHUB_TOKEN" },
        dependsOn: [],
      },
    ];

    const manifest = mapper.mapRequiredCapabilities(steps);

    expect(manifest.secrets.allowedSecretNames).toContain("GITHUB_TOKEN");
  });

  it("should clamp capabilities when envelope restricts permissions", () => {
    const envelope = createMockEnvelope({
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedBinaries: ["node"],
        allowedCommands: ["node -v"],
        forbiddenPatterns: ["rm -rf"],
        allowEnvPassthrough: [],
      },
    });

    const steps: WorkflowStep[] = [
      {
        id: "step_net",
        name: "Fetch data",
        toolClass: "network",
        action: "net.fetch",
        inputs: { url: "https://untrusted.com" },
        dependsOn: [],
      },
    ];

    const manifest = mapper.mapRequiredCapabilities(steps, envelope);

    expect(manifest.net.allowOutbound).toBe(false);
  });
});

describe("CapabilityMapper composite command derivation", () => {
  it("splits composite shell strings into per-segment commands and binaries", () => {
    const mapper = new CapabilityMapper();
    const steps: WorkflowStep[] = [
      {
        id: "step_cmd",
        name: "Run git workflow",
        toolClass: "command",
        action: "cmd.exec",
        service: "cmd",
        inputs: { command: "git log --oneline -5 && git status --porcelain" },
        dependsOn: [],
      },
    ];

    const manifest = mapper.mapRequiredCapabilities(steps);

    expect(manifest.command.allowedCommands).toContain("git log --oneline -5");
    expect(manifest.command.allowedCommands).toContain("git status --porcelain");
    expect(manifest.command.allowedCommands).not.toContain(
      "git log --oneline -5 && git status --porcelain",
    );
    expect(manifest.command.allowedBinaries).toEqual(["git"]);
  });

  it("derives binaries and commands from every threaded command profile", () => {
    const mapper = new CapabilityMapper();
    const steps: WorkflowStep[] = [
      {
        id: "step_cmd",
        name: "Run git workflow",
        toolClass: "command",
        action: "cmd.exec",
        service: "cmd",
        inputs: {
          command: "git",
          args: ["log", "--oneline", "-5"],
          commandProfiles: [
            "git log --oneline -5",
            "git status --porcelain",
            "git diff --stat",
            "wc -l README.md",
            "head -5 out.txt",
          ],
        },
        dependsOn: [],
      },
    ];

    const manifest = mapper.mapRequiredCapabilities(steps);

    expect(manifest.command.allowedCommands).toEqual(
      expect.arrayContaining([
        "git log --oneline -5",
        "git status --porcelain",
        "git diff --stat",
        "wc -l README.md",
        "head -5 out.txt",
      ]),
    );
    expect(manifest.command.allowedBinaries).toEqual(
      expect.arrayContaining(["git", "wc", "head"]),
    );
  });

  it("rejects dynamic placeholders inside threaded command profiles", () => {
    const mapper = new CapabilityMapper();
    const steps: WorkflowStep[] = [
      {
        id: "step_cmd",
        name: "Run git workflow",
        toolClass: "command",
        action: "cmd.exec",
        service: "cmd",
        inputs: {
          command: "git",
          args: ["status"],
          commandProfiles: ["git status", "$dynamicCommand"],
        },
        dependsOn: [],
      },
    ];

    expect(() => mapper.mapRequiredCapabilities(steps)).toThrow(/Dynamic command placeholders/);
  });
});
