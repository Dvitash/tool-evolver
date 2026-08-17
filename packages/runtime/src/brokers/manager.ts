import type { SecretCapability } from "@tool-evolver/contracts";
import type { SecretManager } from "@tool-evolver/crypto";
import type { BrokerRequestHandlerFn } from "../worker/sdk.js";
import { type BrokerAuditEmitter, defaultBrokerAuditEmitter } from "./audit.js";
import {
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";
import { CommandBroker } from "./cmd-broker.js";
import { FilesystemBroker } from "./fs-broker.js";
import { NetworkBroker } from "./net-broker.js";
import { SecretBroker } from "./secret-broker.js";

export interface CapabilityBrokerManagerOptions extends BaseCapabilityBrokerOptions {
  fsBroker?: FilesystemBroker;
  netBroker?: NetworkBroker;
  cmdBroker?: CommandBroker;
  secretBroker?: SecretBroker;
  secrets?: Record<string, string> | SecretBroker;
  secretManager?: SecretManager;
  vaultPath?: string;
  passphrase?: string;
}

/**
 * Unified manager for capability brokers in the tool evolver runtime.
 * Dispatches RPC requests to the appropriate broker (fs, net, cmd, secret),
 * verifies invocation grants, tracks resource usage, and emits audit trails.
 */
export class CapabilityBrokerManager {
  readonly fs: FilesystemBroker;
  readonly net: NetworkBroker;
  readonly cmd: CommandBroker;
  readonly secret: SecretBroker;
  readonly auditEmitter: BrokerAuditEmitter;

  constructor(options: CapabilityBrokerManagerOptions = {}) {
    this.auditEmitter = options.auditEmitter ?? defaultBrokerAuditEmitter;
    const baseOpts = { auditEmitter: this.auditEmitter, requireGrant: options.requireGrant };

    this.fs = options.fsBroker ?? new FilesystemBroker(baseOpts);
    this.net = options.netBroker ?? new NetworkBroker(baseOpts);
    this.cmd = options.cmdBroker ?? new CommandBroker(baseOpts);
    this.secret =
      options.secretBroker ??
      (options.secrets instanceof SecretBroker
        ? options.secrets
        : new SecretBroker({
            auditEmitter: this.auditEmitter,
            requireGrant: options.requireGrant,
            secrets: options.secrets,
            secretManager: options.secretManager,
            vaultPath: options.vaultPath,
            passphrase: options.passphrase,
          }));
  }

  /**
   * Dispatches an incoming broker request from a worker process to the corresponding capability broker.
   */
  async handleRequest(
    service: "fs" | "net" | "cmd" | "secret",
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    switch (service) {
      case "fs":
        return this.handleFsRequest(action, payload, context);
      case "net":
        return this.handleNetRequest(action, payload, context);
      case "cmd":
        return this.handleCmdRequest(action, payload, context);
      case "secret":
        return this.handleSecretRequest(action, payload, context);
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported broker service: '${service}'`,
        );
    }
  }

  /**
   * Creates a bound request handler function suitable for SDK clients or worker processes.
   */
  createRequestHandler(context: BrokerContext): BrokerRequestHandlerFn {
    return (service, action, payload) => this.handleRequest(service, action, payload, context);
  }

  /**
   * Cleans up all per-invocation state across all brokers.
   */
  cleanupInvocation(invocationId: string): void {
    this.fs.cleanupInvocation(invocationId);
    this.net.cleanupInvocation(invocationId);
    this.cmd.cleanupInvocation(invocationId);
    this.secret.cleanupInvocation(invocationId);
  }

  private async handleFsRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    switch (action) {
      case "readFile":
        return this.fs.readFile(
          {
            path: String(payload.path ?? ""),
            encoding: payload.encoding as "utf-8" | "base64" | "buffer" | undefined,
          },
          context,
        );
      case "writeFile":
        return this.fs.writeFile(
          {
            path: String(payload.path ?? ""),
            content: payload.content as string | Uint8Array,
            encoding: payload.encoding as "utf-8" | "base64" | undefined,
            atomic: payload.atomic as boolean | undefined,
          },
          context,
        );
      case "appendFile":
        return this.fs.appendFile(
          {
            path: String(payload.path ?? ""),
            content: payload.content as string | Uint8Array,
            encoding: payload.encoding as "utf-8" | "base64" | undefined,
          },
          context,
        );
      case "rename":
        return this.fs.rename(
          {
            oldPath: String(payload.oldPath ?? ""),
            newPath: String(payload.newPath ?? ""),
          },
          context,
        );
      case "delete":
      case "removeFile":
        return this.fs.delete(
          {
            path: String(payload.path ?? ""),
            recursive: payload.recursive as boolean | undefined,
          },
          context,
        );
      case "createDirectory":
      case "mkdir":
        return this.fs.createDirectory(
          {
            path: String(payload.path ?? ""),
            recursive: payload.recursive as boolean | undefined,
          },
          context,
        );
      case "listDirectory":
      case "listDir":
        return this.fs.listDirectory(
          {
            path: payload.path !== undefined ? String(payload.path) : undefined,
            recursive: payload.recursive as boolean | undefined,
          },
          context,
        );
      case "exists":
        return this.fs.exists(
          {
            path: String(payload.path ?? ""),
          },
          context,
        );
      case "stat":
        return this.fs.stat(
          {
            path: String(payload.path ?? ""),
          },
          context,
        );
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported filesystem broker action: '${action}'`,
        );
    }
  }

  private async handleNetRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    switch (action) {
      case "fetch": {
        let headers = payload.headers as Record<string, string> | undefined;
        let url = String(payload.url ?? "");

        if (headers) {
          headers = await this.secret.mediateHeaders(headers, context);
        }
        if (url.includes("{{")) {
          url = await this.secret.mediateUrl(url, context);
        }

        return this.net.request(
          {
            url,
            method: payload.method as string | undefined,
            headers,
            body: payload.body as string | undefined,
            timeoutMs: payload.timeoutMs as number | undefined,
            redirect: payload.redirect as "follow" | "error" | "manual" | undefined,
            maxRedirects: payload.maxRedirects as number | undefined,
          },
          context,
        );
      }
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported network broker action: '${action}'`,
        );
    }
  }

  private async handleCmdRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    switch (action) {
      case "execute":
      case "exec": {
        let env = payload.env as Record<string, string> | undefined;
        let stdin = payload.stdin as string | undefined;

        if (env) {
          env = await this.secret.mediateCommandEnv(env, context);
        } else if (context.grant?.capabilities?.secrets?.injectAsEnv) {
          env = await this.secret.mediateCommandEnv({}, context);
        }

        if (stdin) {
          stdin = await this.secret.mediateCommandStdin(stdin, context);
        }

        return this.cmd.execute(
          {
            command: payload.command as string | undefined,
            executable: payload.executable as string | undefined,
            args: payload.args as string[] | undefined,
            cwd: payload.cwd as string | undefined,
            env,
            stdin,
            timeoutMs: payload.timeoutMs as number | undefined,
            maxOutputSizeBytes: payload.maxOutputSizeBytes as number | undefined,
          },
          context,
        );
      }
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported command broker action: '${action}'`,
        );
    }
  }

  private async handleSecretRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    return this.secret.handleRequest(action, payload, context);
  }
}
