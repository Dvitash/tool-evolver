import { describe, expect, it } from "vitest";
import {
  DevelopmentIdentityProvider,
  OidcIdentityProvider,
} from "../../src/auth/provider.js";

describe("Identity Providers", () => {
  describe("DevelopmentIdentityProvider", () => {
    it("should authenticate pre-seeded dev admin user", async () => {
      const provider = new DevelopmentIdentityProvider();

      const user = await provider.authenticate({
        email: "admin@toolevolver.dev",
        password: "devpassword123",
      });

      expect(user).not.toBeNull();
      expect(user?.userId).toBe("usr_dev_admin_01");
      expect(user?.roles).toContain("admin");
      expect(user?.accountId).toBe("acc_dev_primary");
    });

    it("should reject invalid password", async () => {
      const provider = new DevelopmentIdentityProvider();

      const user = await provider.authenticate({
        email: "admin@toolevolver.dev",
        password: "wrongpassword",
      });

      expect(user).toBeNull();
    });

    it("should allow registering custom test users", async () => {
      const provider = new DevelopmentIdentityProvider(false);

      provider.registerUser(
        {
          userId: "usr_custom_test",
          email: "custom@example.com",
          name: "Custom User",
          accountId: "acc_custom",
          workspaceIds: ["ws_custom_1"],
          defaultWorkspaceId: "ws_custom_1",
          roles: ["developer"],
          metadata: {},
        },
        "custompass",
      );

      const user = await provider.authenticate({
        email: "custom@example.com",
        password: "custompass",
      });

      expect(user).not.toBeNull();
      expect(user?.userId).toBe("usr_custom_test");

      const byToken = await provider.validateToken("dev-user:usr_custom_test");
      expect(byToken?.userId).toBe("usr_custom_test");
    });
  });

  describe("OidcIdentityProvider", () => {
    it("should extract user identity from JWT claims payload", async () => {
      const provider = new OidcIdentityProvider({
        issuerUrl: "https://auth.example.com",
        clientId: "tool-evolver-app",
      });

      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: "usr_oidc_999",
          email: "oidc-user@example.com",
          name: "OIDC User",
          account_id: "acc_oidc_enterprise",
          workspace_ids: ["ws_oidc_prod", "ws_oidc_dev"],
          roles: ["admin", "engineer"],
        }),
      ).toString("base64url");
      const mockToken = `${header}.${payload}.mockSignature`;

      const user = await provider.validateToken(mockToken);
      expect(user).not.toBeNull();
      expect(user?.userId).toBe("usr_oidc_999");
      expect(user?.email).toBe("oidc-user@example.com");
      expect(user?.accountId).toBe("acc_oidc_enterprise");
      expect(user?.workspaceIds).toContain("ws_oidc_prod");
      expect(user?.roles).toContain("admin");
    });
  });
});
