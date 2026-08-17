import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@tool-evolver/harness-contracts";
import { DeviceAuthClient } from "../service/auth-bootstrap.js";

export interface LogoutCommandFlags {
  all?: boolean;
  force?: boolean;
  json?: boolean;
  home?: string;
  help?: boolean;
}

export interface LogoutResult {
  success: boolean;
  revokedRemotely: boolean;
  purgedLocalCredentials: boolean;
  purgedTokenFile: boolean;
  workspaceId?: string;
  deviceId?: string;
  error?: string;
}

export function parseLogoutFlags(args: string[]): LogoutCommandFlags {
  const flags: LogoutCommandFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      flags.all = true;
    } else if (arg === "--force" || arg === "-f") {
      flags.force = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice(7);
    }
  }
  return flags;
}

export function printLogoutHelp(): void {
  const text = `
Usage:
  tool-evolver logout [options]

Revokes and purges local device authentication credentials from the secure
vault and token store. Leaves all local tools, database records, and harness
configurations intact.

Options:
  --all            Revoke and purge all cached device tokens and sessions.
  -f, --force      Bypass confirmation and proceed immediately.
  --json           Output result in structured JSON format.
  --home <path>    Custom Tool Evolver home directory (overrides ~/.tool-evolver).
  -h, --help       Show this help message.
`;
  process.stdout.write(text.trimStart());
}

export async function logoutCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
    customFetch?: typeof fetch;
  } = {},
): Promise<number> {
  const flags = parseLogoutFlags(args);

  if (flags.help) {
    printLogoutHelp();
    return 0;
  }

  const customHome = flags.home ? path.resolve(flags.home) : os.homedir();
  const tokenFilePath = path.join(customHome, ".tool-evolver", "state", "device-token.json");

  const authClient = new DeviceAuthClient({
    tokenFilePath,
    customFetch: options.customFetch,
  });

  try {
    const creds = await authClient.loadCredentials();
    let revokedRemotely = false;

    if (creds?.accessToken) {
      revokedRemotely = await authClient.revokeToken(creds.accessToken);
    }

    const { purgedSecrets, purgedFile } = await authClient.purgeCredentials();

    const result: LogoutResult = {
      success: true,
      revokedRemotely,
      purgedLocalCredentials: purgedSecrets,
      purgedTokenFile: purgedFile,
      workspaceId: creds?.workspaceId,
      deviceId: creds?.deviceId,
    };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write("\n✓ Successfully logged out of Tool Evolver Cloud.\n");
      process.stdout.write("  Local device credentials purged. Tools and database preserved.\n\n");
    }

    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ error: msg, success: false }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`\nError during logout: ${msg}\n`);
    }
    return 1;
  }
}
