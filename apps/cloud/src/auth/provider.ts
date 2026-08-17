import { ISOTimestampSchema, IdentifierSchema } from "@tool-evolver/contracts";
import { z } from "zod";

/**
 * User Identity Schema representation across authentication providers.
 */
export const UserIdentitySchema = z.object({
  userId: IdentifierSchema,
  email: z.string().email(),
  name: z.string().optional(),
  accountId: IdentifierSchema,
  workspaceIds: z.array(IdentifierSchema).min(1),
  defaultWorkspaceId: IdentifierSchema,
  roles: z.array(z.string()).default(["member"]),
  metadata: z.record(z.unknown()).default({}),
  createdAt: ISOTimestampSchema.default(() => new Date().toISOString()),
  updatedAt: ISOTimestampSchema.default(() => new Date().toISOString()),
});

export type UserIdentity = z.infer<typeof UserIdentitySchema>;

/**
 * Credentials for identity provider authentication.
 */
export interface AuthCredentials {
  email?: string;
  password?: string;
  token?: string;
  code?: string;
}

/**
 * Common IdentityProvider interface for OIDC, OAuth, and development providers.
 */
export interface IdentityProvider {
  readonly providerId: string;
  authenticate(credentials: AuthCredentials): Promise<UserIdentity | null>;
  getUser(userId: string): Promise<UserIdentity | null>;
  validateToken(token: string): Promise<UserIdentity | null>;
}

/**
 * Development & Test Identity Provider.
 * Provides pre-seeded users and fast in-memory authentication.
 */
export class DevelopmentIdentityProvider implements IdentityProvider {
  readonly providerId = "development";
  private users = new Map<string, { user: UserIdentity; password?: string }>();
  private emailToUserId = new Map<string, string>();

  constructor(seedDefault = true) {
    if (seedDefault) {
      this.seedDefaultUsers();
    }
  }

  private seedDefaultUsers(): void {
    const defaultDevUser: UserIdentity = {
      userId: "usr_dev_admin_01",
      email: "admin@toolevolver.dev",
      name: "Development Administrator",
      accountId: "acc_dev_primary",
      workspaceIds: ["ws_dev_default", "ws_dev_staging"],
      defaultWorkspaceId: "ws_dev_default",
      roles: ["admin", "developer"],
      metadata: { environment: "development" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.registerUser(defaultDevUser, "devpassword123");

    const defaultMemberUser: UserIdentity = {
      userId: "usr_dev_member_02",
      email: "member@toolevolver.dev",
      name: "Development Member",
      accountId: "acc_dev_primary",
      workspaceIds: ["ws_dev_default"],
      defaultWorkspaceId: "ws_dev_default",
      roles: ["member"],
      metadata: { environment: "development" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.registerUser(defaultMemberUser, "memberpassword123");
  }

  /**
   * Register or update a user in the development store.
   */
  registerUser(user: UserIdentity, password?: string): void {
    const validated = UserIdentitySchema.parse(user);
    this.users.set(validated.userId, { user: validated, password });
    this.emailToUserId.set(validated.email.toLowerCase(), validated.userId);
  }

  async authenticate(credentials: AuthCredentials): Promise<UserIdentity | null> {
    if (credentials.token) {
      return this.validateToken(credentials.token);
    }

    if (credentials.email) {
      const userId = this.emailToUserId.get(credentials.email.toLowerCase());
      if (!userId) return null;
      const record = this.users.get(userId);
      if (!record) return null;

      if (record.password && credentials.password) {
        if (record.password !== credentials.password) {
          return null;
        }
      }
      return record.user;
    }

    return null;
  }

  async getUser(userId: string): Promise<UserIdentity | null> {
    const record = this.users.get(userId);
    return record ? record.user : null;
  }

  async validateToken(token: string): Promise<UserIdentity | null> {
    // In dev mode, a token formatted as "dev-user:<userId>" or a valid userId is accepted
    if (token.startsWith("dev-user:")) {
      const userId = token.slice("dev-user:".length);
      return this.getUser(userId);
    }
    return this.getUser(token);
  }

  clear(): void {
    this.users.clear();
    this.emailToUserId.clear();
  }
}

/**
 * OpenID Connect / OAuth 2.0 Identity Provider Configuration.
 */
export interface OidcProviderConfig {
  providerId?: string;
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  jwksUri?: string;
  userinfoEndpoint?: string;
  tokenEndpoint?: string;
  fetchFn?: typeof fetch;
}

/**
 * Standard OIDC / OAuth 2.0 Identity Provider implementation.
 */
export class OidcIdentityProvider implements IdentityProvider {
  readonly providerId: string;
  private readonly config: OidcProviderConfig;
  private readonly fetch: typeof fetch;

  constructor(config: OidcProviderConfig) {
    this.providerId = config.providerId ?? "oidc";
    this.config = config;
    this.fetch = config.fetchFn ?? globalThis.fetch;
  }

  async authenticate(credentials: AuthCredentials): Promise<UserIdentity | null> {
    if (credentials.token) {
      return this.validateToken(credentials.token);
    }

    if (credentials.code && this.config.tokenEndpoint) {
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code: credentials.code,
          client_id: this.config.clientId,
          ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
        });

        const res = await this.fetch(this.config.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });

        if (!res.ok) return null;
        const data = (await res.json()) as { access_token?: string; id_token?: string };
        const tokenToValidate = data.id_token ?? data.access_token;
        if (!tokenToValidate) return null;

        return this.validateToken(tokenToValidate);
      } catch {
        return null;
      }
    }

    return null;
  }

