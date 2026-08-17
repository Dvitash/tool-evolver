import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const DaemonConfigSchema = z.object({
  version: z.string().default("0.1.0"),
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(9400),
  socketPath: z.string().optional(),
  authToken: z.string().optional(),
  cloudUrl: z.string().url().default("https://api.tool-evolver.dev"),
  cloudApiKey: z.string().optional(),
  cloudSyncEnabled: z.boolean().default(false),
  telemetryEnabled: z.boolean().default(false),
  storageDir: z.string().optional(),
  heartbeatIntervalMs: z.number().int().positive().default(3000),
  lockStaleThresholdMs: z.number().int().positive().default(15000),
  shutdownTimeoutMs: z.number().int().positive().default(10000),
  maxWorkerMemoryMb: z.number().int().positive().default(512),
  workerExecutionTimeoutMs: z.number().int().positive().default(30000),
  moduleConfigs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  custom: z.record(z.string(), z.unknown()).default({}),
});

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type RedactedDaemonConfig = Record<string, unknown>;

export const IMMUTABLE_CONFIG_FIELDS = ["version", "storageDir", "socketPath"] as const;
export type ImmutableConfigField = (typeof IMMUTABLE_CONFIG_FIELDS)[number];

const SENSITIVE_KEY_PATTERN = /token|secret|key|password|auth|authorization|credential|signature/i;
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Deeply redacts sensitive keys from any object/record.
 */
export function redactSensitiveData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }
  if (typeof data !== "object") {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && typeof value === "string" && value.length > 0) {
      result[key] = REDACTED_PLACEHOLDER;
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSensitiveData(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Returns a deeply redacted copy of the daemon configuration safe for logging and diagnostics.
 */
export function redactConfig(config: DaemonConfig): RedactedDaemonConfig {
  const cloned = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  return redactSensitiveData(cloned) as RedactedDaemonConfig;
}

/**
 * Extracts configuration values from environment variables prefixed with `TOOL_EVOLVER_`.
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
): Partial<DaemonConfig> {
  const result: Partial<DaemonConfig> = {};

  if (env.TOOL_EVOLVER_LOG_LEVEL) {
    const parsed = z
      .enum(["debug", "info", "warn", "error", "silent"])
      .safeParse(env.TOOL_EVOLVER_LOG_LEVEL);
    if (parsed.success) result.logLevel = parsed.data;
  }

  if (env.TOOL_EVOLVER_HOST) {
    result.host = env.TOOL_EVOLVER_HOST;
  }

  if (env.TOOL_EVOLVER_PORT) {
    const port = Number.parseInt(env.TOOL_EVOLVER_PORT, 10);
    if (!Number.isNaN(port)) result.port = port;
  }

  if (env.TOOL_EVOLVER_SOCKET_PATH) {
    result.socketPath = env.TOOL_EVOLVER_SOCKET_PATH;
  }

  if (env.TOOL_EVOLVER_AUTH_TOKEN) {
    result.authToken = env.TOOL_EVOLVER_AUTH_TOKEN;
  }

  if (env.TOOL_EVOLVER_CLOUD_URL) {
    result.cloudUrl = env.TOOL_EVOLVER_CLOUD_URL;
  }

  if (env.TOOL_EVOLVER_CLOUD_API_KEY) {
    result.cloudApiKey = env.TOOL_EVOLVER_CLOUD_API_KEY;
  }

  if (env.TOOL_EVOLVER_CLOUD_SYNC_ENABLED !== undefined) {
    result.cloudSyncEnabled =
      env.TOOL_EVOLVER_CLOUD_SYNC_ENABLED === "1" || env.TOOL_EVOLVER_CLOUD_SYNC_ENABLED === "true";
  }

  if (env.TOOL_EVOLVER_TELEMETRY_ENABLED !== undefined) {
    result.telemetryEnabled =
      env.TOOL_EVOLVER_TELEMETRY_ENABLED === "1" || env.TOOL_EVOLVER_TELEMETRY_ENABLED === "true";
  }

  if (env.TOOL_EVOLVER_STORAGE_DIR) {
    result.storageDir = env.TOOL_EVOLVER_STORAGE_DIR;
  }

  if (env.TOOL_EVOLVER_SHUTDOWN_TIMEOUT_MS) {
    const timeout = Number.parseInt(env.TOOL_EVOLVER_SHUTDOWN_TIMEOUT_MS, 10);
    if (!Number.isNaN(timeout)) result.shutdownTimeoutMs = timeout;
  }

  if (env.TOOL_EVOLVER_MAX_WORKER_MEMORY_MB) {
    const mem = Number.parseInt(env.TOOL_EVOLVER_MAX_WORKER_MEMORY_MB, 10);
    if (!Number.isNaN(mem)) result.maxWorkerMemoryMb = mem;
  }

  if (env.TOOL_EVOLVER_WORKER_EXECUTION_TIMEOUT_MS) {
    const workerTimeout = Number.parseInt(env.TOOL_EVOLVER_WORKER_EXECUTION_TIMEOUT_MS, 10);
    if (!Number.isNaN(workerTimeout)) result.workerExecutionTimeoutMs = workerTimeout;
  }

  return result;
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
  overrides?: Partial<DaemonConfig>;
}

/**
 * Loads configuration by merging defaults < file config < environment variables < explicit overrides.
 */
export function loadDaemonConfig(options: LoadConfigOptions = {}): DaemonConfig {
  const env = options.env ?? process.env;
  let fileConfig: Partial<DaemonConfig> = {};

  if (options.configPath) {
    const resolvedPath = path.resolve(options.configPath);
    if (fs.existsSync(resolvedPath)) {
      try {
        const rawContent = fs.readFileSync(resolvedPath, "utf-8");
        fileConfig = JSON.parse(rawContent) as Partial<DaemonConfig>;
      } catch (err) {
        throw new Error(
          `Failed to parse configuration file at ${resolvedPath}: ${(err as Error).message}`,
        );
      }
    }
  }

  const envConfig = parseEnvConfig(env);
  const explicitOverrides = options.overrides ?? {};

  const merged = {
    ...fileConfig,
    ...envConfig,
    ...explicitOverrides,
  };

  const parsed = DaemonConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const errorIssues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(`Invalid daemon configuration: ${errorIssues}`);
  }

  return parsed.data;
}

export interface ConfigUpdateValidationResult {
  valid: boolean;
  errors: string[];
  updatedConfig?: DaemonConfig;
}

/**
 * Validates a configuration update against immutable fields and schema constraints.
 */
export function validateConfigUpdate(
  currentConfig: DaemonConfig,
  update: Partial<DaemonConfig>,
): ConfigUpdateValidationResult {
  const errors: string[] = [];

  // Check immutable fields
  for (const field of IMMUTABLE_CONFIG_FIELDS) {
    if (field in update && update[field] !== undefined && update[field] !== currentConfig[field]) {
      errors.push(`Field '${field}' is immutable and cannot be updated at runtime.`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const candidate = {
    ...currentConfig,
    ...update,
  };

  const parsed = DaemonConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const schemaErrors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return {
      valid: false,
      errors: schemaErrors,
    };
  }

  return {
    valid: true,
    errors: [],
    updatedConfig: parsed.data,
  };
}
