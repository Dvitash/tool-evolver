import { z } from "zod";

/** Runtime deployment environment. */
export const EnvironmentSchema = z
  .enum(["development", "test", "staging", "production"])
  .default("development");
export type CloudEnvironment = z.infer<typeof EnvironmentSchema>;

/**
 * Log levels supported by the cloud service.
 */
export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]).default("info");
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Storage providers supported by the cloud service.
 */
export const StorageProviderSchema = z.enum(["s3", "minio", "memory"]).default("memory");
export type StorageProvider = z.infer<typeof StorageProviderSchema>;

/**
 * Queue providers supported by the cloud service.
 */
export const QueueProviderSchema = z.enum(["postgres", "redis", "memory"]).default("memory");
export type QueueProvider = z.infer<typeof QueueProviderSchema>;

/**
 * Database configuration schema.
 */
export const DatabaseConfigSchema = z.object({
  url: z.string().default("postgres://postgres:postgres@localhost:5432/tool_evolver"),
  host: z.string().default("localhost"),
  port: z.coerce.number().int().positive().default(5432),
  database: z.string().default("tool_evolver"),
  user: z.string().default("postgres"),
  password: z.string().default("postgres"),
  ssl: z.boolean().default(false),
  maxConnections: z.coerce.number().int().positive().default(20),
  idleTimeoutMs: z.coerce.number().int().nonnegative().default(30000),
  connectionTimeoutMs: z.coerce.number().int().nonnegative().default(5000),
});
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

/**
 * Storage configuration schema.
 */
