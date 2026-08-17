import { describe, expect, it } from "vitest";
import { redactSecret, redactToken } from "../../src/auth/tokens.js";
import { loadConfig, redactConfig } from "../../src/config.js";

describe("Secret Redaction & Audit Safety", () => {
  it("should redact secrets and tokens safely", () => {
    const rawSecret = "super-secret-jwt-signing-key-123456";
    const redacted = redactSecret(rawSecret);

    expect(redacted).not.toBe(rawSecret);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted.startsWith(rawSecret.slice(0, 4))).toBe(true);
    expect(redacted.endsWith(rawSecret.slice(-4))).toBe(true);

    const empty = redactSecret("");
    expect(empty).toBe("[EMPTY_SECRET]");

    const short = redactSecret("short");
    expect(short).toBe("[REDACTED_SECRET]");
  });

  it("should redact raw JWT tokens in log-safe format", () => {
    const rawToken =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgN_pkwGptEOWvdsmv_3xgo7sCGwF_m_wW_wZg_M";
    const redacted = redactToken(rawToken);

    expect(redacted).not.toBe(rawToken);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("eyJzdWIiOiIxMjM0NTY3ODkwIn0");
  });

  it("should redact sensitive fields in CloudConfig", () => {
    const config = loadConfig({
      database: {
        url: "postgres://admin:superSecretPassword@db.production.internal:5432/toolevolver",
      },
      storage: {
        accessKeyId: "AKIAPRODUCTIONKEY",
        secretAccessKey: "secretStorageKey987654321",
      },
      auth: {
        jwtSecret: "jwtSuperSecretKeyLongerThan16Chars",
        deviceTokenSecret: "deviceTokenSecretKeyLongerThan16",
      },
    });

    const redacted = redactConfig(config);

    // Database URL must have password masked
    expect(redacted.database.url).not.toContain("superSecretPassword");
    expect(redacted.database.url).toContain("*****");

    // Storage secrets must be masked
    expect(redacted.storage.secretAccessKey).toBe("[REDACTED]");

    // Auth secrets must be masked
    expect(redacted.auth.jwtSecret).toBe("[REDACTED]");
    expect(redacted.auth.deviceTokenSecret).toBe("[REDACTED]");
  });
});