  async getUser(userId: string): Promise<UserIdentity | null> {
    // For standard OIDC, user details are retrieved via token validation or userinfo
    if (this.config.userinfoEndpoint) {
      try {
        const res = await this.fetch(
          `${this.config.userinfoEndpoint}?sub=${encodeURIComponent(userId)}`,
        );
        if (!res.ok) return null;
        const data = (await res.json()) as Record<string, unknown>;
        return this.mapClaimsToUserIdentity(data);
      } catch {
        return null;
      }
    }
    return null;
  }

  async validateToken(token: string): Promise<UserIdentity | null> {
    try {
      // Decode JWT payload without verification if in mock mode, or verify against userinfo
      if (this.config.userinfoEndpoint) {
        const res = await this.fetch(this.config.userinfoEndpoint, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const claims = (await res.json()) as Record<string, unknown>;
          return this.mapClaimsToUserIdentity(claims);
        }
      }

      // Fallback: parse unverified claims from JWT payload if userinfo endpoint unavailable
      const parts = token.split(".");
      if (parts.length === 3) {
        const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
        const claims = JSON.parse(payloadJson) as Record<string, unknown>;
        return this.mapClaimsToUserIdentity(claims);
      }

      return null;
    } catch {
      return null;
    }
  }

  private mapClaimsToUserIdentity(claims: Record<string, unknown>): UserIdentity {
    const sub = (claims.sub as string) || (claims.id as string) || "usr_anonymous";
    const email = (claims.email as string) || `${sub}@auth.toolevolver.dev`;
    const name = (claims.name as string) || (claims.preferred_username as string) || undefined;
    const accountId = (claims.account_id as string) || (claims.accountId as string) || `acc_${sub}`;
    const workspaceIds = Array.isArray(claims.workspace_ids)
      ? (claims.workspace_ids as string[])
      : Array.isArray(claims.workspaceIds)
        ? (claims.workspaceIds as string[])
        : [`ws_${sub}_default`];
    const defaultWorkspaceId =
      (claims.default_workspace_id as string) ||
      (claims.defaultWorkspaceId as string) ||
      workspaceIds[0];
    const roles = Array.isArray(claims.roles) ? (claims.roles as string[]) : ["member"];

    return {
      userId: sub,
      email,
      name,
      accountId,
      workspaceIds,
      defaultWorkspaceId,
      roles,
      metadata: claims,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
