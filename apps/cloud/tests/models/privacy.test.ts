import { describe, expect, it } from "vitest";
import {
  FakeModelProvider,
  OutboundPrivacyGate,
  PrivacyViolationError,
  createInferenceService,
} from "../../src/models/index.js";

describe("Outbound Privacy Gate & Secret Redaction", () => {
  it("should redact API keys, Bearer tokens, GitHub PATs, AWS keys, and passwords", () => {
    const gate = new OutboundPrivacyGate();
    const rawText = `
      OpenAI: sk-abc1234567890abcdef1234567890
      GitHub: ghp_1234567890abcdefghijklmnopqrstuvwxyz
      Bearer: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz
      AWS: AKIAIOSFODNN7EXAMPLE
      Password: password="SuperSecretPassword123!"
      Email: developer.test@internal-corp.io
    `;

    const sanitized = gate.redact(rawText);

    expect(sanitized).not.toContain("sk-abc1234567890abcdef1234567890");
    expect(sanitized).toContain("sk-[REDACTED_OPENAI_KEY]");

    expect(sanitized).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(sanitized).toContain("[REDACTED_GITHUB_TOKEN]");

    expect(sanitized).not.toContain("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz");
    expect(sanitized).toContain("Bearer [REDACTED_TOKEN]");

    expect(sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sanitized).toContain("[REDACTED_AWS_ACCESS_KEY]");

    expect(sanitized).not.toContain("SuperSecretPassword123!");
    expect(sanitized).toContain('[REDACTED_SECRET]"');

    expect(sanitized).not.toContain("developer.test@internal-corp.io");
    expect(sanitized).toContain("[REDACTED_EMAIL]");
  });

  it("should redact absolute user file system paths on Unix, macOS, and Windows", () => {
    const gate = new OutboundPrivacyGate();
    const rawText = `
      Unix path: /home/alice/projects/tool-evolver/src/index.ts
      macOS path: /Users/bob/Documents/confidential/specs.pdf
      Windows path: C:\\Users\\charlie\\AppData\\Local\\secret.json
    `;

    const sanitized = gate.redact(rawText);

    expect(sanitized).not.toContain("/home/alice");
    expect(sanitized).not.toContain("/Users/bob");
    expect(sanitized).not.toContain("C:\\Users\\charlie");
    expect(sanitized).toContain("[REDACTED_PATH]");
  });

  it("should redact private RSA/EC/OPENSSH keys", () => {
    const gate = new OutboundPrivacyGate();
    const rawKey = `
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3v...
...some secret key data...
-----END RSA PRIVATE KEY-----
    `;

    const sanitized = gate.redact(rawKey);
    expect(sanitized).not.toContain("some secret key data");
    expect(sanitized).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("should support custom registered secret terms and regex patterns", () => {
    const gate = new OutboundPrivacyGate();
    gate.registerSecretTerm("CONFIDENTIAL_PROJECT_CODENAME_ZEUS");
    gate.registerCustomPattern(
      "internal_db_dsn",
      /postgres:\/\/[a-z]+:[a-z0-9]+@db\.internal:[0-9]+\/[a-z]+/gi,
      "[REDACTED_DSN]",
    );

    const rawText =
      "Connecting to postgres://admin:pass123@db.internal:5432/secrets for project CONFIDENTIAL_PROJECT_CODENAME_ZEUS";
    const sanitized = gate.redact(rawText);

    expect(sanitized).not.toContain("CONFIDENTIAL_PROJECT_CODENAME_ZEUS");
    expect(sanitized).not.toContain("pass123");
    expect(sanitized).toContain("[REDACTED_SECRET]");
    expect(sanitized).toContain("[REDACTED_DSN]");
  });

  it("should block outbound payloads containing unauthorized raw transcripts", async () => {
    const fakeProvider = new FakeModelProvider();
    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    // Default policy does not allow raw transcripts
    await expect(
      service.infer({
        tenantId: "tenant-privacy-test",
        taskClass: "opportunity_detection",
        promptTemplateId: "opportunity_detection",
        inputs: {
          sessionId: "sess-raw",
          traceData:
            "Normal trace data\n[RAW_TRANSCRIPT]\nUser: Here is my proprietary secret source code",
          telemetrySummary: "summary",
        },
      }),
    ).rejects.toThrow(PrivacyViolationError);

    // Ensure provider was never called due to early gate blocking
    expect(fakeProvider.recordedCalls.length).toBe(0);
  });

  it("should allow raw transcripts when explicitly enabled by policy override", async () => {
    const fakeProvider = new FakeModelProvider();
    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const result = await service.infer({
      tenantId: "tenant-privacy-allowed",
      taskClass: "opportunity_detection",
      promptTemplateId: "opportunity_detection",
      inputs: {
        sessionId: "sess-raw-allowed",
        traceData: "Normal trace data\n[RAW_TRANSCRIPT]\nScrubbed conversation snippet",
        telemetrySummary: "summary",
      },
      policyOverride: {
        allowRawTranscripts: true,
      },
    });

    expect(result.output).toBeDefined();
    expect(fakeProvider.recordedCalls.length).toBe(1);
  });
});
