import type {
  ErrorCategory,
  RetryClassificationResult,
  RetryClassificationType,
  RetryPolicy,
} from "./types.js";

/**
 * Standard default retry policies for each error category.
 */
export const DEFAULT_RETRY_POLICIES: Record<ErrorCategory, RetryPolicy> = {
  provider_outage: {
    maxRetries: 4,
    initialBackoffMs: 1000,
    maxBackoffMs: 30000,
    backoffMultiplier: 2,
  },
  rate_limit: {
    maxRetries: 5,
    initialBackoffMs: 2000,
    maxBackoffMs: 60000,
    backoffMultiplier: 2,
  },
  malformed_output: {
    maxRetries: 0,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    backoffMultiplier: 1,
  },
  queue_delay: {
    maxRetries: 3,
    initialBackoffMs: 500,
    maxBackoffMs: 10000,
    backoffMultiplier: 2,
  },
  database_restart: {
    maxRetries: 4,
    initialBackoffMs: 1000,
    maxBackoffMs: 20000,
    backoffMultiplier: 2,
  },
  object_store_failure: {
    maxRetries: 3,
    initialBackoffMs: 1000,
    maxBackoffMs: 15000,
    backoffMultiplier: 2,
  },
  signing_failure: {
    maxRetries: 3,
    initialBackoffMs: 1000,
    maxBackoffMs: 10000,
    backoffMultiplier: 2,
  },
  worker_crash: {
    maxRetries: 3,
    initialBackoffMs: 500,
    maxBackoffMs: 5000,
    backoffMultiplier: 1.5,
  },
  validation_failure: {
    maxRetries: 0,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    backoffMultiplier: 1,
  },
  replay_divergence: {
    maxRetries: 0,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    backoffMultiplier: 1,
  },
  evaluation_hard_gate: {
    maxRetries: 0,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    backoffMultiplier: 1,
  },
  capability_violation: {
    maxRetries: 0,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    backoffMultiplier: 1,
  },
  attempts_exhausted: {
    maxRetries: 0,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    backoffMultiplier: 1,
  },
  unknown_error: {
    maxRetries: 1,
    initialBackoffMs: 1000,
    maxBackoffMs: 5000,
    backoffMultiplier: 2,
  },
};

/**
 * Classifies an error into an ErrorCategory, RetryClassificationType, and computed backoff.
 */
