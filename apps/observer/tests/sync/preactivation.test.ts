import { describe, expect, it } from "vitest";
import { LocalPreactivationChecker } from "../../src/sync/preactivation.js";
import { createSampleCapabilityEnvelope, createSampleToolManifest } from "./fixtures.js";

describe("LocalPreactivationChecker", () => {
  const checker = new LocalPreactivationChecker();

  it("approves a tool candidate whose capabilities conform to workspace envelope", async () => {
    const manifest = createSampleToolManifest("valid-tool", "1.0.0");
    const envelope = createSampleCapabilityEnvelope("ws-1");

    const result = await checker.checkPreactivation({
      manifest,
      workspaceId: "ws-1",
      envelope,
    });

    expect(result.eligible).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  describe("Filesystem Capability Constraints", () => {
    it("rejects read paths not permitted by workspace capability envelope", async () => {
      const manifest = createSampleToolManifest("fs-violator", "1.0.0", {
        capabilities: {
          fs: {
            readPaths: ["/root/.ssh/id_rsa"],
            writePaths: [],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 1048576,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        fs: {
          readPaths: ["src", "lib"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [".env"],
          maxFileSizeBytes: 10485760,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "FS_READ_PATH_DISALLOWED")).toBe(true);
    });

    it("rejects write paths that match envelope deny paths", async () => {
      const manifest = createSampleToolManifest("deny-violator", "1.0.0", {
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: [".env"],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 1048576,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        fs: {
          readPaths: ["."],
          writePaths: ["."],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [".env", ".git"],
          maxFileSizeBytes: 10485760,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "FS_WRITE_PATH_DISALLOWED")).toBe(true);
    });

    it("rejects max file size exceeding envelope limit", async () => {
      const manifest = createSampleToolManifest("huge-file-tool", "1.0.0", {
        capabilities: {
          fs: {
            readPaths: ["."],
            writePaths: [],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 50 * 1024 * 1024, // 50MB
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        fs: {
          readPaths: ["."],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10 * 1024 * 1024, // 10MB limit
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "FS_MAX_SIZE_EXCEEDED")).toBe(true);
    });
  });

  describe("Network Capability Constraints", () => {
    it("rejects outbound network requests when envelope has allowOutbound=false", async () => {
      const manifest = createSampleToolManifest("net-tool", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["api.example.com"],
            allowedHosts: [],
            allowedPorts: [443],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        net: {
          allowOutbound: false, // Disallowed
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: [],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "NET_OUTBOUND_DISALLOWED")).toBe(true);
    });

    it("rejects domains not present in envelope domain whitelist", async () => {
      const manifest = createSampleToolManifest("domain-violator", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["untrusted-domain.com"],
            allowedHosts: [],
            allowedPorts: [443],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        net: {
          allowOutbound: true,
          allowedDomains: ["api.example.com", "*.trusted.org"],
          allowedHosts: [],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "NET_DOMAIN_DISALLOWED")).toBe(true);
    });

    it("blocks private, loopback, and local IP addresses when denyPrivateRanges is true", async () => {
      const privateAddresses = ["127.0.0.1", "10.0.0.5", "192.168.1.1", "localhost", "172.16.0.1"];

      for (const ip of privateAddresses) {
        const manifest = createSampleToolManifest("private-ip-tool", "1.0.0", {
          capabilities: {
            net: {
              allowOutbound: true,
              allowedDomains: [ip],
              allowedHosts: [],
              allowedPorts: [80],
              allowedProtocols: ["http"],
              allowLocalhost: false,
              denyPrivateRanges: true,
            },
          },
        });
        const envelope = createSampleCapabilityEnvelope("ws-1", {
          net: {
            allowOutbound: true,
            allowedDomains: ["*"],
            allowedHosts: [],
            allowedPorts: [80, 443],
            allowedProtocols: ["http", "https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        });

        const result = await checker.checkPreactivation({
          manifest,
          workspaceId: "ws-1",
          envelope,
        });

        expect(result.eligible).toBe(false);
        expect(result.violations.some((v) => v.code === "NET_PRIVATE_IP_BLOCKED")).toBe(true);
      }
    });

    it("rejects disallowed network ports and protocols", async () => {
      const manifest = createSampleToolManifest("port-proto-tool", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["api.example.com"],
            allowedHosts: [],
            allowedPorts: [22], // SSH port not allowed
            allowedProtocols: ["ws"], // ws not in envelope protocols
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        net: {
          allowOutbound: true,
          allowedDomains: ["api.example.com"],
          allowedHosts: [],
          allowedPorts: [443, 8443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "NET_PORT_DISALLOWED")).toBe(true);
      expect(result.violations.some((v) => v.code === "NET_PROTOCOL_DISALLOWED")).toBe(true);
    });
  });

  describe("Command & Shell Capability Constraints", () => {
    it("rejects shell execution when envelope has allowShellExecution=false", async () => {
      const manifest = createSampleToolManifest("shell-tool", "1.0.0", {
        capabilities: {
          command: {
            allowShellExecution: true,
            allowedCommands: ["bash -c 'ls'"],
            allowedBinaries: ["bash"],
            forbiddenPatterns: [],
            allowEnvPassthrough: [],
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        command: {
          allowShellExecution: false,
          allowedCommands: ["git status"],
          allowedBinaries: ["git"],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "COMMAND_SHELL_DISALLOWED")).toBe(true);
    });

    it("rejects dangerous environment variables requested in command capabilities", async () => {
      const dangerousVars = ["LD_PRELOAD", "NODE_OPTIONS", "PYTHONPATH", "RUBYOPT"];

      for (const envVar of dangerousVars) {
        const manifest = createSampleToolManifest("env-tool", "1.0.0", {
          capabilities: {
            command: {
              allowShellExecution: false,
              allowedCommands: ["git status"],
              allowedBinaries: ["git"],
              forbiddenPatterns: [],
              allowEnvPassthrough: [envVar],
            },
          },
        });
        const envelope = createSampleCapabilityEnvelope("ws-1");

        const result = await checker.checkPreactivation({
          manifest,
          workspaceId: "ws-1",
          envelope,
        });

        expect(result.eligible).toBe(false);
        expect(result.violations.some((v) => v.code === "DANGEROUS_ENV_VAR_REQUESTED")).toBe(true);
      }
    });
  });

  describe("Secrets & Limits Constraints", () => {
    it("rejects unauthorized secret names", async () => {
      const manifest = createSampleToolManifest("secret-tool", "1.0.0", {
        capabilities: {
          secrets: {
            allowedSecretNames: ["AWS_SECRET_ACCESS_KEY"], // Not permitted in envelope
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        secrets: {
          allowedSecretNames: ["API_TOKEN", "GITHUB_TOKEN"],
          allowedPrefixes: ["TOOL_"],
          denyDirectRead: true,
          injectAsEnv: true,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "SECRET_NAME_DISALLOWED")).toBe(true);
    });

    it("rejects memory and execution timeout limits exceeding envelope", async () => {
      const manifest = createSampleToolManifest("limits-tool", "1.0.0", {
        limits: {
          timeoutMs: 60000, // 60s > 30s envelope
          maxOutputBytes: 1048576,
          maxMemoryBytes: 512 * 1024 * 1024, // 512MB > 256MB envelope
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        limits: {
          maxConcurrentExecutions: 4,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 256,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 2097152,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "LIMIT_TIMEOUT_EXCEEDED")).toBe(true);
      expect(result.violations.some((v) => v.code === "LIMIT_MEMORY_EXCEEDED")).toBe(true);
    });
  });

  describe("User Overrides: Pin & Disable", () => {
    it("rejects candidate when tool is explicitly disabled by user override", async () => {
      const manifest = createSampleToolManifest("disabled-tool", "1.0.0");
      const envelope = createSampleCapabilityEnvelope("ws-1");

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
        overrides: [
          {
            toolId: "disabled-tool",
            workspaceId: "ws-1",
            action: "disable",
            isEnabled: false,
          },
        ],
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "USER_DISABLED_OVERRIDE")).toBe(true);
    });

    it("rejects unpinned candidate version when tool is pinned to a specific version", async () => {
      const manifest = createSampleToolManifest("pinned-tool", "2.0.0"); // Candidate is 2.0.0
      const envelope = createSampleCapabilityEnvelope("ws-1");

      // 1. Version 2.0.0 does not match pinned version 1.0.0 -> Rejected
      const rejected = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
        overrides: [
          {
            toolId: "pinned-tool",
            workspaceId: "ws-1",
            action: "pin",
            pinnedVersion: "1.0.0",
            isEnabled: true,
          },
        ],
      });

      expect(rejected.eligible).toBe(false);
      expect(rejected.violations.some((v) => v.code === "USER_PIN_OVERRIDE")).toBe(true);

      // 2. Exact pinned version 1.0.0 -> Approved
      const pinnedManifest = createSampleToolManifest("pinned-tool", "1.0.0");
      const approved = await checker.checkPreactivation({
        manifest: pinnedManifest,
        workspaceId: "ws-1",
        envelope,
        overrides: [
          {
            toolId: "pinned-tool",
            workspaceId: "ws-1",
            action: "pin",
            pinnedVersion: "1.0.0",
            isEnabled: true,
          },
        ],
      });

      expect(approved.eligible).toBe(true);
      expect(approved.violations).toHaveLength(0);
    });
  });

  describe("Runtime Engine & Non-Executing Inspection", () => {
    it("rejects unsupported runtime engines", async () => {
      const manifest = createSampleToolManifest("unknown-engine-tool", "1.0.0", {
        runtime: {
          runtime: "shell",
          engine: "ruby_mri_3",
          minRuntimeVersion: "3.0.0",
        } as unknown as ToolManifest["runtime"],
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "UNSUPPORTED_RUNTIME")).toBe(true);
    });

    it("rejects inspection findings with invalid signature or path traversal", async () => {
      const manifest = createSampleToolManifest("traversal-tool", "1.0.0");

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        inspection: {
          manifest,
          bundleDigest: "dummy",
          files: [
            { path: "manifest.json", sizeBytes: 100, digest: "abc" },
            { path: "../../../escape.js", sizeBytes: 50, digest: "def" },
          ],
          signature: {
            keyId: "bad-key",
            algorithm: "ed25519",
            valid: false,
            trustLevel: "revoked",
            error: "Key revoked",
          },
        },
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "PATH_TRAVERSAL_DETECTED")).toBe(true);
      expect(result.violations.some((v) => v.code === "INVALID_SIGNATURE")).toBe(true);
    });
  });
});
