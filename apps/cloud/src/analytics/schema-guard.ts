import type { InvocationRecord } from "@tool-evolver/contracts";
import type { TelemetryBatchRequest, TelemetryMetric } from "@tool-evolver/protocol";

/**
 * Custom error thrown when telemetry dimensions or metrics violate privacy-safe allowlists.
 */
export class SchemaGuardValidationError extends Error {
  public readonly violations: string[];

  constructor(message: string, violations: string[] = []) {
    super(message);
    this.name = "SchemaGuardValidationError";
    this.violations = violations;
  }
}

export const ALLOWED_TAG_KEYS: Record<string, true> = {
  toolid: true,
  tool_id: true,
  version: true,
  toolversion: true,
  tool_version: true,
  status: true,
  environment: true,
  risktier: true,
  risk_tier: true,
  errorcode: true,
  error_code: true,
  errortype: true,
  error_type: true,
  devicetype: true,
  device_type: true,
  platform: true,
  arch: true,
  runtimeversion: true,
  runtime_version: true,
  shadowrun: true,
  shadow_run: true,
  quarantinereasoncode: true,
  quarantine_reason_code: true,
  securityviolationtype: true,
  security_violation_type: true,
  batchid: true,
  batch_id: true,
  sessionid: true,
  session_id: true,
  installationid: true,
  installation_id: true,
  deviceid: true,
  device_id: true,
  metrictype: true,
  metric_type: true,
  unit: true,
  os: true,
  model: true,
  provider: true,
  stage: true,
  category: true,
  success: true,
  exitcode: true,
  exit_code: true,
  attempt: true,
  step: true,
  source: true,
  region: true,
  channel: true,
  tier: true,
};

/**
 * Regex patterns identifying sensitive data, credentials, paths, or executable commands.
 */
const SENSITIVE_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  // Shell / CLI commands
  {
    regex: /\b(?:rm\s+-rf|sudo|chmod|chown|curl|wget|bash\s+-c|sh\s+-c|eval|exec)\b/i,
    reason: "Shell command or execution keyword detected",
  },
  {
    regex:
      /\b(?:git\s+commit|git\s+push|git\s+checkout|npm\s+install|pnpm\s+install|cargo\s+build)\b/i,
    reason: "Tool/CLI execution pattern detected",
  },

  // Secrets / API keys / Bearer tokens
  { regex: /bearer\s+[a-zA-Z0-9._~+/-]+=*/i, reason: "Bearer token detected" },
  { regex: /sk-(?:proj-)?[a-zA-Z0-9_-]{20,}/i, reason: "OpenAI-style API key detected" },
  { regex: /ghp_[a-zA-Z0-9]{20,}/i, reason: "GitHub personal access token detected" },
  { regex: /AKIA[0-9A-Z]{16}/, reason: "AWS Access Key ID detected" },
  {
    regex: /-----BEGIN (?:RSA |OPENSSH |PGP |EC )?PRIVATE KEY-----/i,
    reason: "Private key detected",
  },
  { regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}/, reason: "JWT format detected" },
  {
    regex: /(?:api[_-]?key|secret|password|passwd|auth[_-]?token)\s*[:=]\s*[^\s]+/i,
    reason: "Credential assignment detected",
  },

  // Absolute / relative filesystem paths
  {
    regex: /(?:\/home\/|\/Users\/|\/var\/|\/tmp\/|\/etc\/|\/usr\/|\/bin\/|\/opt\/)/i,
    reason: "Filesystem path detected",
  },
  { regex: /[a-zA-Z]:\\[a-zA-Z0-9_.\\]+/i, reason: "Windows filesystem path detected" },
  { regex: /file:\/\/[^\s]+/i, reason: "File URI detected" },
  { regex: /(?:\.\.\/|\.\.\\)/, reason: "Path traversal pattern detected" },

  // Code / SQL injection keywords
  {
    regex: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i,
    reason: "HTML/Script tag detected",
  },
  {
    regex: /\b(?:SELECT\s+.*\s+FROM|DROP\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|UNION\s+ALL)\b/i,
    reason: "SQL statement detected",
  },
];
/**
 * Maximum string length for dimension/tag values (to prevent free-form log leaks).
 */