export function classifyError(
  error: unknown,
  attempt = 1,
  customPolicies?: Partial<Record<ErrorCategory, RetryPolicy>>,
): RetryClassificationResult {
  const policies = { ...DEFAULT_RETRY_POLICIES, ...customPolicies };
  const message = extractErrorMessage(error);
  const lowerMessage = message.toLowerCase();
  const errorObj = error instanceof Error ? error : ({} as Record<string, unknown>);
  const errorName = typeof errorObj.name === "string" ? errorObj.name : "";
  const statusCode =
    typeof (errorObj as { status?: number }).status === "number"
      ? (errorObj as { status?: number }).status
      : typeof (errorObj as { statusCode?: number }).statusCode === "number"
        ? (errorObj as { statusCode?: number }).statusCode
        : undefined;

  let category: ErrorCategory = "unknown_error";
  let classification: RetryClassificationType = "terminal";

  // 1. Signing Failure (Check revoked vs transient)
  if (
    errorName === "SigningKeyRevokedError" ||
    (lowerMessage.includes("signing key") && lowerMessage.includes("revoked")) ||
    lowerMessage.includes("key is revoked")
  ) {
    category = "signing_failure";
    classification = "terminal";
  } else if (
    lowerMessage.includes("kms") ||
    lowerMessage.includes("signing service") ||
    lowerMessage.includes("signature generation failed") ||
    lowerMessage.includes("crypto timeout")
  ) {
    category = "signing_failure";
    classification = "transient";
  }
  // 2. Capability Violation / Broadening
  else if (
    errorName === "CapabilityEnvelopeViolation" ||
    lowerMessage.includes("capability broadened") ||
    lowerMessage.includes("broaden capabilities") ||
    lowerMessage.includes("undeclared capability") ||
    lowerMessage.includes("capability envelope violation")
  ) {
    category = "capability_violation";
    classification = "terminal";
  }
  // 3. Evaluation Hard Gate Violation
  else if (
    errorName === "HardGateError" ||
    lowerMessage.includes("hard gate") ||
    lowerMessage.includes("safety gate violation") ||
    lowerMessage.includes("forbidden import") ||
    lowerMessage.includes("prompt injection")
  ) {
    category = "evaluation_hard_gate";
    classification = "terminal";
  }
  // 4. Rate Limits
  else if (
    statusCode === 429 ||
    errorName === "RateLimitError" ||
    errorName === "QuotaExceededError" ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("too many requests") ||
    lowerMessage.includes("throttl") ||
    lowerMessage.includes("resource_exhausted") ||
    lowerMessage.includes("quota exceeded")
  ) {
    category = "rate_limit";
    classification = "transient";
  }
  // 5. Provider Outage / LLM API Disruption
  else if (
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    errorName === "ProviderUnavailableError" ||
    lowerMessage.includes("provider outage") ||
    lowerMessage.includes("provider unavailable") ||
    lowerMessage.includes("model provider") ||
    lowerMessage.includes("inference service unavailable") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("etimedout") ||
    lowerMessage.includes("enotfound") ||
    lowerMessage.includes("upstream connect error")
  ) {
    category = "provider_outage";
    classification = "transient";
  }
  // 6. Malformed Output / Parse Failures
  else if (
    errorName === "SyntaxError" ||
    errorName === "ZodError" ||
    lowerMessage.includes("malformed output") ||
    lowerMessage.includes("malformed json") ||
    lowerMessage.includes("unexpected token") ||
    lowerMessage.includes("json.parse") ||
    lowerMessage.includes("schema validation failed") ||
    lowerMessage.includes("unparseable response")
  ) {
    category = "malformed_output";
    classification = "terminal";
  }
  // 7. Database Restart / Connection Drop
  else if (
    errorName === "DatabaseConnectionError" ||
    lowerMessage.includes("database restart") ||
    lowerMessage.includes("connection terminated") ||
    lowerMessage.includes("connection reset") ||
    lowerMessage.includes("deadlock detected") ||
    lowerMessage.includes("terminating connection due to administrator command") ||
    lowerMessage.includes("pool timeout") ||
    lowerMessage.includes("connection refused")
  ) {
    category = "database_restart";
    classification = "transient";
  }
  // 8. Object Store Failure
  else if (
    errorName === "ObjectStoreError" ||
    lowerMessage.includes("object store") ||
    lowerMessage.includes("objectstore") ||
    lowerMessage.includes("s3 500") ||
    lowerMessage.includes("nosuchbucket") ||
    lowerMessage.includes("blob storage unavailable") ||
    lowerMessage.includes("storage client error")
  ) {
    category = "object_store_failure";
    classification = "transient";
  }
  // 9. Worker Crash / Process Killed
  else if (
    errorName === "WorkerProcessDied" ||
    lowerMessage.includes("worker crash") ||
    lowerMessage.includes("process killed") ||
    lowerMessage.includes("sigkill") ||
    lowerMessage.includes("sigterm") ||
    lowerMessage.includes("heartbeat timeout") ||
    lowerMessage.includes("stage boundary crash")
  ) {
    category = "worker_crash";
    classification = "transient";
  }
  // 10. Queue Delay / Timeout
  else if (
    errorName === "QueueTimeoutError" ||
    lowerMessage.includes("queue delay") ||
    lowerMessage.includes("visibility timeout") ||
    lowerMessage.includes("job timeout") ||
    lowerMessage.includes("deadline exceeded")
  ) {
    category = "queue_delay";
    classification = "transient";
  }
  // 11. Validation Failure
  else if (
    lowerMessage.includes("validation failed") ||
    lowerMessage.includes("validation") ||
    lowerMessage.includes("static analysis finding") ||
    lowerMessage.includes("typecheck") ||
    lowerMessage.includes("type check") ||
    lowerMessage.includes("child_process") ||
    lowerMessage.includes("forbidden") ||
    lowerMessage.includes("malicious")
  ) {
    category = "validation_failure";
    classification = "terminal";
  }
  // 12. Replay Divergence
  else if (
    lowerMessage.includes("replay divergence") ||
    lowerMessage.includes("replay diverged") ||
    lowerMessage.includes("invariant violated")
  ) {
    category = "replay_divergence";
    classification = lowerMessage.includes("terminal") ? "terminal" : "repairable";
  }

  const policy = policies[category] ?? policies.unknown_error;

  // Check if attempt count has exhausted the retry budget for transient errors
  if (classification === "transient") {
    if (attempt > policy.maxRetries) {
      return {
        category: "attempts_exhausted",
        classification: "terminal",
        retryable: false,
        maxRetries: policy.maxRetries,
        backoffMs: 0,
        reason: `Retry budget exhausted (${attempt}/${policy.maxRetries}) for error category '${category}': ${message}`,
      };
    }

    const backoff = Math.min(
      policy.initialBackoffMs * policy.backoffMultiplier ** (attempt - 1),
      policy.maxBackoffMs,
    );

    return {
      category,
      classification: "transient",
      retryable: true,
      maxRetries: policy.maxRetries,
      backoffMs: backoff,
      reason: `Transient ${category} (attempt ${attempt}/${policy.maxRetries}): ${message}`,
    };
  }

  if (classification === "repairable") {
    return {
      category,
      classification: "repairable",
      retryable: false,
      maxRetries: 0,
      backoffMs: 0,
      reason: `Repairable ${category}: ${message}`,
    };
  }

  return {
    category,
    classification: "terminal",
    retryable: false,
    maxRetries: policy.maxRetries,
    backoffMs: 0,
    reason: `Terminal ${category}: ${message}`,
  };
}

/**
 * Extracts clean string message from unknown error.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

const SENSITIVE_KEY_PATTERNS = [
  /api[-_]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /auth/i,
  /bearer/i,
  /private[-_]?key/i,
  /credential/i,
];

/**
 * Recursively sanitizes and redacts sensitive credentials from diagnostics metadata.
 */
export function redactDiagnostics(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    // Redact Bearer tokens, JWTs, and API key headers in strings
    return data
      .replace(/Bearer\s+[A-Za-z0-9-_=.]+/gi, "Bearer [REDACTED]")
      .replace(/ey[A-Za-z0-9-_]+\.ey[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, "[REDACTED_JWT]")
      .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-[REDACTED]");
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactDiagnostics(item));
  }

  if (typeof data === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitive) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = redactDiagnostics(value);
      }
    }
    return sanitized;
  }

  return data;
}
