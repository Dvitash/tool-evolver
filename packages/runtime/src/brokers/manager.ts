import type { SecretCapability } from "@tool-evolver/contracts";
import { BrokerAuditEmitter, defaultBrokerAuditEmitter } from "./audit.js";
import {
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";
import { FilesystemBroker } from "./fs-broker.js";
import { NetworkBroker } from "./net-broker.js";
import { CommandBroker } from "./cmd-broker.js";
import type { BrokerRequestHandlerFn } from "../worker/sdk.js";

export interface CapabilityBrokerManagerOptions extends BaseCapabilityBrokerOptions {
  fsBroker?: FilesystemBroker;
  netBroker?: NetworkBroker;
  cmdBroker?: CommandBroker;
  secrets?: Record<string, string>;
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
  readonly auditEmitter: BrokerAuditEmitter;
  private readonly secrets: Record<string, string>;

  constructor(options: CapabilityBrokerManagerOptions = {}) {
    this.auditEmitter = options.auditEmitter ?? defaultBrokerAuditEmitter;
    const baseOpts = { auditEmitter: this.auditEmitter, requireGrant: options.requireGrant };

    this.fs = options.fsBroker ?? new FilesystemBroker(baseOpts);
    this.net = options.netBroker ?? new NetworkBroker(baseOpts);
    this.cmd = options.cmdBroker ?? new CommandBroker(baseOpts);
    this.secrets = options.secrets ?? {};
  }

  /**
   * Dispatches a capability request to the appropriate specialized broker.
   */
  async handleRequest(
    service: string,
    action: string,
    payload: Record<string, unknown> = {},
    context: BrokerContext
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
          `Unknown broker service: '${service}'`
        );
    }
  }

  /**
   * Creates a BrokerRequestHandlerFn closure bound to an invocation context.
   */
  createRequestHandler(context: BrokerContext): BrokerRequestHandlerFn {
    return async (service, action, payload) => {
      return this.handleRequest(service, action, payload, context);
    };
  }

  /**
   * Cleans up tracking state for an invocation across all managed brokers.
   */
  cleanupInvocation(invocationId: string): void {
    this.fs.cleanupInvocation(invocationId);
    this.net.cleanupInvocation(invocationId);
    this.cmd.cleanupInvocation(invocationId);
  }

  private async handleFsRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext
  ): Promise<unknown> {
    switch (action) {
      case "stat":
        return this.fs.stat({ path: String(payload.path ?? "") }, context);
      case "exists":
        return this.fs.exists({ path: String(payload.path ?? "") }, context);
      case "readFile":
        return this.fs.readFile(
          {
            path: String(payload.path ?? ""),
            encoding: payload.encoding as "utf-8" | "base64" | "buffer" | undefined,
          },
          context
        );
      case "writeFile":
        return this.fs.writeFile(
          {
            path: String(payload.path ?? ""),
            content: payload.content as string | Uint8Array,
            encoding: payload.encoding as "utf-8" | "base64" | undefined,
            atomic: payload.atomic as boolean | undefined,
          },
          context
        );
      case "appendFile":
        return this.fs.appendFile(
          {
            path: String(payload.path ?? ""),
            content: payload.content as string | Uint8Array,
            encoding: payload.encoding as "utf-8" | "base64" | undefined,
          },
          context
        );
      case "rename":
        return this.fs.rename(
          {
            oldPath: String(payload.oldPath ?? ""),
            newPath: String(payload.newPath ?? ""),
          },
          context
        );
      case "delete":
      case "removeFile":
        return this.fs.delete(
          {
            path: String(payload.path ?? ""),
            recursive: payload.recursive as boolean | undefined,
          },
          context
        );
      case "createDirectory":
      case "mkdir":
        return this.fs.createDirectory(
          {
            path: String(payload.path ?? ""),
            recursive: payload.recursive as boolean | undefined,
          },
          context
        );
      case "listDirectory":
      case "listDir":
        return this.fs.listDirectory(
          {
            path: payload.path !== undefined ? String(payload.path) : undefined,
            recursive: payload.recursive as boolean | undefined,
          },
          context
        );
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported filesystem broker action: '${action}'`
        );
    }
  }

  private async handleNetRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext
  ): Promise<unknown> {
    switch (action) {
      case "request":
      case "fetch":
        return this.net.request(
          {
            url: String(payload.url ?? ""),
            method: payload.method !== undefined ? String(payload.method) : undefined,
            headers: payload.headers as Record<string, string> | undefined,
            body: payload.body !== undefined ? String(payload.body) : undefined,
            timeoutMs: payload.timeoutMs !== undefined ? Number(payload.timeoutMs) : undefined,
            redirect: payload.redirect as "follow" | "error" | "manual" | undefined,
            maxRedirects: payload.maxRedirects !== undefined ? Number(payload.maxRedirects) : undefined,
          },
          context
        );
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported network broker action: '${action}'`
        );
    }
  }

  private async handleCmdRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext
  ): Promise<unknown> {
    switch (action) {
      case "execute":
      case "exec":
        return this.cmd.execute(
          {
            executable: payload.executable !== undefined ? String(payload.executable) : undefined,
            command: payload.command !== undefined ? String(payload.command) : undefined,
            args: Array.isArray(payload.args) ? (payload.args as string[]) : undefined,
            cwd: payload.cwd !== undefined ? String(payload.cwd) : undefined,
            env: payload.env as Record<string, string> | undefined,
            timeoutMs: payload.timeoutMs !== undefined ? Number(payload.timeoutMs) : undefined,
            maxOutputSizeBytes: payload.maxOutputSizeBytes !== undefined ? Number(payload.maxOutputSizeBytes) : undefined,
          },
          context
        );
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported command broker action: '${action}'`
        );
    }
  }

  private async handleSecretRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext
  ): Promise<unknown> {
    const startTime = Date.now();
    const grant = context.grant;

    if (!grant) {
      throw new BrokerSecurityError("GRANT_REQUIRED", "Invocation grant is required to resolve secrets");
    }

    const secretCap: SecretCapability = grant.capabilities.secrets ?? {};
    const secretName = String(payload.name ?? "");

    if (!secretName) {
      throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", "Secret name must be specified");
    }

    // Check direct read permission
    if (secretCap.denyDirectRead) {
      this.auditEmitter.emitAudit({
        service: "secret",
        action: "getSecret",
        invocationId: context.invocationId,
        grantId: grant.grantId,
        toolId: context.toolId ?? grant.toolId,
        status: "denied",
        error: { code: "OPERATION_NOT_PERMITTED", message: "Direct secret read is denied by policy" },
        durationMs: Date.now() - startTime,
        summary: { secretName },
      });
      throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", `Direct read of secret '${secretName}' is denied`);
    }

    // Check allowed secret names and prefixes
    const allowedNames = secretCap.allowedSecretNames ?? [];
    const allowedPrefixes = secretCap.allowedPrefixes ?? [];
    const isAllowed =
      allowedNames.includes(secretName) ||
      allowedPrefixes.some((prefix) => secretName.startsWith(prefix));

    if (!isAllowed) {
      this.auditEmitter.emitAudit({
        service: "secret",
        action: "getSecret",
        invocationId: context.invocationId,
        grantId: grant.grantId,
        toolId: context.toolId ?? grant.toolId,
        status: "denied",
        error: { code: "OPERATION_NOT_PERMITTED", message: "Secret name is not authorized" },
        durationMs: Date.now() - startTime,
        summary: { secretName },
      });
      throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", `Secret '${secretName}' is not authorized by capability policy`);
    }

    const secretValue = this.secrets[secretName] ?? process.env[secretName] ?? null;

    this.auditEmitter.emitAudit({
      service: "secret",
      action: "getSecret",
      invocationId: context.invocationId,
      grantId: grant.grantId,
      toolId: context.toolId ?? grant.toolId,
      status: "allowed",
      durationMs: Date.now() - startTime,
      summary: { secretName, found: secretValue !== null },
    });

    return { secret: secretValue };
  }
}
