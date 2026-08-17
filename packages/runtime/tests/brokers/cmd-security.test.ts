import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerSecurityError, CommandBroker } from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Command Broker Security & Isolation", () => {
  let tempWorkspace: string;
  let broker: CommandBroker;

  beforeAll(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cmd_broker_ws_"));
    broker = new CommandBroker();

    // Set a dummy host secret in process.env to verify it does not leak
    process.env.TEST_HOST_SECRET_TOKEN = "SUPER_SECRET_HOST_TOKEN_12345";
  });

  afterAll(() => {
    delete process.env.TEST_HOST_SECRET_TOKEN;
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {}
  });

  const createGrant = (
    overrides: Record<string, unknown> = {},
    limitOverrides: Record<string, unknown> = {},
  ) => {
    return createInvocationGrant({
      grantId: "grant_cmd_test",
      invocationId: "inv_cmd_001",
      toolId: "cmd_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_cmd",
      envelopeId: "env_cmd",
      capabilities: {
        command: {
          allowShellExecution: false,
          allowedCommands: [],
          allowedBinaries: ["node"],
          forbiddenPatterns: ["--forbidden-flag", "eval\\s*\\("],
          allowEnvPassthrough: ["TEST_ALLOWED_VAR"],
          ...overrides,
        },
        limits: {
          maxOutputSizeBytes: 1048576,
          maxExecutionTimeMs: 10000,
          ...limitOverrides,
        },
      },
    });
  };

  it("executes authorized binary and returns stdout, exitCode, and duration", async () => {
    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const res = await broker.execute(
      {
        executable: "node",
        args: ["-e", "console.log('Command Broker Success')"],
      },
      ctx,
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("Command Broker Success");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects unauthorized binary execution", async () => {
    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await expect(
      broker.execute({ executable: "python3", args: ["-c", "print('evil')"] }, ctx),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute({ executable: "python3" }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("UNAUTHORIZED_BINARY");
    }
  });

  it("denies direct shell binary invocation when allowShellExecution is false", async () => {
    const grant = createGrant({
      allowShellExecution: false,
      allowedBinaries: ["sh", "bash", "node"], // even if in allowedBinaries
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    for (const shellBin of ["sh", "bash", "zsh", "cmd.exe"]) {
      await expect(
        broker.execute({ executable: shellBin, args: ["-c", "echo 1"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      try {
        await broker.execute({ executable: shellBin }, ctx);
      } catch (err) {
        expect((err as BrokerSecurityError).code).toBe("SHELL_EXECUTION_DENIED");
      }
    }
  });

  it("blocks shell metacharacters in commands and arguments", async () => {
    const grant = createGrant({ allowShellExecution: false, allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const dangerousArgs = [
      ["-e", "console.log(1); rm -rf /"],
      ["-e", "console.log(1) | cat"],
      ["-e", "console.log(1) && echo evil"],
      ["-e", "`whoami`"],
      ["-e", "$(whoami)"],
    ];

    for (const args of dangerousArgs) {
      await expect(broker.execute({ executable: "node", args }, ctx)).rejects.toThrow(
        BrokerSecurityError,
      );

      try {
        await broker.execute({ executable: "node", args }, ctx);
      } catch (err) {
        expect((err as BrokerSecurityError).code).toBe("SHELL_EXECUTION_DENIED");
      }
    }
  });

  it("blocks relative PATH injection executable attempts", async () => {
    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await expect(
      broker.execute({ executable: "./unauthorized_local_binary" }, ctx),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute({ executable: "./unauthorized_local_binary" }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("UNAUTHORIZED_BINARY");
    }
  });

  it("enforces forbiddenPatterns in command arguments", async () => {
    const grant = createGrant({
      allowedBinaries: ["node"],
      forbiddenPatterns: ["--forbidden-flag", "malicious_token"],
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await expect(
      broker.execute({ executable: "node", args: ["--forbidden-flag"] }, ctx),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute({ executable: "node", args: ["--forbidden-flag"] }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("FORBIDDEN_PATTERN");
    }
  });

  it("enforces working directory containment", async () => {
    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await expect(
      broker.execute(
        {
          executable: "node",
          args: ["-e", "console.log('hi')"],
          cwd: "../../../",
        },
        ctx,
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute(
        {
          executable: "node",
          args: ["-e", "console.log('hi')"],
          cwd: "../../../",
        },
        ctx,
      );
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("WORKING_DIRECTORY_DENIED");
    }
  });

  it("isolates child environment and prevents host secret leakage", async () => {
    const grant = createGrant({
      allowedBinaries: ["node"],
      allowEnvPassthrough: ["TEST_ALLOWED_VAR"],
    });
    process.env.TEST_ALLOWED_VAR = "ALLOWED_VALUE_123";

    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const res = await broker.execute(
      {
        executable: "node",
        args: [
          "-e",
          "console.log(JSON.stringify({ secret: process.env.TEST_HOST_SECRET_TOKEN, allowed: process.env.TEST_ALLOWED_VAR }))",
        ],
      },
      ctx,
    );

    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.secret).toBeUndefined(); // Host secret must NOT be leaked
    expect(parsed.allowed).toBe("ALLOWED_VALUE_123"); // Explicitly allowed var is passed

    delete process.env.TEST_ALLOWED_VAR;
  });

  it("enforces output size limits and terminates subprocess if exceeded", async () => {
    const grant = createGrant(
      { allowedBinaries: ["node"] },
      { maxOutputSizeBytes: 500 }, // 500 bytes max
    );
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Script prints 10KB of data
    await expect(
      broker.execute(
        {
          executable: "node",
          args: ["-e", "console.log('A'.repeat(10000))"],
        },
        ctx,
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute(
        {
          executable: "node",
          args: ["-e", "console.log('A'.repeat(10000))"],
        },
        ctx,
      );
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("MAX_OUTPUT_EXCEEDED");
    }
  });

  it("enforces command execution timeout and terminates process tree", async () => {
    const grant = createGrant(
      { allowedBinaries: ["node"] },
      { maxExecutionTimeMs: 150 }, // 150ms timeout
    );
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Infinite loop in node child process
    await expect(
      broker.execute(
        {
          executable: "node",
          args: ["-e", "while(true){}"],
          timeoutMs: 100,
        },
        ctx,
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute(
        {
          executable: "node",
          args: ["-e", "while(true){}"],
          timeoutMs: 100,
        },
        ctx,
      );
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("COMMAND_TIMEOUT");
    }
  });
});