export const StorageConfigSchema = z.object({
  provider: StorageProviderSchema,
  bucket: z.string().default("tool-evolver-artifacts"),
  endpoint: z.string().optional(),
  region: z.string().default("us-east-1"),
  accessKeyId: z.string().default("minioadmin"),
  secretAccessKey: z.string().default("minioadmin"),
  forcePathStyle: z.boolean().default(true),
  publicUrl: z.string().optional(),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

/**
 * Queue configuration schema.
 */
export const QueueConfigSchema = z.object({
  provider: QueueProviderSchema,
  concurrency: z.coerce.number().int().positive().default(10),
  pollIntervalMs: z.coerce.number().int().positive().default(1000),
  visibilityTimeoutMs: z.coerce.number().int().positive().default(30000),
  maxAttempts: z.coerce.number().int().positive().default(3),
  deadLetterThreshold: z.coerce.number().int().positive().default(3),
  backoffBaseMs: z.coerce.number().int().positive().default(1000),
});
export type QueueConfig = z.infer<typeof QueueConfigSchema>;

/**
 * Authentication configuration schema.
 */
export const AuthConfigSchema = z.object({
  jwtSecret: z.string().min(16).default("dev-jwt-secret-min-16-characters-long"),
  deviceTokenSecret: z.string().min(16).default("dev-device-token-secret-16-chars-long"),
  issuer: z.string().default("tool-evolver-cloud"),
  audience: z.string().default("tool-evolver-client"),
  tokenTtlSeconds: z.coerce.number().int().positive().default(86400),
  allowDevAuth: z.boolean().default(false),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/**
 * Server configuration schema.
 */
export const ServerConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().nonnegative().default(8080),
  logLevel: LogLevelSchema,
  bodyLimitBytes: z.coerce.number().int().positive().default(10485760), // 10MB
  requestTimeoutMs: z.coerce.number().int().positive().default(30000),
  corsOrigins: z.array(z.string()).default(["http://127.0.0.1:9400", "http://localhost:9400"]),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Model provider used by the structured inference gateway. */
export const ModelProviderSchema = z.enum(["disabled", "openai-compatible"]).default("disabled");
export type ModelProviderKind = z.infer<typeof ModelProviderSchema>;

export const ModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  providerId: z.string().min(1).default("primary"),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  organizationId: z.string().optional(),
  model: z.string().min(1).default("gpt-4o-mini"),
  timeoutMs: z.coerce.number().int().positive().default(30000),
  allowDeterministicFallback: z.boolean().default(true),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const BENCHMARK_ATTESTATION_SECRET_MIN_LENGTH = 32;

/**
 * HMAC benchmark attestation verifier configuration.
 * Secret is never included in redacted/serialized representations or error messages.
 */
export const BenchmarkAttestationConfigSchema = z.object({
  issuer: z.string().min(1),
  keyId: z.string().min(1),
  secret: z.string().min(BENCHMARK_ATTESTATION_SECRET_MIN_LENGTH),
});
export type BenchmarkAttestationConfig = z.infer<typeof BenchmarkAttestationConfigSchema>;

/**
 * Validate benchmark attestation fields without echoing the secret in errors.
 */
export function parseBenchmarkAttestationConfig(raw: unknown): BenchmarkAttestationConfig {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw new Error("Benchmark attestation config is required");
  }
  const rec = raw as Record<string, unknown>;
  const issuer = rec.issuer;
  const keyId = rec.keyId;
  const secret = rec.secret;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("BENCHMARK_ATTESTATION_SECRET is required");
  }
  if (secret.length < BENCHMARK_ATTESTATION_SECRET_MIN_LENGTH) {
    throw new Error(
      `BENCHMARK_ATTESTATION_SECRET must be at least ${BENCHMARK_ATTESTATION_SECRET_MIN_LENGTH} characters`,
    );
  }
  if (typeof issuer !== "string" || issuer.trim().length === 0) {
    throw new Error("BENCHMARK_ATTESTATION_ISSUER is required");
  }
  if (typeof keyId !== "string" || keyId.trim().length === 0) {
    throw new Error("BENCHMARK_ATTESTATION_KEY_ID is required");
  }
  return {
    issuer: issuer.trim(),
    keyId: keyId.trim(),
    secret,
  };
}

export function readBenchmarkAttestationEnv(
  env: Record<string, string | undefined> = process.env,
): { issuer?: string; keyId?: string; secret?: string } {
  return {
    issuer: env.BENCHMARK_ATTESTATION_ISSUER,
    keyId: env.BENCHMARK_ATTESTATION_KEY_ID,
    secret: env.BENCHMARK_ATTESTATION_SECRET,
  };
}

export function hasBenchmarkAttestationInput(raw: {
  issuer?: string;
  keyId?: string;
  secret?: string;
}): boolean {
  return Boolean(raw.issuer || raw.keyId || raw.secret);
}

/**
 * Comprehensive Cloud Configuration schema.
 */
export const CloudConfigSchema = z.object({
  environment: EnvironmentSchema,
  database: DatabaseConfigSchema,
  storage: StorageConfigSchema,
  queue: QueueConfigSchema,
  auth: AuthConfigSchema,
  models: ModelConfigSchema.default({}),
  server: ServerConfigSchema,
  benchmarkAttestation: BenchmarkAttestationConfigSchema.optional(),
});
export type CloudConfig = z.infer<typeof CloudConfigSchema>;
export type RawCloudConfig = z.input<typeof CloudConfigSchema>;

export type RedactedCloudConfig = {
  environment: CloudEnvironment;
  database: Omit<DatabaseConfig, "password"> & { password: string };
  storage: Omit<StorageConfig, "secretAccessKey"> & { secretAccessKey: string };
  queue: QueueConfig;
  models: Omit<ModelConfig, "apiKey"> & { apiKey?: string };
  auth: Omit<AuthConfig, "jwtSecret" | "deviceTokenSecret"> & {
    jwtSecret: string;
    deviceTokenSecret: string;
  };
  server: ServerConfig;
  benchmarkAttestation?: Omit<BenchmarkAttestationConfig, "secret"> & { secret: string };
};

/**
 * Redact sensitive secrets from a database connection URL.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "******";
    }
    return parsed.toString();
  } catch {
    return url.replace(/(:[^:@/]+)@/, ":******@");
  }
}

/**
 * Redact sensitive fields from a CloudConfig instance.
 */
export function redactConfig(config: CloudConfig): RedactedCloudConfig {
  return {
    environment: config.environment,
    database: {
      ...config.database,
      url: redactDatabaseUrl(config.database.url),
      password: "[REDACTED]",
    },
    storage: {
      ...config.storage,
      secretAccessKey: "[REDACTED]",
    },
    queue: {
      ...config.queue,
    },
    models: {
      ...config.models,
      apiKey: config.models.apiKey ? "[REDACTED]" : undefined,
    },
    auth: {
      ...config.auth,
      jwtSecret: "[REDACTED]",
      deviceTokenSecret: "[REDACTED]",
    },
    server: {
      ...config.server,
    },
    benchmarkAttestation: config.benchmarkAttestation
      ? {
          issuer: config.benchmarkAttestation.issuer,
          keyId: config.benchmarkAttestation.keyId,
          secret: "[REDACTED]",
        }
      : undefined,
  };
}

const DEFAULT_JWT_SECRET = "dev-jwt-secret-min-16-characters-long";
const DEFAULT_DEVICE_SECRET = "dev-device-token-secret-16-chars-long";

/**
 * Reject configurations that would expose development trust shortcuts or
 * ephemeral infrastructure in staging/production.
 */
export function assertSecureCloudConfig(config: CloudConfig): void {
  if (config.environment !== "staging" && config.environment !== "production") {
    return;
  }

  const violations: string[] = [];
  if (config.auth.allowDevAuth) violations.push("development authentication is enabled");
  if (config.auth.jwtSecret === DEFAULT_JWT_SECRET) violations.push("default JWT secret is in use");
  if (config.auth.deviceTokenSecret === DEFAULT_DEVICE_SECRET) {
    violations.push("default device-token secret is in use");
  }
  if (config.server.corsOrigins.includes("*")) violations.push("wildcard CORS is enabled");
  if (config.storage.provider === "memory") violations.push("memory object storage is configured");
  if (config.queue.provider === "memory") violations.push("memory queue is configured");
  if (config.database.url.startsWith("memory://")) violations.push("memory database is configured");
  if (config.models.provider === "disabled") {
    violations.push("structured inference provider is disabled");
  }
  if (config.models.provider === "openai-compatible" && !config.models.baseUrl) {
    violations.push("structured inference base URL is missing");
  }
  if (config.models.allowDeterministicFallback) {
    violations.push("deterministic synthesis fallback is enabled");
  }
  if (
    config.storage.provider === "minio" &&
    config.storage.accessKeyId === "minioadmin" &&
    config.storage.secretAccessKey === "minioadmin"
  ) {
    violations.push("default MinIO credentials are in use");
  }

  if (violations.length > 0) {
    throw new Error(`Unsafe ${config.environment} cloud configuration: ${violations.join("; ")}`);
  }
}

/**
 * Parse environment variables and apply configuration precedence:
 * Default < Environment Variables < Explicit Overrides.
 */
export function loadConfig(overrides?: Partial<RawCloudConfig>): CloudConfig {
  const env = process.env;
  const environment = EnvironmentSchema.parse(
    env.TOOL_EVOLVER_ENV ?? env.NODE_ENV ?? "development",
  );
  const allowDevAuth = env.AUTH_ALLOW_DEV_AUTH
    ? env.AUTH_ALLOW_DEV_AUTH === "true" || env.AUTH_ALLOW_DEV_AUTH === "1"
    : environment === "development" || environment === "test";

  const envAttestation = readBenchmarkAttestationEnv(env);
  let resolvedAttestation: BenchmarkAttestationConfig | undefined;
  if (overrides?.benchmarkAttestation) {
    resolvedAttestation = parseBenchmarkAttestationConfig(overrides.benchmarkAttestation);
  } else if (hasBenchmarkAttestationInput(envAttestation)) {
    resolvedAttestation = parseBenchmarkAttestationConfig(envAttestation);
  }

  const rawFromEnv: RawCloudConfig = {
    environment,
    database: {
      url: env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/tool_evolver",
      host: env.DB_HOST ?? "localhost",
      port: env.DB_PORT ? Number(env.DB_PORT) : 5432,
      database: env.DB_NAME ?? "tool_evolver",
      user: env.DB_USER ?? "postgres",
      password: env.DB_PASSWORD ?? "postgres",
      ssl: env.DB_SSL === "true" || env.DB_SSL === "1",
      maxConnections: env.DB_MAX_CONNECTIONS ? Number(env.DB_MAX_CONNECTIONS) : 20,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS ? Number(env.DB_IDLE_TIMEOUT_MS) : 30000,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS
        ? Number(env.DB_CONNECTION_TIMEOUT_MS)
        : 5000,
    },
    storage: {
      provider: (env.STORAGE_PROVIDER as "s3" | "minio" | "memory") ?? "memory",
      bucket: env.STORAGE_BUCKET ?? "tool-evolver-artifacts",
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION ?? "us-east-1",
      accessKeyId: env.STORAGE_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY ?? "minioadmin",
      forcePathStyle:
        env.STORAGE_FORCE_PATH_STYLE !== "false" && env.STORAGE_FORCE_PATH_STYLE !== "0",
      publicUrl: env.STORAGE_PUBLIC_URL,
    },
    queue: {
      provider: (env.QUEUE_PROVIDER as "postgres" | "redis" | "memory") ?? "memory",
      concurrency: env.QUEUE_CONCURRENCY ? Number(env.QUEUE_CONCURRENCY) : 10,
      pollIntervalMs: env.QUEUE_POLL_INTERVAL_MS ? Number(env.QUEUE_POLL_INTERVAL_MS) : 1000,
      visibilityTimeoutMs: env.QUEUE_VISIBILITY_TIMEOUT_MS
        ? Number(env.QUEUE_VISIBILITY_TIMEOUT_MS)
        : 30000,
      maxAttempts: env.QUEUE_MAX_ATTEMPTS ? Number(env.QUEUE_MAX_ATTEMPTS) : 3,
      deadLetterThreshold: env.QUEUE_DEAD_LETTER_THRESHOLD
        ? Number(env.QUEUE_DEAD_LETTER_THRESHOLD)
        : 3,
      backoffBaseMs: env.QUEUE_BACKOFF_BASE_MS ? Number(env.QUEUE_BACKOFF_BASE_MS) : 1000,
    },
    models: {
      provider: (env.MODEL_PROVIDER as "disabled" | "openai-compatible" | undefined) ?? "disabled",
      providerId: env.MODEL_PROVIDER_ID ?? "primary",
      baseUrl: env.MODEL_BASE_URL,
      apiKey: env.MODEL_API_KEY,
      organizationId: env.MODEL_ORGANIZATION_ID,
      model: env.MODEL_ID ?? "gpt-4o-mini",
      timeoutMs: env.MODEL_TIMEOUT_MS ? Number(env.MODEL_TIMEOUT_MS) : 30000,
      allowDeterministicFallback: env.MODEL_ALLOW_DETERMINISTIC_FALLBACK
        ? env.MODEL_ALLOW_DETERMINISTIC_FALLBACK === "true" ||
          env.MODEL_ALLOW_DETERMINISTIC_FALLBACK === "1"
        : environment === "development" || environment === "test",
    },
    auth: {
      jwtSecret: env.AUTH_JWT_SECRET ?? "dev-jwt-secret-min-16-characters-long",
      deviceTokenSecret: env.AUTH_DEVICE_TOKEN_SECRET ?? "dev-device-token-secret-16-chars-long",
      issuer: env.AUTH_ISSUER ?? "tool-evolver-cloud",
      audience: env.AUTH_AUDIENCE ?? "tool-evolver-client",
      tokenTtlSeconds: env.AUTH_TOKEN_TTL_SECONDS ? Number(env.AUTH_TOKEN_TTL_SECONDS) : 86400,
      allowDevAuth,
    },
    server: {
      host: env.HOST ?? "0.0.0.0",
      port: env.PORT ? Number(env.PORT) : 8080,
      logLevel: (env.LOG_LEVEL as LogLevel) ?? "info",
      bodyLimitBytes: env.BODY_LIMIT_BYTES ? Number(env.BODY_LIMIT_BYTES) : 10485760,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS ? Number(env.REQUEST_TIMEOUT_MS) : 30000,
      corsOrigins: env.CORS_ORIGINS
        ? env.CORS_ORIGINS.split(",").map((s) => s.trim())
        : ["http://127.0.0.1:9400", "http://localhost:9400"],
    },
    benchmarkAttestation: resolvedAttestation,
  };

  // Merge overrides
  const merged: RawCloudConfig = {
    environment: overrides?.environment ?? rawFromEnv.environment,
    database: { ...rawFromEnv.database, ...overrides?.database },
    storage: { ...rawFromEnv.storage, ...overrides?.storage },
    queue: { ...rawFromEnv.queue, ...overrides?.queue },
    models: { ...rawFromEnv.models, ...overrides?.models },
    auth: { ...rawFromEnv.auth, ...overrides?.auth },
    server: { ...rawFromEnv.server, ...overrides?.server },
    benchmarkAttestation: resolvedAttestation,
  };

  const parsed = CloudConfigSchema.parse(merged);
  assertSecureCloudConfig(parsed);
  return parsed;
}
