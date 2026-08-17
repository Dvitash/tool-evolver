import { ModelPolicy } from "./types.js";

/**
 * Error thrown when an outbound payload violates privacy policy.
 */
export class PrivacyViolationError extends Error {
  public readonly violations: string[];

  constructor(message: string, violations: string[] = []) {
    super(message);
    this.name = "PrivacyViolationError";
    this.violations = violations;
  }
}

/**
 * Standard secret redaction patterns.
 */
const DEFAULT_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // Private keys
  {
    name: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // Bearer tokens
  {
    name: "bearer_token",
    pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  // OpenAI API Keys
  {
    name: "openai_api_key",
    pattern: /sk-[a-zA-Z0-9_-]{20,}/g,
    replacement: "sk-[REDACTED_OPENAI_KEY]",
  },
  // GitHub PATs and tokens
  {
    name: "github_token",
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{50,}/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  // AWS Access Key IDs
  {
    name: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_ACCESS_KEY]",
  },
  // AWS Secret Access Keys in key-value pairs
  {
    name: "aws_secret_key",
    pattern: /(aws_secret_access_key\s*[:=]\s*)[a-zA-Z0-9/+=]{40}/gi,
    replacement: "$1[REDACTED_AWS_SECRET_KEY]",
  },
  // Quoted generic password/secret/api_key fields
  {
    name: "generic_secret_quoted",
    pattern: /((?:api[_-]?key|password|passwd|secret|auth[_-]?token|private[_-]?key)\s*[:=]\s*["'])([^"'\n\r]+)(["'])/gi,
    replacement: "$1[REDACTED_SECRET]$3",
  },
  // Unquoted generic password/secret/api_key fields
  {
    name: "generic_secret_unquoted",
    pattern: /((?:api[_-]?key|password|passwd|secret|auth[_-]?token|private[_-]?key)\s*[:=]\s*)([^\s"',;\n\r]+)/gi,
    replacement: "$1[REDACTED_SECRET]",
  },
  // Absolute Unix/macOS user paths (/home/user/... or /Users/user/...)
  {
    name: "unix_user_path",
    pattern: /(?:\/home|\/Users)\/[a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.@\-]+)+/g,
    replacement: "[REDACTED_PATH]",
  },
  // Absolute Windows user paths (C:\Users\user\...)
  {
    name: "windows_user_path",
    pattern: /[a-zA-Z]:\\(?:Users|Documents and Settings)\\[a-zA-Z0-9_.\-]+(?:\\[a-zA-Z0-9_.@\-]+)+/g,
    replacement: "[REDACTED_PATH]",
  },
  // Email addresses (bounded by whitespace, quotes, angle brackets or line boundaries)
  {
    name: "email",
    pattern: /(^|[\s"'<(\[])([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)([$|\s"'>)\]])/g,
    replacement: "$1[REDACTED_EMAIL]$3",
  },
];

/**
 * Forbidden raw transcript markers.
 */
const FORBIDDEN_RAW_TRANSCRIPT_MARKERS = [
  "[RAW_TRANSCRIPT]",
  "--- BEGIN RAW USER TRANSCRIPT ---",
  "SESSION_TRANSCRIPT_RAW:",
  "<raw_transcript>",
  "UNREDACTED_TRANSCRIPT",
];

/**
 * Prompt injection delimiter patterns to sanitize in user content.
 */
const PROMPT_INJECTION_DELIMITERS = [
  { pattern: /<\|im_start\|>/gi, replacement: "[DELIMITER_STRIPPED]" },
  { pattern: /<\|im_end\|>/gi, replacement: "[DELIMITER_STRIPPED]" },
  { pattern: /<<SYS>>/gi, replacement: "[SYS_STRIPPED]" },
  { pattern: /<<\/SYS>>/gi, replacement: "[SYS_STRIPPED]" },
  { pattern: /\[INST\]/gi, replacement: "[INST_STRIPPED]" },
  { pattern: /\[\/INST\]/gi, replacement: "[INST_STRIPPED]" },
  { pattern: /---\s*BEGIN SYSTEM INSTRUCTIONS?\s*---/gi, replacement: "[INSTRUCTION_OVERRIDE_STRIPPED]" },
];

/**
 * Outbound privacy gate protecting sensitive data, blocking raw transcripts,
 * and neutralizing prompt injection vectors.
 */
export class OutboundPrivacyGate {
  private customPatterns: Array<{ name: string; pattern: RegExp; replacement: string }> = [];
  private registeredSecretTerms: Set<string> = new Set();

  /**
   * Registers a custom redaction term (e.g. customer-specific secret).
   */
  registerSecretTerm(term: string): void {
    if (term && term.trim().length > 3) {
      this.registeredSecretTerms.add(term.trim());
    }
  }

  /**
   * Registers a custom regex pattern.
   */
  registerCustomPattern(name: string, pattern: RegExp, replacement = "[REDACTED]"): void {
    this.customPatterns.push({ name, pattern, replacement });
  }

  /**
   * Evaluates outbound payload against privacy policy.
   * Throws PrivacyViolationError if unauthorized raw transcripts or blocking violations are found.
   */
  evaluate(text: string, policy?: ModelPolicy): void {
    const allowRaw = policy?.allowRawTranscripts ?? false;

    if (!allowRaw) {
      const violations: string[] = [];
      for (const marker of FORBIDDEN_RAW_TRANSCRIPT_MARKERS) {
        if (text.includes(marker)) {
          violations.push(`Found forbidden raw transcript marker: ${marker}`);
        }
      }

      if (violations.length > 0) {
        throw new PrivacyViolationError("Outbound payload contains unauthorized raw transcript content", violations);
      }
    }
  }

  /**
   * Redacts secrets, tokens, email addresses, absolute paths, and custom terms.
   */
  redact(text: string): string {
    let sanitized = text;

    // 1. Redact exact registered secret terms first
    for (const term of this.registeredSecretTerms) {
      sanitized = sanitized.replaceAll(term, "[REDACTED_SECRET]");
    }

    // 2. Apply custom registered patterns next
    for (const rule of this.customPatterns) {
      sanitized = sanitized.replace(rule.pattern, rule.replacement);
    }

    // 3. Apply default secret patterns
    for (const rule of DEFAULT_SECRET_PATTERNS) {
      sanitized = sanitized.replace(rule.pattern, rule.replacement);
    }

    return sanitized;
  }

  /**
   * Defends against prompt injection by neutralizing control delimiters in user-supplied strings.
   */
  defendPromptInjection(text: string): string {
    let sanitized = text;
    for (const delimiter of PROMPT_INJECTION_DELIMITERS) {
      sanitized = sanitized.replace(delimiter.pattern, delimiter.replacement);
    }
    return sanitized;
  }

  /**
   * Fully sanitizes and protects an outbound string payload.
   */
  processString(text: string, policy?: ModelPolicy): string {
    this.evaluate(text, policy);
    const injectedSanitized = this.defendPromptInjection(text);
    return this.redact(injectedSanitized);
  }

  /**
   * Recursively sanitizes an input object, array, or primitive.
   */
  processValue<T>(value: T, policy?: ModelPolicy): T {
    if (typeof value === "string") {
      return this.processString(value, policy) as unknown as T;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.processValue(item, policy)) as unknown as T;
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.processValue(v, policy);
      }
      return result as unknown as T;
    }

    return value;
  }
}
