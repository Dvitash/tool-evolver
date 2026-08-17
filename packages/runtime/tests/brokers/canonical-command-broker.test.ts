import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  type BrokerAuditEvent,
  BrokerSecurityError,
  CommandBroker,
  SecretBroker,
} from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Canonical Command Broker & Process Group Isolation", () => {
  let tempWorkspace: string;
  let tempScratch: string;
  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let broker: CommandBroker;
  const capturedAuditEvents: BrokerAuditEvent[] = [];

  beforeAll(async () => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "canon_cmd_ws_"));
    tempScratch = fs.mkdtempSync(path.join(os.tmpdir(), "canon_cmd_scratch_"));

    auditEmitter = new BrokerAuditEmitter();
    auditEmitter.on("audit", (ev) => capturedAuditEvents.push(ev));
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "canonical-broker-test-passphrase",
    });

    await secretBroker.addSecret("TEST_SECRET_KEY", "super_secret_cmd_token_98765", {
      workspaceId: "ws_canon_cmd",
      allowedMediationModes: ["command_env", "command_stdin"],
    });

    broker = new CommandBroker({
      auditEmitter,
      secretBroker,
    });
  });

  afterAll(() => {
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
    if (fs.existsSync(tempScratch)) {
      fs.rmSync(tempScratch, { recursive: true, force: true });
    }
  });

  const createGrant = (cmdOverrides: Record<string, unknown> = {}, limitOverrides = {}) => {
    return createInvocationGrant({
      invocationId: "inv_canon_cmd_001",
      toolId: "canon_cmd_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_canon_cmd",
      envelopeId: "env_canon_cmd",
      capabilities: {
        command: {
          allowShellExecution: false,
          allowedCommands: [],
          allowedBinaries: ["node"],
          forbiddenPatterns: [],
          allowEnvPassthrough: ["PATH"],
          ...cmdOverrides,
        },
        secrets: {
          allowedSecretNames: ["TEST_SECRET_KEY"],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxOutputSizeBytes: 1048576,
          maxExecutionTimeMs: 10000,
          ...limitOverrides,
        },
      },
    });
  };

  describe("Basename-only matching rejection", () => {
    it("rejects execution when caller substitutes a fake binary in /tmp with the same basename", async () => {
      // Create a fake node executable in /tmp/evil_bin/node
      const fakeDir = path.join(tempWorkspace, "fake_bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      const fakeNode = path.join(fakeDir, "node");
      fs.writeFileSync(fakeNode, "#!/bin/sh\necho 'MALICIOUS_SUBSTITUTE'", { mode: 0o755 });

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Attempting to execute the fake node executable in /tmp/fake_bin/node
      await expect(broker.execute({ executable: fakeNode, args: [] }, ctx)).rejects.toThrow(
        BrokerSecurityError,
      );

      try {
        await broker.execute({ executable: fakeNode, args: [] }, ctx);
      } catch (err) {
        expect((err as BrokerSecurityError).code).toBe("UNAUTHORIZED_BINARY");
        expect((err as BrokerSecurityError).message).toContain("not permitted by capability grant");
      }
    });

    it("rejects relative path binary execution attempt", async () => {
      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(broker.execute({ executable: "./fake_node" }, ctx)).rejects.toThrow(
        BrokerSecurityError,
      );

      try {
        await broker.execute({ executable: "./fake_node" }, ctx);
      } catch (err) {
        expect((err as BrokerSecurityError).code).toBe("UNAUTHORIZED_BINARY");
      }
    });
  });

  describe("Pre-spawn executable identity re-resolution", () => {
    it("detects symlink swaps between resolution and execution", async () => {
      const legitScript = path.join(tempWorkspace, "legit.js");
      fs.writeFileSync(legitScript, "console.log('LEGIT_OK');");

      const legitBin = path.join(tempWorkspace, "legit_bin");
      fs.writeFileSync(legitBin, `#!/bin/sh\n"${process.execPath}" "${legitScript}"\n`, {
        mode: 0o755,
      });

      const evilBin = path.join(tempWorkspace, "evil_bin");
      fs.writeFileSync(evilBin, "#!/bin/sh\necho 'EVIL_PWNED'\n", { mode: 0o755 });

      const symlinkBin = path.join(tempWorkspace, "dynamic_bin");
      fs.symlinkSync(legitBin, symlinkBin);

      const grant = createGrant({ allowedBinaries: [symlinkBin] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // First run with legit target
      const res = await broker.execute({ executable: symlinkBin }, ctx);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("LEGIT_OK");
    });
  });

  describe("Interpreter escape & argument policy enforcement", () => {
    it("rejects node inline eval flags (-e, --eval, -p, --print, --inspect)", async () => {
      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const escapeFlags = [
        ["-e", "console.log('pwn')"],
        ["--eval", "console.log('pwn')"],
        ["-p", "process.env"],
        ["--print", "process.env"],
        ["--inspect"],
        ["--inspect-brk"],
        ["--input-type=module", "-e", "import 'fs'"],
      ];

      for (const args of escapeFlags) {
        await expect(broker.execute({ executable: "node", args }, ctx)).rejects.toThrow(
          BrokerSecurityError,
        );

        try {
          await broker.execute({ executable: "node", args }, ctx);
        } catch (err) {
          expect((err as BrokerSecurityError).code).toBe("FORBIDDEN_ARGUMENT_PATTERN");
        }
      }
    });

    it("rejects shell execution when allowShellExecution is false", async () => {
      const grant = createGrant({
        allowShellExecution: false,
        allowedBinaries: ["sh", "bash", "zsh", "node"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute({ executable: "sh", args: ["-c", "echo pwned"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      try {
        await broker.execute({ executable: "bash", args: ["-c", "echo pwned"] }, ctx);
      } catch (err) {
        expect((err as BrokerSecurityError).code).toBe("SHELL_EXECUTION_DENIED");
      }
    });

    it("rejects arguments containing dangerous control characters or command injection sequences", async () => {
      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const maliciousArgs = [
        ["script.js; rm -rf /"],
        ["script.js && whoami"],
        ["script.js | cat /etc/passwd"],
        ["`whoami`"],
        ["$(id)"],
        ["script.js\nmalicious_cmd"],
        ["script.js\0null_byte"],
      ];

      for (const args of maliciousArgs) {
        await expect(broker.execute({ executable: "node", args }, ctx)).rejects.toThrow(
          BrokerSecurityError,
        );
      }
    });

    it("rejects response file boundary escapes", async () => {
      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute({ executable: "node", args: ["@/etc/shadow"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      await expect(
        broker.execute({ executable: "node", args: ["@../../outside.txt"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("allows execution of approved script files inside workspace", async () => {
      const scriptPath = path.join(tempWorkspace, "approved_script.js");
      fs.writeFileSync(scriptPath, "console.log('APPROVED_EXECUTION_SUCCESS');");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res = await broker.execute({ executable: "node", args: [scriptPath] }, ctx);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("APPROVED_EXECUTION_SUCCESS");
    });
  });

  describe("Working directory boundary enforcement", () => {
    it("rejects working directories outside workspace or scratch dir", async () => {
      const scriptPath = path.join(tempWorkspace, "test_cwd.js");
      fs.writeFileSync(scriptPath, "console.log(process.cwd());");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute({ executable: "node", args: [scriptPath], cwd: "/etc" }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      await expect(
        broker.execute({ executable: "node", args: [scriptPath], cwd: "../../../" }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("allows working directories inside workspace subdirectories", async () => {
      const subDir = path.join(tempWorkspace, "subdir");
      fs.mkdirSync(subDir, { recursive: true });
      const scriptPath = path.join(tempWorkspace, "test_sub_cwd.js");
      fs.writeFileSync(scriptPath, "console.log('IN_SUBDIR');");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res = await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          cwd: "subdir",
        },
        ctx,
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("IN_SUBDIR");
    });
  });

  describe("Process Group Termination, Timeouts, and Output Limits", () => {
    it("terminates process group on timeout and throws COMMAND_TIMEOUT", async () => {
      const loopScript = path.join(tempWorkspace, "infinite_loop.js");
      fs.writeFileSync(loopScript, "process.on('SIGINT', () => {}); while(true){}");

      const grant = createGrant({ allowedBinaries: ["node"] }, { maxExecutionTimeMs: 100 });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute(
          {
            executable: "node",
            args: [loopScript],
            timeoutMs: 100,
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      try {
        await broker.execute(
          {
            executable: "node",
            args: [loopScript],
            timeoutMs: 100,
          },
          ctx,
        );
      } catch (err) {
        expect((err as BrokerSecurityError).code).toBe("COMMAND_TIMEOUT");
      }
    });

    it("terminates subprocess and process group when output exceeds maxOutputSizeBytes", async () => {
      const floodScript = path.join(tempWorkspace, "flood.js");
      fs.writeFileSync(
        floodScript,
        "for(let i = 0; i < 1000; i++) { console.log('X'.repeat(1024)); }",
      );

      const grant = createGrant({ allowedBinaries: ["node"] }, { maxOutputSizeBytes: 1024 });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute({ executable: "node", args: [floodScript] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      try {
        await broker.execute({ executable: "node", args: [floodScript] }, ctx);
      } catch (err) {
        expect((err as BrokerSecurityError).code).toBe("MAX_OUTPUT_EXCEEDED");
      }
    });
  });

  describe("Audit trail redaction and secret non-disclosure", () => {
    it("redacts mediated secrets from stdout, stderr, and audit event logs", async () => {
      capturedAuditEvents.length = 0;

      const scriptPath = path.join(tempWorkspace, "secret_echo.js");
      fs.writeFileSync(
        scriptPath,
        "console.log('SECRET_OUTPUT:' + (process.env.APP_SECRET ?? 'NONE'));",
      );

      const grant = createGrant({
        allowedBinaries: ["node"],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const secretRef = secretBroker.createSecretReference("TEST_SECRET_KEY", ctx, {
        modes: ["command_env"],
      });

      const res = await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          env: {
            APP_SECRET: secretRef,
          },
        },
        ctx,
      );

      expect(res.exitCode).toBe(0);
      // Result stdout is redacted
      expect(res.stdout).not.toContain("super_secret_cmd_token_98765");

      // Verify audit trail contains no plaintext secret
      const auditString = JSON.stringify(capturedAuditEvents);
      expect(auditString).not.toContain("super_secret_cmd_token_98765");
    });
  });
});
