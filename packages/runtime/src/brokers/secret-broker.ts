import type { SecretCapability } from "@tool-evolver/contracts";
import {
  type MediationMode,
  SecretManager,
  type SecretMetadata,
  type SecretRedactor,
  type SetSecretOptions,
} from "@tool-evolver/crypto";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";

/**
 * Options for initializing SecretBroker.
 */
export interface SecretBrokerOptions extends BaseCapabilityBrokerOptions {
  secretManager?: SecretManager;
  secrets?: Record<string, string> | SecretManager;
  vaultPath?: string;
  passphrase?: string;
}

/**
 * Capability broker for named-secret management and non-disclosure capability mediation.
 * Mediates secrets for network templates (Authorization headers, query params) and command
 * execution (stdin/env) without exposing raw secret values to generated workers.
 */
export class SecretBroker extends BaseCapabilityBroker {
  readonly serviceName = "secret" as const;
  readonly manager: SecretManager;

  constructor(options: SecretBrokerOptions = {}) {
    super(options);

    if (options.secretManager) {
      this.manager = options.secretManager;
    } else if (options.secrets instanceof SecretManager) {
      this.manager = options.secrets;
    } else {
      this.manager = new SecretManager({
        vaultPath: options.vaultPath,
        passphrase: options.passphrase,
      });

      if (options.secrets && typeof options.secrets === "object") {
        for (const [name, value] of Object.entries(options.secrets)) {
          this.manager.addSecret(name, value).catch(() => {});
        }
      }
    }
  }

  /**
   * Helper to verify that a secret name/alias is authorized by the grant capability envelope.
   */
  private isSecretAuthorized(nameOrAlias: string, secretCap: SecretCapability): boolean {
    const allowedNames = secretCap.allowedSecretNames ?? [];
    const allowedPrefixes = secretCap.allowedPrefixes ?? [];

    if (allowedNames.includes(nameOrAlias)) {
      return true;
    }

    return allowedPrefixes.some((prefix) => nameOrAlias.startsWith(prefix));
  }

  /**
   * Resolves a secret value for a specific mediation mode after verifying grant authorization.
   */
  async authorizeSecretAccess(
    secretNameOrAlias: string,
    context: BrokerContext,
    mode: MediationMode
  ): Promise<string> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const secretCap: SecretCapability = grant.capabilities.secrets ?? {};

    if (!this.isSecretAuthorized(secretNameOrAlias, secretCap)) {
      this.recordAudit(
        "authorizeSecret",
        context,
        "denied",
        {
          secretName: secretNameOrAlias,
          mode,
          reason: "NOT_AUTHORIZED",
        },
        {
          durationMs: Date.now() - startTime,
          error: {
            code: "OPERATION_NOT_PERMITTED",
            message: `Secret '${secretNameOrAlias}' is not authorized by capability grant`,
          },
        }
      );
      throw new BrokerSecurityError(
        "OPERATION_NOT_PERMITTED",
        `Secret '${secretNameOrAlias}' is not authorized by capability grant`
      );
    }

    const workspaceId = context.workspaceId ?? grant.workspaceId;