const MAX_DIMENSION_VALUE_LENGTH = 128;

/**
 * Maximum number of tags per metric.
 */
const MAX_TAGS_PER_METRIC = 24;

/**
 * Maximum metrics per batch.
 */
const MAX_METRICS_PER_BATCH = 1000;

/**
 * Maximum invocations per batch.
 */
const MAX_INVOCATIONS_PER_BATCH = 500;

/**
 * SchemaGuard: Validates telemetry batches, metrics, and invocations against privacy-safe allowlists.
 */
export class SchemaGuard {
  /**
   * Check if a string contains any sensitive patterns (paths, secrets, commands, etc.).
   */
  static detectSensitiveContent(str: string): { isSensitive: boolean; reason?: string } {
    if (!str || typeof str !== "string") {
      return { isSensitive: false };
    }

    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.regex.test(str)) {
        return { isSensitive: true, reason: pattern.reason };
      }
    }

    return { isSensitive: false };
  }

  /**
   * Check if a dimension/tag key and value is allowed.
   */
  static isAllowedDimension(key: string, value: unknown): { allowed: boolean; reason?: string } {
    if (!key || typeof key !== "string") {
      return { allowed: false, reason: "Dimension key must be a non-empty string" };
    }

    const normalizedKey = key.trim().toLowerCase();
    if (!ALLOWED_TAG_KEYS[normalizedKey]) {
      return {
        allowed: false,
        reason: `Dimension key '${key}' is not in the telemetry allowlist. Only standard operational dimensions are permitted.`,
      };
    }

    if (value === null || value === undefined) {
      return { allowed: true };
    }

    if (typeof value === "boolean" || typeof value === "number") {
      return { allowed: true };
    }

    if (typeof value === "string") {
      if (value.length > MAX_DIMENSION_VALUE_LENGTH) {
        return {
          allowed: false,
          reason: `Dimension value for key '${key}' exceeds maximum allowed length of ${MAX_DIMENSION_VALUE_LENGTH} characters.`,
        };
      }

      if (value.includes("\n") || value.includes("\r")) {
        return {
          allowed: false,
          reason: `Dimension value for key '${key}' contains multiline content, which is prohibited.`,
        };
      }

      const sensitiveCheck = SchemaGuard.detectSensitiveContent(value);
      if (sensitiveCheck.isSensitive) {
        return {
          allowed: false,
          reason: `Dimension value for key '${key}' contains prohibited sensitive data: ${sensitiveCheck.reason}`,
        };
      }

      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Dimension value for key '${key}' has invalid type '${typeof value}'. Only string, number, or boolean are allowed.`,
    };
  }

  /**
   * Validate a single telemetry metric.
   */
  static validateMetric(metric: TelemetryMetric): string[] {
    const violations: string[] = [];

    if (!metric || typeof metric !== "object") {
      violations.push("Metric must be a valid object");
      return violations;
    }

    if (!metric.metricName || typeof metric.metricName !== "string") {
      violations.push("Metric must have a valid metricName string");
    } else {
      if (metric.metricName.length > 64) {
        violations.push(
          `metricName '${metric.metricName}' exceeds maximum length of 64 characters`,
        );
      }
      if (!/^[a-zA-Z0-9_.-]+$/.test(metric.metricName)) {
        violations.push(
          `metricName '${metric.metricName}' contains invalid characters. Only alphanumeric, '.', '_', and '-' are allowed`,
        );
      }
      const sensitiveCheck = SchemaGuard.detectSensitiveContent(metric.metricName);
      if (sensitiveCheck.isSensitive) {
        violations.push(`metricName contains prohibited content: ${sensitiveCheck.reason}`);
      }
    }

    if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
      violations.push(`Metric value must be a finite number`);
    }

    if (metric.tags && typeof metric.tags === "object") {
      const tagKeys = Object.keys(metric.tags);
      if (tagKeys.length > MAX_TAGS_PER_METRIC) {
        violations.push(
          `Metric tags count (${tagKeys.length}) exceeds maximum limit of ${MAX_TAGS_PER_METRIC}`,
        );
      }

      for (const [key, val] of Object.entries(metric.tags)) {
        const check = SchemaGuard.isAllowedDimension(key, val);
        if (!check.allowed) {
          violations.push(check.reason ?? `Dimension '${key}' is disallowed`);
        }
      }
    }

    return violations;
  }

  /**
   * Validate an invocation record.
   */
  static validateInvocation(invocation: InvocationRecord): string[] {
    const violations: string[] = [];

    if (!invocation || typeof invocation !== "object") {
      violations.push("Invocation record must be a valid object");
      return violations;
    }

    if (invocation.errorDetails) {
      if (invocation.errorDetails.errorType) {
        if (invocation.errorDetails.errorType.length > 64) {
          violations.push("errorDetails.errorType exceeds maximum length of 64 characters");
        }
        const sensitiveCheck = SchemaGuard.detectSensitiveContent(
          invocation.errorDetails.errorType,
        );
        if (sensitiveCheck.isSensitive) {
          violations.push(
            `errorDetails.errorType contains prohibited content: ${sensitiveCheck.reason}`,
          );
        }
      }

      if (invocation.errorDetails.message) {
        if (invocation.errorDetails.message.length > MAX_DIMENSION_VALUE_LENGTH) {
          violations.push(
            `errorDetails.message exceeds maximum length of ${MAX_DIMENSION_VALUE_LENGTH} characters`,
          );
        }
        const sensitiveCheck = SchemaGuard.detectSensitiveContent(invocation.errorDetails.message);
        if (sensitiveCheck.isSensitive) {
          violations.push(
            `errorDetails.message contains prohibited content: ${sensitiveCheck.reason}`,
          );
        }
      }

      if (invocation.errorDetails.stack) {
        violations.push(
          "errorDetails.stack is prohibited in privacy-safe telemetry to prevent code/path leaks",
        );
      }
    }

    return violations;
  }

  /**
   * Validate an entire telemetry batch request. Throws SchemaGuardValidationError if any violations exist.
   */
  static validateBatch(request: TelemetryBatchRequest): void {
    const violations: string[] = [];

    if (!request || typeof request !== "object") {
      throw new SchemaGuardValidationError("Invalid telemetry batch payload", [
        "Batch payload must be a non-null object",
      ]);
    }

    if (request.metrics && Array.isArray(request.metrics)) {
      if (request.metrics.length > MAX_METRICS_PER_BATCH) {
        violations.push(
          `Batch metrics count (${request.metrics.length}) exceeds maximum limit of ${MAX_METRICS_PER_BATCH}`,
        );
      }

      for (let i = 0; i < request.metrics.length; i++) {
        const metricViolations = SchemaGuard.validateMetric(request.metrics[i]);
        for (const v of metricViolations) {
          violations.push(`metrics[${i}]: ${v}`);
        }
      }
    }

    if (request.invocations && Array.isArray(request.invocations)) {
      if (request.invocations.length > MAX_INVOCATIONS_PER_BATCH) {
        violations.push(
          `Batch invocations count (${request.invocations.length}) exceeds maximum limit of ${MAX_INVOCATIONS_PER_BATCH}`,
        );
      }

      for (let i = 0; i < request.invocations.length; i++) {
        const invocationViolations = SchemaGuard.validateInvocation(request.invocations[i]);
        for (const v of invocationViolations) {
          violations.push(`invocations[${i}]: ${v}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new SchemaGuardValidationError(
        `Telemetry batch rejected due to ${violations.length} schema guard violation(s): ${violations[0]}`,
        violations,
      );
    }
  }
}
