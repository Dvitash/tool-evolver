import { z } from "zod";

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
  corsOrigins: z.array(z.string()).default(["*"]),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Comprehensive Cloud Configuration schema.
 */
export const CloudConfigSchema = z.object({
  database: DatabaseConfigSchema,
  storage: StorageConfigSchema,
  queue: QueueConfigSchema,
  auth: AuthConfigSchema,
  server: ServerConfigSchema,
});
export type CloudConfig = z.infer<typeof CloudConfigSchema>;
export type RawCloudConfig = z.input<typeof CloudConfigSchema>;

export type RedactedCloudConfig = {
  database: Omit<DatabaseConfig, "password"> & { password: string };
  storage: Omit<StorageConfig, "secretAccessKey"> & { secretAccessKey: string };
  queue: QueueConfig;
  auth: Omit<AuthConfig, "jwtSecret" | "deviceTokenSecret"> & {
    jwtSecret: string;
    deviceTokenSecret: string;
  };
  server: ServerConfig;
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
    auth: {
      ...config.auth,
      jwtSecret: "[REDACTED]",
      deviceTokenSecret: "[REDACTED]",
    },
    server: {
      ...config.server,
    },
  };
}

/**
 * Parse environment variables and apply configuration precedence:
 * Default < Environment Variables < Explicit Overrides.
 */
export function loadConfig(overrides?: Partial<RawCloudConfig>): CloudConfig {
  const env = process.env;

  const rawFromEnv: RawCloudConfig = {
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
    auth: {
      jwtSecret: env.AUTH_JWT_SECRET ?? "dev-jwt-secret-min-16-characters-long",
      deviceTokenSecret: env.AUTH_DEVICE_TOKEN_SECRET ?? "dev-device-token-secret-16-chars-long",
      issuer: env.AUTH_ISSUER ?? "tool-evolver-cloud",
      audience: env.AUTH_AUDIENCE ?? "tool-evolver-client",
      tokenTtlSeconds: env.AUTH_TOKEN_TTL_SECONDS ? Number(env.AUTH_TOKEN_TTL_SECONDS) : 86400,
    },
    server: {
      host: env.HOST ?? "0.0.0.0",
      port: env.PORT ? Number(env.PORT) : 8080,
      logLevel: (env.LOG_LEVEL as LogLevel) ?? "info",
      bodyLimitBytes: env.BODY_LIMIT_BYTES ? Number(env.BODY_LIMIT_BYTES) : 10485760,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS ? Number(env.REQUEST_TIMEOUT_MS) : 30000,
      corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",").map((s) => s.trim()) : ["*"],
    },
  };

  // Merge overrides
  const merged: RawCloudConfig = {
    database: { ...rawFromEnv.database, ...overrides?.database },
    storage: { ...rawFromEnv.storage, ...overrides?.storage },
    queue: { ...rawFromEnv.queue, ...overrides?.queue },
    auth: { ...rawFromEnv.auth, ...overrides?.auth },
    server: { ...rawFromEnv.server, ...overrides?.server },
  };

  return CloudConfigSchema.parse(merged);
}
