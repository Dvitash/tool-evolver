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
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  const createGrant = (overrides: Record<string, unknown> = {}, limitOverrides = {}) => {
    return createInvocationGrant({
      invocationId: "inv_cmd_001",
      toolId: "test_cmd_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_cmd_test",
      envelopeId: "env_cmd_test",
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
    const scriptPath = path.join(tempWorkspace, "success.js");
    fs.writeFileSync(scriptPath, "console.log('Command Broker Success');");

    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const res = await broker.execute(
      {
        executable: "node",
        args: [scriptPath],
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

    await expect(broker.execute({ executable: "git", args: ["status"] }, ctx)).rejects.toThrow(
      BrokerSecurityError,
    );

    try {
      await broker.execute({ executable: "git", args: ["status"] }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("UNAUTHORIZED_BINARY");
    }
  });

  it("denies direct shell binary invocation when allowShellExecution is false", async () => {
    const grant = createGrant({
      allowShellExecution: false,
      allowedBinaries: ["sh", "bash", "node"],
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await expect(
      broker.execute({ executable: "sh", args: ["-c", "echo pwned"] }, ctx),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute({ executable: "bash", args: ["-c", "whoami"] }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("SHELL_EXECUTION_DENIED");
    }
  });

  it("rejects commands with forbidden argument patterns", async () => {
    const scriptPath = path.join(tempWorkspace, "forbidden_test.js");
    fs.writeFileSync(scriptPath, "console.log('test');");

    const grant = createGrant({
      allowedBinaries: ["node"],
      forbiddenPatterns: ["--forbidden-flag", "eval\\s*\\("],
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await expect(
      broker.execute({ executable: "node", args: [scriptPath, "--forbidden-flag"] }, ctx),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute({ executable: "node", args: [scriptPath, "--forbidden-flag"] }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("FORBIDDEN_PATTERN");
    }
  });

  it("rejects shell injection characters in command arguments", async () => {
    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const dangerousArgs = [
      ["console.log(1); rm -rf /"],
      ["console.log(1) | cat"],
      ["console.log(1) && echo evil"],
      ["`whoami`"],
      ["$(whoami)"],
      ["test\ninjection"],
      ["test\0nullbyte"],
    ];

    for (const args of dangerousArgs) {
      await expect(broker.execute({ executable: "node", args }, ctx)).rejects.toThrow(
        BrokerSecurityError,
      );
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

  it("rejects working directories outside workspace or scratch dir", async () => {
    const scriptPath = path.join(tempWorkspace, "cwd_test.js");
    fs.writeFileSync(scriptPath, "console.log('hi');");

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
          args: [scriptPath],
          cwd: "../../../",
        },
        ctx,
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          cwd: "/etc",
        },
        ctx,
      );
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("WORKING_DIRECTORY_DENIED");
    }
  });

  it("sanitizes environment and prevents leaking unapproved host environment variables", async () => {
    const scriptPath = path.join(tempWorkspace, "env_test.js");
    fs.writeFileSync(
      scriptPath,
      `console.log(JSON.stringify({
        secret: process.env.TEST_HOST_SECRET_TOKEN,
        allowed: process.env.TEST_ALLOWED_VAR,
      }));`,
    );

    process.env.TEST_ALLOWED_VAR = "ALLOWED_VALUE_123";

    const grant = createGrant({
      allowedBinaries: ["node"],
      allowEnvPassthrough: ["TEST_ALLOWED_VAR"],
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const res = await broker.execute(
      {
        executable: "node",
        args: [scriptPath],
      },
      ctx,
    );

    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.secret).toBeUndefined(); // Host secret must NOT be leaked
    expect(parsed.allowed).toBe("ALLOWED_VALUE_123"); // Explicitly allowed var is passed

    delete process.env.TEST_ALLOWED_VAR;
  });

  it("enforces output size limits and terminates subprocess if exceeded", async () => {
    const scriptPath = path.join(tempWorkspace, "large_output.js");
    fs.writeFileSync(scriptPath, "console.log('A'.repeat(10240));");

    const grant = createGrant(
      { allowedBinaries: ["node"] },
      { maxOutputSizeBytes: 500 }, // 500 bytes max
    );
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await expect(
      broker.execute(
        {
          executable: "node",
          args: [scriptPath],
        },
        ctx,
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
        },
        ctx,
      );
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("MAX_OUTPUT_EXCEEDED");
    }
  });

  it("enforces execution timeout bounds and terminates subprocess on deadline", async () => {
    const scriptPath = path.join(tempWorkspace, "timeout_loop.js");
    fs.writeFileSync(scriptPath, "while(true){}");

    const grant = createGrant({ allowedBinaries: ["node"] }, { maxExecutionTimeMs: 100 });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await expect(
      broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          timeoutMs: 100,
        },
        ctx,
      ),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          timeoutMs: 100,
        },
        ctx,
      );
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("COMMAND_TIMEOUT");
    }
  });
});