    try {
      const secretValue = await this.manager.getSecretForMediation(
        secretNameOrAlias,
        mode,
        workspaceId
      );

      this.recordAudit(
        "mediateSecret",
        context,
        "allowed",
        {
          secretName: secretNameOrAlias,
          mode,
        },
        { durationMs: Date.now() - startTime }
      );

      return secretValue;
    } catch (err) {
      this.recordAudit(
        "mediateSecret",
        context,
        "error",
        {
          secretName: secretNameOrAlias,
          mode,
          error: (err as Error).message,
        },
        {
          durationMs: Date.now() - startTime,
          error: { code: "OPERATION_NOT_PERMITTED", message: (err as Error).message },
        }
      );
      throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", (err as Error).message);
    }
  }

  /**
   * Mediates network headers by replacing secret template placeholders (e.g. {{secret:ALIAS}} or {{ALIAS}}).
   */
  async mediateHeaders(
    headers: Record<string, string>,
    context: BrokerContext
  ): Promise<Record<string, string>> {
    if (!headers || typeof headers !== "object") {
      return headers;
    }

    const mediatedHeaders: Record<string, string> = {};
    const placeholderRegex = /\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}/g;

    for (const [key, rawValue] of Object.entries(headers)) {
      if (typeof rawValue !== "string" || !rawValue.includes("{{")) {
        mediatedHeaders[key] = rawValue;
        continue;
      }

      let mediatedValue = rawValue;
      const matches = Array.from(rawValue.matchAll(placeholderRegex));

      for (const match of matches) {
        const fullPlaceholder = match[0];
        const secretAlias = match[1];

        // Authorize and retrieve secret
        const mode: MediationMode = key.toLowerCase() === "authorization" && rawValue.startsWith("Bearer ")
          ? "bearer_token"
          : "header_template";

        const secretValue = await this.authorizeSecretAccess(secretAlias, context, mode);
        mediatedValue = mediatedValue.replaceAll(fullPlaceholder, secretValue);
      }

      mediatedHeaders[key] = mediatedValue;
    }

    return mediatedHeaders;
  }

  /**
   * Mediates a Bearer token authorization header directly for a secret alias.
   */
  async mediateBearerToken(
    secretAlias: string,
    context: BrokerContext
  ): Promise<{ headerName: "Authorization"; headerValue: string }> {
    const secretValue = await this.authorizeSecretAccess(secretAlias, context, "bearer_token");
    return {
      headerName: "Authorization",
      headerValue: `Bearer ${secretValue}`,
    };
  }

  /**
   * Mediates URLs by resolving query parameter or path template placeholders (e.g. {{secret:ALIAS}} or {{ALIAS}}).
   */
  async mediateUrl(url: string, context: BrokerContext): Promise<string> {
    if (!url || typeof url !== "string" || !url.includes("{{")) {
      return url;
    }

    let mediatedUrl = url;
    const placeholderRegex = /\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}/g;
    const matches = Array.from(url.matchAll(placeholderRegex));

    for (const match of matches) {
      const fullPlaceholder = match[0];
      const secretAlias = match[1];

      const secretValue = await this.authorizeSecretAccess(secretAlias, context, "query_template");
      mediatedUrl = mediatedUrl.replaceAll(fullPlaceholder, encodeURIComponent(secretValue));
    }

    return mediatedUrl;
  }

  /**
   * Mediates command execution stdin by injecting secret templates or resolving aliases.
   */
  async mediateCommandStdin(
    secretAliasOrTemplate: string,
    context: BrokerContext
  ): Promise<string> {
    if (!secretAliasOrTemplate || typeof secretAliasOrTemplate !== "string") {
      return secretAliasOrTemplate;
    }

    const placeholderRegex = /\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}/g;
    if (secretAliasOrTemplate.includes("{{")) {
      let mediated = secretAliasOrTemplate;
      const matches = Array.from(secretAliasOrTemplate.matchAll(placeholderRegex));

      for (const match of matches) {
        const fullPlaceholder = match[0];
        const secretAlias = match[1];

        const secretValue = await this.authorizeSecretAccess(secretAlias, context, "command_stdin");
        mediated = mediated.replaceAll(fullPlaceholder, secretValue);
      }

      return mediated;
    }

    // Direct secret alias name passed
    return this.authorizeSecretAccess(secretAliasOrTemplate, context, "command_stdin");
  }

  /**
   * Mediates command environment variables by resolving secret templates and applying injectAsEnv policy.
   */
  async mediateCommandEnv(
    envTemplate: Record<string, string>,
    context: BrokerContext
  ): Promise<Record<string, string>> {
    const grant = this.validateGrant(context);
    const secretCap: SecretCapability = grant.capabilities.secrets ?? {};

    const mediatedEnv: Record<string, string> = { ...(envTemplate ?? {}) };
    const placeholderRegex = /\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}/g;

    // 1. Resolve any explicit template values in envTemplate
    for (const [key, rawValue] of Object.entries(mediatedEnv)) {
      if (typeof rawValue !== "string" || !rawValue.includes("{{")) {
        continue;
      }

      let mediatedValue = rawValue;
      const matches = Array.from(rawValue.matchAll(placeholderRegex));

      for (const match of matches) {
        const fullPlaceholder = match[0];
        const secretAlias = match[1];

        const secretValue = await this.authorizeSecretAccess(secretAlias, context, "command_env");
        mediatedValue = mediatedValue.replaceAll(fullPlaceholder, secretValue);
      }

      mediatedEnv[key] = mediatedValue;
    }

    // 2. Automatically inject authorized secrets if injectAsEnv is enabled
    if (secretCap.injectAsEnv && secretCap.allowedSecretNames) {
      const workspaceId = context.workspaceId ?? grant.workspaceId;
      for (const name of secretCap.allowedSecretNames) {
        if (mediatedEnv[name] === undefined) {
          try {
            const secretValue = await this.manager.getSecretForMediation(
              name,
              "command_env",
              workspaceId
            );
            mediatedEnv[name] = secretValue;
          } catch {
            // Secret may not exist in store, ignore
          }
        }
      }
    }

    return mediatedEnv;
  }

  /**
   * Resolves raw secret directly only when denyDirectRead is explicitly false and authorized.
   */
  async getSecret(secretName: string, context: BrokerContext): Promise<{ secret: string | null }> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const secretCap: SecretCapability = grant.capabilities.secrets ?? {};

    if (!secretName) {
      throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", "Secret name must be specified");
    }

    // Direct read is denied by policy by default
    if (secretCap.denyDirectRead) {
      this.recordAudit(
        "getSecret",
        context,
        "denied",
        {
          secretName,
          reason: "DIRECT_READ_DENIED",
        },
        {
          durationMs: Date.now() - startTime,
          error: {
            code: "OPERATION_NOT_PERMITTED",
            message: `Direct read of secret '${secretName}' is denied by policy`,
          },
        }
      );
      throw new BrokerSecurityError(
        "OPERATION_NOT_PERMITTED",
        `Direct read of secret '${secretName}' is denied by policy`
      );
    }

    // Check authorization
    if (!this.isSecretAuthorized(secretName, secretCap)) {
      this.recordAudit(
        "getSecret",
        context,
        "denied",
        {
          secretName,
          reason: "NOT_AUTHORIZED",
        },
        {
          durationMs: Date.now() - startTime,
          error: {
            code: "OPERATION_NOT_PERMITTED",
            message: `Secret '${secretName}' is not authorized by capability grant`,
          },
        }
      );
      throw new BrokerSecurityError(
        "OPERATION_NOT_PERMITTED",
        `Secret '${secretName}' is not authorized by capability grant`
      );
    }

    const workspaceId = context.workspaceId ?? grant.workspaceId;
    const value = await this.manager.getStore().getSecret(secretName, workspaceId);

    this.recordAudit(
      "getSecret",
      context,
      "allowed",
      {
        secretName,
        found: value !== null,
      },
      { durationMs: Date.now() - startTime }
    );

    return { secret: value };
  }

  /**
   * Lists secret metadata authorized under the current grant context.
   */
  async listMetadata(context: BrokerContext): Promise<SecretMetadata[]> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const secretCap: SecretCapability = grant.capabilities.secrets ?? {};
    const workspaceId = context.workspaceId ?? grant.workspaceId;

    const allMetadata = await this.manager.listMetadata(workspaceId);

    // Filter to only authorized secrets if allowlists are configured
    const filtered = allMetadata.filter((meta) =>
      this.isSecretAuthorized(meta.name, secretCap) ||
      (meta.alias && this.isSecretAuthorized(meta.alias, secretCap))
    );

    this.recordAudit(
      "listMetadata",
      context,
      "allowed",
      { count: filtered.length },
      { durationMs: Date.now() - startTime }
    );

    return filtered;
  }

  /**
   * Adds a new named secret to the store.
   */
  async addSecret(
    name: string,
    value: string,
    options?: SetSecretOptions
  ): Promise<SecretMetadata> {
    return this.manager.addSecret(name, value, options);
  }

  /**
   * Rotates a secret.
   */
  async rotateSecret(
    name: string,
    newValue: string,
    workspaceId?: string
  ): Promise<SecretMetadata> {
    return this.manager.rotateSecret(name, newValue, workspaceId);
  }

  /**
   * Deletes a secret.
   */
  async deleteSecret(name: string, workspaceId?: string): Promise<boolean> {
    return this.manager.deleteSecret(name, workspaceId);
  }

  /**
   * Purges secrets.
   */
  async purgeSecrets(workspaceId?: string): Promise<number> {
    return this.manager.purgeSecrets(workspaceId);
  }

  /**
   * Returns secret redactor.
   */
  getRedactor(): SecretRedactor {
    return this.manager.getRedactor();
  }

  /**
   * Unified dispatcher for secret broker operations.
   */
  async handleRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext
  ): Promise<unknown> {
    switch (action) {
      case "getSecret":
      case "read":
      case "resolve":
        return this.getSecret(String(payload.name ?? ""), context);

      case "mediateHeaders":
        return this.mediateHeaders(
          (payload.headers as Record<string, string>) ?? {},
          context
        );

      case "mediateBearerToken":
        return this.mediateBearerToken(String(payload.alias ?? payload.name ?? ""), context);

      case "mediateUrl":
        return this.mediateUrl(String(payload.url ?? ""), context);

      case "mediateCommandStdin":
        return this.mediateCommandStdin(
          String(payload.template ?? payload.alias ?? payload.name ?? ""),
          context
        );

      case "mediateCommandEnv":
        return this.mediateCommandEnv(
          (payload.env as Record<string, string>) ?? {},
          context
        );

      case "listMetadata":
      case "list":
        return this.listMetadata(context);

      case "addSecret":
        return this.addSecret(
          String(payload.name ?? ""),
          String(payload.value ?? ""),
          payload.options as SetSecretOptions | undefined
        );

      case "rotateSecret":
        return this.rotateSecret(
          String(payload.name ?? ""),
          String(payload.value ?? ""),
          payload.workspaceId as string | undefined
        );

      case "deleteSecret":
        return this.deleteSecret(
          String(payload.name ?? ""),
          payload.workspaceId as string | undefined
        );

      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported secret broker action: '${action}'`
        );
    }
  }
}
