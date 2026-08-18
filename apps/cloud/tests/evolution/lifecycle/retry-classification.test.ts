import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICIES,
  classifyError,
  extractErrorMessage,
  redactDiagnostics,
} from "../../../src/evolution/lifecycle/retry-classifier.js";

describe("Candidate Lifecycle - Retry Classification Engine & Diagnostics Redaction", () => {
  it("should classify provider outages and model gateway failures as transient with retry budget", () => {
    const error503 = new Error(
      "503 Service Unavailable: upstream connect error or disconnect/reset before headers",
    );
    const res = classifyError(error503, 1);
    expect(res.category).toBe("provider_outage");
    expect(res.classification).toBe("transient");
    expect(res.retryable).toBe(true);
    expect(res.maxRetries).toBe(DEFAULT_RETRY_POLICIES.provider_outage.maxRetries);
    expect(res.backoffMs).toBe(1000);

    const res2 = classifyError(error503, 2);
    expect(res2.backoffMs).toBe(2000);
  });

  it("should classify rate limits and resource exhaustion as transient with high retry budget", () => {
    const rateLimitErr = {
      name: "RateLimitError",
      status: 429,
      message: "Rate limit exceeded for organization: too many requests per minute",
    };
    const res = classifyError(rateLimitErr, 1);
    expect(res.category).toBe("rate_limit");
    expect(res.classification).toBe("transient");
    expect(res.retryable).toBe(true);
    expect(res.maxRetries).toBe(5);
    expect(res.backoffMs).toBe(2000);

    const res3 = classifyError(rateLimitErr, 3);
    expect(res3.backoffMs).toBe(8000);
  });

  it("should classify malformed output and JSON parsing errors as terminal", () => {
    const parseError = new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
    const res = classifyError(parseError, 1);
    expect(res.category).toBe("malformed_output");
    expect(res.classification).toBe("terminal");
    expect(res.retryable).toBe(false);
    expect(res.maxRetries).toBe(0);
    expect(res.backoffMs).toBe(0);
  });

  it("should classify database restarts and connection terminations as transient", () => {
    const dbError = new Error(
      "terminating connection due to administrator command (database restart)",
    );
    dbError.name = "DatabaseConnectionError";
    const res = classifyError(dbError, 1);
    expect(res.category).toBe("database_restart");
    expect(res.classification).toBe("transient");
    expect(res.retryable).toBe(true);
    expect(res.maxRetries).toBe(4);
  });

  it("should classify object store 500 errors as transient", () => {
    const s3Error = new Error("ObjectStoreError: S3 500 Internal Error on PutObject");
    s3Error.name = "ObjectStoreError";
    const res = classifyError(s3Error, 1);
    expect(res.category).toBe("object_store_failure");
    expect(res.classification).toBe("transient");
    expect(res.retryable).toBe(true);
  });

  it("should differentiate revoked signing keys (terminal) from transient KMS timeouts", () => {
    const revokedError = new Error("Signing key 'key_revoked_123' is revoked and cannot be used");
    revokedError.name = "SigningKeyRevokedError";
    const revokedRes = classifyError(revokedError, 1);
    expect(revokedRes.category).toBe("signing_failure");
    expect(revokedRes.classification).toBe("terminal");
    expect(revokedRes.retryable).toBe(false);

    const kmsTimeoutError = new Error(
      "KMS crypto signature service timeout during artifact signing",
    );
    const kmsRes = classifyError(kmsTimeoutError, 1);
    expect(kmsRes.category).toBe("signing_failure");
    expect(kmsRes.classification).toBe("transient");
    expect(kmsRes.retryable).toBe(true);
  });

  it("should classify worker process deaths and stage crashes as transient", () => {
    const crashError = new Error("Worker process died on SIGKILL during stage boundary");
    crashError.name = "WorkerProcessDied";
    const res = classifyError(crashError, 1);
    expect(res.category).toBe("worker_crash");
    expect(res.classification).toBe("transient");
    expect(res.retryable).toBe(true);
  });

  it("should classify capability broadening and envelope violations as terminal", () => {
    const capError = new Error(
      "Capability broadened: child revision requested unauthorized host 'attacker.org'",
    );
    capError.name = "CapabilityEnvelopeViolation";
    const res = classifyError(capError, 1);
    expect(res.category).toBe("capability_violation");
    expect(res.classification).toBe("terminal");
    expect(res.retryable).toBe(false);
  });

  it("should transition transient errors to terminal when retry budget is exhausted", () => {
    const dbErr = new Error("DatabaseConnectionError: connection refused");
    const maxRetries = DEFAULT_RETRY_POLICIES.database_restart.maxRetries;

    // Within budget
    const withinBudget = classifyError(dbErr, maxRetries);
    expect(withinBudget.classification).toBe("transient");
    expect(withinBudget.retryable).toBe(true);

    // Budget exceeded (attempt = maxRetries + 1)
    const exhausted = classifyError(dbErr, maxRetries + 1);
    expect(exhausted.category).toBe("attempts_exhausted");
    expect(exhausted.classification).toBe("terminal");
    expect(exhausted.retryable).toBe(false);
    expect(exhausted.reason).toContain("Retry budget exhausted");
  });

  it("should redact sensitive tokens, passwords, API keys, and Authorization headers in diagnostics", () => {
    const rawDiagnostics = {
      apiKey: "sk-abcdef1234567890abcdef1234567890",
      dbPassword: "superSecretPassword123!",
      authHeader:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis",
      safeMetadata: {
        stage: "validate",
        durationMs: 42,
        nestedConfig: {
          client_secret: "top_secret_token",
          publicEndpoint: "https://api.example.com",
        },
      },
      errorList: [
        "Failed request with Authorization: Bearer secretTokenValue",
        "Connection OK to https://api.weather.com",
      ],
    };

    const redacted = redactDiagnostics(rawDiagnostics) as Record<string, unknown>;
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.dbPassword).toBe("[REDACTED]");
    expect(redacted.authHeader).toBe("[REDACTED]");

    const safeMeta = redacted.safeMetadata as Record<string, unknown>;
    expect(safeMeta.stage).toBe("validate");
    expect(safeMeta.durationMs).toBe(42);

    const nested = safeMeta.nestedConfig as Record<string, unknown>;
    expect(nested.client_secret).toBe("[REDACTED]");
    expect(nested.publicEndpoint).toBe("https://api.example.com");

    const errList = redacted.errorList as string[];
    expect(errList[0]).not.toContain("secretTokenValue");
    expect(errList[0]).toContain("Bearer [REDACTED]");
    expect(errList[1]).toBe("Connection OK to https://api.weather.com");
  });

  it("should extract clean error message strings from any error type", () => {
    expect(extractErrorMessage(new Error("Database offline"))).toBe("Database offline");
    expect(extractErrorMessage("String error message")).toBe("String error message");
    expect(extractErrorMessage({ message: "Custom object error" })).toContain(
      "Custom object error",
    );
  });
});
