from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def write(rel: str, text: str) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def replace_once(rel: str, old: str, new: str) -> None:
    text = read(rel)
    if old not in text:
        raise RuntimeError(f"Expected text not found in {rel}: {old[:120]!r}")
    write(rel, text.replace(old, new, 1))


def regex_once(rel: str, pattern: str, replacement: str) -> None:
    text = read(rel)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"Expected one regex match in {rel}, got {count}: {pattern[:120]!r}")
    write(rel, updated)


# ---------------------------------------------------------------------------
# Cloud configuration: explicit environments, development-auth control, and
# fail-closed production/staging validation.
# ---------------------------------------------------------------------------
config_path = "apps/cloud/src/config.ts"
replace_once(
    config_path,
    'import { z } from "zod";\n',
    'import { z } from "zod";\n\n/** Runtime deployment environment. */\nexport const EnvironmentSchema = z\n  .enum(["development", "test", "staging", "production"])\n  .default("development");\nexport type CloudEnvironment = z.infer<typeof EnvironmentSchema>;\n',
)
replace_once(
    config_path,
    '  tokenTtlSeconds: z.coerce.number().int().positive().default(86400),\n});',
    '  tokenTtlSeconds: z.coerce.number().int().positive().default(86400),\n  allowDevAuth: z.boolean().default(false),\n});',
)
replace_once(
    config_path,
    '  corsOrigins: z.array(z.string()).default(["*"]),',
    '  corsOrigins: z\n    .array(z.string())\n    .default(["http://127.0.0.1:9400", "http://localhost:9400"]),',
)
replace_once(
    config_path,
    'export const CloudConfigSchema = z.object({\n  database:',
    'export const CloudConfigSchema = z.object({\n  environment: EnvironmentSchema,\n  database:',
)
replace_once(
    config_path,
    'export type RedactedCloudConfig = {\n  database:',
    'export type RedactedCloudConfig = {\n  environment: CloudEnvironment;\n  database:',
)
replace_once(
    config_path,
    '  return {\n    database:',
    '  return {\n    environment: config.environment,\n    database:',
)
validation = '''\nconst DEFAULT_JWT_SECRET = "dev-jwt-secret-min-16-characters-long";\nconst DEFAULT_DEVICE_SECRET = "dev-device-token-secret-16-chars-long";\n\n/**\n * Reject configurations that would expose development trust shortcuts or\n * ephemeral infrastructure in staging/production.\n */\nexport function assertSecureCloudConfig(config: CloudConfig): void {\n  if (config.environment !== "staging" && config.environment !== "production") {\n    return;\n  }\n\n  const violations: string[] = [];\n  if (config.auth.allowDevAuth) violations.push("development authentication is enabled");\n  if (config.auth.jwtSecret === DEFAULT_JWT_SECRET) violations.push("default JWT secret is in use");\n  if (config.auth.deviceTokenSecret === DEFAULT_DEVICE_SECRET) {\n    violations.push("default device-token secret is in use");\n  }\n  if (config.server.corsOrigins.includes("*")) violations.push("wildcard CORS is enabled");\n  if (config.storage.provider === "memory") violations.push("memory object storage is configured");\n  if (config.queue.provider === "memory") violations.push("memory queue is configured");\n  if (config.database.url.startsWith("memory://")) violations.push("memory database is configured");\n  if (\n    config.storage.provider === "minio" &&\n    config.storage.accessKeyId === "minioadmin" &&\n    config.storage.secretAccessKey === "minioadmin"\n  ) {\n    violations.push("default MinIO credentials are in use");\n  }\n\n  if (violations.length > 0) {\n    throw new Error(\n      `Unsafe ${config.environment} cloud configuration: ${violations.join("; ")}`,\n    );\n  }\n}\n'''
replace_once(
    config_path,
    '/**\n * Parse environment variables and apply configuration precedence:',
    validation + '\n/**\n * Parse environment variables and apply configuration precedence:',
)
replace_once(
    config_path,
    '  const env = process.env;\n\n  const rawFromEnv: RawCloudConfig = {',
    '''  const env = process.env;\n  const environment = EnvironmentSchema.parse(\n    env.TOOL_EVOLVER_ENV ?? env.NODE_ENV ?? "development",\n  );\n  const allowDevAuth = env.AUTH_ALLOW_DEV_AUTH\n    ? env.AUTH_ALLOW_DEV_AUTH === "true" || env.AUTH_ALLOW_DEV_AUTH === "1"\n    : environment === "development" || environment === "test";\n\n  const rawFromEnv: RawCloudConfig = {\n    environment,''',
)
replace_once(
    config_path,
    '      tokenTtlSeconds: env.AUTH_TOKEN_TTL_SECONDS ? Number(env.AUTH_TOKEN_TTL_SECONDS) : 86400,\n    },',
    '      tokenTtlSeconds: env.AUTH_TOKEN_TTL_SECONDS ? Number(env.AUTH_TOKEN_TTL_SECONDS) : 86400,\n      allowDevAuth,\n    },',
)
replace_once(
    config_path,
    '      corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",").map((s) => s.trim()) : ["*"],',
    '''      corsOrigins: env.CORS_ORIGINS\n        ? env.CORS_ORIGINS.split(",").map((s) => s.trim())\n        : ["http://127.0.0.1:9400", "http://localhost:9400"],''',
)
replace_once(
    config_path,
    '  const merged: RawCloudConfig = {\n    database:',
    '  const merged: RawCloudConfig = {\n    environment: overrides?.environment ?? rawFromEnv.environment,\n    database:',
)
replace_once(
    config_path,
    '  return CloudConfigSchema.parse(merged);',
    '  const parsed = CloudConfigSchema.parse(merged);\n  assertSecureCloudConfig(parsed);\n  return parsed;',
)

# ---------------------------------------------------------------------------
# Shared server hardening utilities.
# ---------------------------------------------------------------------------
write(
    "apps/cloud/src/server/security.ts",
    '''import type { IncomingMessage } from "node:http";\nimport { type AuthScope, hasRequiredScope } from "@tool-evolver/protocol";\nimport { type AuthContext, TokenError } from "../auth/index.js";\nimport type { CloudConfig } from "../config.js";\nimport type { DatabasePool } from "../db/client.js";\nimport type { DurableQueue } from "../queue/queue.js";\nimport type { ObjectStore } from "../storage/object-store.js";\n\nexport class RequestBodyTooLargeError extends Error {\n  readonly statusCode = 413;\n  constructor(readonly limitBytes: number) {\n    super(`Request body exceeds the configured ${limitBytes}-byte limit`);\n    this.name = "RequestBodyTooLargeError";\n  }\n}\n\nexport class InvalidJsonBodyError extends Error {\n  readonly statusCode = 400;\n  constructor(message = "Invalid JSON payload") {\n    super(message);\n    this.name = "InvalidJsonBodyError";\n  }\n}\n\nexport function isOriginAllowed(req: IncomingMessage, config: CloudConfig): boolean {\n  const origin = req.headers.origin;\n  if (!origin) return true;\n  if (config.server.corsOrigins.includes(origin)) return true;\n  return (\n    (config.environment === "development" || config.environment === "test") &&\n    config.server.corsOrigins.includes("*")\n  );\n}\n\nexport function buildStandardHeaders(\n  req: IncomingMessage,\n  config: CloudConfig,\n  traceId: string,\n  requestId: string,\n): Record<string, string> {\n  const headers: Record<string, string> = {\n    "x-trace-id": traceId,\n    "x-request-id": requestId,\n    "Access-Control-Allow-Headers":\n      "Content-Type, Authorization, x-trace-id, x-request-id, x-protocol-version",\n    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",\n    "X-Content-Type-Options": "nosniff",\n    "Referrer-Policy": "no-referrer",\n  };\n  const origin = req.headers.origin;\n  if (origin && isOriginAllowed(req, config)) {\n    headers["Access-Control-Allow-Origin"] = origin;\n    headers.Vary = "Origin";\n  }\n  return headers;\n}\n\nexport async function readRequestBody(\n  req: IncomingMessage,\n  limitBytes: number,\n): Promise<Buffer> {\n  return await new Promise<Buffer>((resolve, reject) => {\n    const chunks: Buffer[] = [];\n    let bytes = 0;\n    let settled = false;\n\n    req.on("data", (chunk: Buffer | Uint8Array | string) => {\n      if (settled) return;\n      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);\n      bytes += buffer.length;\n      if (bytes > limitBytes) {\n        settled = true;\n        req.pause();\n        reject(new RequestBodyTooLargeError(limitBytes));\n        return;\n      }\n      chunks.push(buffer);\n    });\n    req.on("end", () => {\n      if (settled) return;\n      settled = true;\n      resolve(Buffer.concat(chunks));\n    });\n    req.on("error", (error) => {\n      if (settled) return;\n      settled = true;\n      reject(error);\n    });\n  });\n}\n\nexport async function readJsonBody(\n  req: IncomingMessage,\n  limitBytes: number,\n): Promise<Record<string, unknown>> {\n  const data = await readRequestBody(req, limitBytes);\n  if (data.length === 0) return {};\n  try {\n    const parsed = JSON.parse(data.toString("utf8"));\n    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {\n      throw new InvalidJsonBodyError("JSON request body must be an object");\n    }\n    return parsed as Record<string, unknown>;\n  } catch (error) {\n    if (error instanceof InvalidJsonBodyError) throw error;\n    throw new InvalidJsonBodyError();\n  }\n}\n\nexport function assertRequestScope(auth: AuthContext, scope: AuthScope): void {\n  if (auth.isDevAuth) return;\n  if (!auth.claims || !hasRequiredScope(auth.claims, scope)) {\n    throw new TokenError("invalid_scope", `Missing required scope: ${scope}`, 403);\n  }\n}\n\nexport function classifyHttpError(error: unknown): {\n  status: number;\n  code: string;\n  message: string;\n} {\n  if (error instanceof TokenError) {\n    return { status: error.httpStatus, code: error.code.toUpperCase(), message: error.message };\n  }\n  if (error instanceof RequestBodyTooLargeError) {\n    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: error.message };\n  }\n  if (error instanceof InvalidJsonBodyError) {\n    return { status: 400, code: "INVALID_REQUEST", message: error.message };\n  }\n  return {\n    status: 500,\n    code: "INTERNAL_ERROR",\n    message: error instanceof Error ? error.message : String(error),\n  };\n}\n\nexport async function probeReadiness(\n  dbPool: DatabasePool,\n  objectStore: ObjectStore,\n  queue: DurableQueue,\n): Promise<{ database: boolean; storage: boolean; queue: boolean }> {\n  const database = dbPool.isConnected();\n  const [storageResult, queueResult] = await Promise.allSettled([\n    objectStore.listObjects("__tool_evolver_health__", 1),\n    queue.getQueueStats(),\n  ]);\n  return {\n    database,\n    storage: storageResult.status === "fulfilled",\n    queue: queueResult.status === "fulfilled",\n  };\n}\n''',
)

# ---------------------------------------------------------------------------
# Cloud API server hardening.
# ---------------------------------------------------------------------------
api_path = "apps/cloud/src/server/api.ts"
replace_once(
    api_path,
    'import { type CloudConfig, loadConfig } from "../config.js";',
    'import { type CloudConfig, assertSecureCloudConfig, loadConfig } from "../config.js";',
)
replace_once(
    api_path,
    'import { type TenantContext, TenantGuard, getTenantContext, runWithTenant } from "../tenant.js";\n',
    '''import { type TenantContext, TenantGuard, getTenantContext, runWithTenant } from "../tenant.js";\nimport {\n  assertRequestScope,\n  buildStandardHeaders,\n  classifyHttpError,\n  isOriginAllowed,\n  probeReadiness,\n  readJsonBody,\n  readRequestBody,\n} from "./security.js";\n''',
)
replace_once(
    api_path,
    '    this.config = options.config ?? loadConfig();\n    this.dbPool',
    '    this.config = options.config ?? loadConfig();\n    assertSecureCloudConfig(this.config);\n    this.dbPool',
)
replace_once(api_path, '          allowDevHeaders: true,', '          allowDevHeaders: this.config.auth.allowDevAuth,')
regex_once(
    api_path,
    r'  private async parseJsonBody\(req: IncomingMessage\): Promise<Record<string, unknown>> \{.*?\n  \}\n\n  private sendJson',
    '''  private async parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {\n    return readJsonBody(req, this.config.server.bodyLimitBytes);\n  }\n\n  private sendJson''',
)
regex_once(
    api_path,
    r'    // Standard headers\n    const standardHeaders: Record<string, string> = \{.*?\n    \};',
    '''    const standardHeaders = buildStandardHeaders(\n      req,\n      this.config,\n      traceId,\n      requestId,\n    );''',
)
replace_once(
    api_path,
    '''    if (req.method === "OPTIONS") {\n      res.writeHead(204, standardHeaders);\n      res.end();\n      return;\n    }''',
    '''    if (req.method === "OPTIONS") {\n      if (!isOriginAllowed(req, this.config)) {\n        this.sendJson(res, 403, { error: "CORS_ORIGIN_DENIED" }, standardHeaders);\n        return;\n      }\n      res.writeHead(204, standardHeaders);\n      res.end();\n      return;\n    }''',
)
regex_once(
    api_path,
    r'    if \(path === "/health/ready" && req.method === "GET"\) \{.*?\n      return;\n    \}',
    '''    if (path === "/health/ready" && req.method === "GET") {\n      const checks = await probeReadiness(this.dbPool, this.objectStore, this.queue);\n      const allOk = checks.database && checks.storage && checks.queue;\n      const healthStatus: HealthStatus = {\n        status: allOk ? "ok" : "unready",\n        timestamp: Date.now(),\n        uptime: (Date.now() - this.startTime) / 1000,\n        checks,\n      };\n      this.sendJson(res, allOk ? 200 : 503, healthStatus, standardHeaders);\n      return;\n    }''',
)
replace_once(
    api_path,
    '''      } catch (err: unknown) {\n        const message = err instanceof Error ? err.message : String(err);\n        this.sendJson(\n          res,\n          400,\n          {\n            error: "INVALID_REQUEST",\n            message,\n          },\n          standardHeaders,\n        );\n        return;\n      }''',
    '''      } catch (err: unknown) {\n        const failure = classifyHttpError(err);\n        this.sendJson(\n          res,\n          failure.status === 500 ? 400 : failure.status,\n          { error: failure.status === 500 ? "INVALID_REQUEST" : failure.code, message: failure.message },\n          standardHeaders,\n        );\n        return;\n      }''',
)
regex_once(
    api_path,
    r'      const isPublicRegistration = path === "/v1/accounts" && req.method === "POST";\n      let activeContext: TenantContext;\n      let authContext: AuthContext;\n\n      if \(isPublicRegistration\) \{.*?\n      \}\n\n(?=      try \{\n        await runWithTenant)',
    '''      let activeContext: TenantContext;\n      let authContext: AuthContext;\n\n      try {\n        authContext = await authenticateHttpRequest(req, this.authService, {\n          allowDevHeaders: this.config.auth.allowDevAuth,\n        });\n        activeContext = authContext.tenant;\n      } catch (err: unknown) {\n        const failure = classifyHttpError(err);\n        this.sendJson(res, failure.status === 500 ? 401 : failure.status, {\n          error: failure.code === "UNAUTHORIZED_CLIENT" ? "UNAUTHORIZED" : failure.code,\n          message: failure.message || "Missing or invalid authorization credentials",\n        }, standardHeaders);\n        return;\n      }\n\n''',
)
replace_once(
    api_path,
    '''      } catch (err: unknown) {\n        const message = err instanceof Error ? err.message : String(err);\n        this.sendJson(\n          res,\n          500,\n          {\n            error: "INTERNAL_ERROR",\n            message,\n          },\n          standardHeaders,\n        );\n      }''',
    '''      } catch (err: unknown) {\n        const failure = classifyHttpError(err);\n        this.sendJson(\n          res,\n          failure.status,\n          { error: failure.code, message: failure.message },\n          standardHeaders,\n        );\n      }''',
)
route_guards = [
    ('    if (path === "/v1/observations/batch" && req.method === "POST") {', '      assertRequestScope(authContext, "observations:write");'),
    ('    if (path === "/v1/telemetry/batch" && req.method === "POST") {', '      assertRequestScope(authContext, "telemetry:write");'),
    ('    if ((path === "/v1/mcp" || path === "/mcp") && req.method === "POST") {', '      assertRequestScope(authContext, "catalog:read");'),
    ('    if ((path === "/v1/mcp/sse" || path === "/mcp/sse") && req.method === "GET") {', '      assertRequestScope(authContext, "catalog:read");'),
    ('    if (path === "/v1/tools/invoke" && req.method === "POST") {', '      assertRequestScope(authContext, "catalog:read");'),
    ('    if (path === "/v1/catalog/snapshot" && (req.method === "GET" || req.method === "POST")) {', '      assertRequestScope(authContext, "catalog:read");'),
    ('    if (path === "/v1/accounts") {', '      assertRequestScope(authContext, "admin:all");'),
    ('    if (path === "/v1/workspaces") {', '      assertRequestScope(authContext, "admin:all");'),
    ('    if (path === "/v1/devices") {', '      assertRequestScope(authContext, "admin:all");'),
    ('    if (path === "/v1/jobs/dead-letter") {', '      assertRequestScope(authContext, "admin:all");'),
    ('    if (path === "/v1/jobs/dead-letter/requeue" && req.method === "POST") {', '      assertRequestScope(authContext, "admin:all");'),
    ('    if (path === "/v1/outbox") {', '      assertRequestScope(authContext, "admin:all");'),
    ('    if (path === "/v1/outbox/dispatch" && req.method === "POST") {', '      assertRequestScope(authContext, "admin:all");'),
]
for marker, guard in route_guards:
    replace_once(api_path, marker, marker + "\n" + guard)
replace_once(
    api_path,
    '    if (path === "/v1/jobs") {',
    '''    if (path === "/v1/jobs") {\n      assertRequestScope(authContext, "admin:all");\n      if (this.config.environment !== "development" && this.config.environment !== "test") {\n        this.sendJson(res, 404, { error: "NOT_FOUND" }, headers);\n        return;\n      }''',
)
replace_once(
    api_path,
    '''      const method = (body.method as "GET" | "PUT") || "GET";\n      const ttl = Number(body.ttlSeconds ?? 3600);''',
    '''      const method = (body.method as "GET" | "PUT") || "GET";\n      assertRequestScope(authContext, method === "PUT" ? "deployments:write" : "artifacts:read");\n      const ttl = Math.min(Math.max(Number(body.ttlSeconds ?? 3600), 1), 3600);\n      if (!key || (method !== "GET" && method !== "PUT")) {\n        this.sendJson(res, 400, { error: "BAD_REQUEST" }, headers);\n        return;\n      }''',
)
replace_once(
    api_path,
    '      if (req.method === "GET") {\n        try {\n          const buffer = await this.objectStore.getObject(scopedKey);',
    '      if (req.method === "GET") {\n        assertRequestScope(authContext, "artifacts:read");\n        try {\n          const buffer = await this.objectStore.getObject(scopedKey);',
)
replace_once(
    api_path,
    '''      if (req.method === "PUT") {\n        const { promise, resolve, reject } = Promise.withResolvers<Buffer>();\n        const chunks: Buffer[] = [];\n        req.on("data", (chunk: Buffer) => chunks.push(chunk));\n        req.on("end", () => resolve(Buffer.concat(chunks)));\n        req.on("error", reject);\n\n        const data = await promise;''',
    '''      if (req.method === "PUT") {\n        assertRequestScope(authContext, "deployments:write");\n        const data = await readRequestBody(req, this.config.server.bodyLimitBytes);''',
)
replace_once(api_path, '? await this.parseJsonBody(req).catch(() => ({}))', '? await this.parseJsonBody(req)')

middleware_path = "apps/cloud/src/auth/middleware.ts"
replace_once(
    middleware_path,
    'export interface AuthMiddlewareOptions {',
    '''function parseDevTenantToken(token: string): { accountId: string; workspaceId: string } | null {\n  const parts = token.split(":");\n  if (parts.length !== 2) return null;\n  const [accountId, workspaceId] = parts.map((part) => part.trim());\n  if (!accountId || !workspaceId) return null;\n  return { accountId, workspaceId };\n}\n\nexport interface AuthMiddlewareOptions {''',
)
replace_once(
    middleware_path,
    '''    if (options.allowDevHeaders && token.includes(":") && !token.includes(".")) {\n      const [acc, ws] = token.split(":");\n      const tenant: TenantContext = {\n        accountId: acc,\n        workspaceId: ws,''',
    '''    const devTenant = options.allowDevHeaders && !token.includes(".")\n      ? parseDevTenantToken(token)\n      : null;\n    if (devTenant) {\n      const tenant: TenantContext = {\n        accountId: devTenant.accountId,\n        workspaceId: devTenant.workspaceId,''',
)
regex_once(
    middleware_path,
    r'    // 1\. Try URL query parameter \?token=\.\.\..*?\n    // 2\. Try standard Authorization header',
    '    // 1. Standard Authorization header. Query-string tokens are intentionally rejected.\n    // They leak through browser history, reverse-proxy logs, and referrer headers.',
)
replace_once(middleware_path, '    // 3. Try Sec-WebSocket-Protocol token', '    // 2. Try Sec-WebSocket-Protocol token')
replace_once(middleware_path, '    // 4. Dev headers', '    // 3. Dev headers')

omp_test = "adapters/omp/tests/qualification.test.ts"
replace_once(
    omp_test,
    '''      const configPath = path.join(tempDir, "config.json");\n      await fsp.writeFile(configPath, JSON.stringify({ mcpServers: {} }));\n\n      const installation = await probeOmpInstallation({\n        customConfigPath: configPath,\n        ompHome: tempDir,\n      });''',
    '''      const configPath = path.join(tempDir, "config.json");\n      const executablePath = path.join(tempDir, process.platform === "win32" ? "omp.cmd" : "omp");\n      await fsp.writeFile(configPath, JSON.stringify({ mcpServers: {} }));\n      await fsp.writeFile(\n        executablePath,\n        process.platform === "win32" ? "@echo 0.1.0\\r\\n" : "#!/bin/sh\\necho 0.1.0\\n",\n        { mode: 0o755 },\n      );\n\n      const installation = await probeOmpInstallation({\n        customConfigPath: configPath,\n        customExecutablePath: executablePath,\n        ompHome: tempDir,\n      });''',
)

write(
    "apps/cloud/tests/security-hardening.test.ts",
    '''import { describe, expect, it } from "vitest";\nimport { loadConfig } from "../src/config.js";\nimport { MemoryDatabasePool, runMigrations } from "../src/db/index.js";\nimport { MemoryDurableQueue } from "../src/queue/index.js";\nimport { createCloudServer } from "../src/server/index.js";\nimport { MemoryObjectStore } from "../src/storage/index.js";\n\nasync function startServer(config = loadConfig({\n  environment: "test",\n  server: {\n    host: "127.0.0.1",\n    port: 0,\n    logLevel: "info",\n    bodyLimitBytes: 1024,\n    requestTimeoutMs: 5000,\n    corsOrigins: ["https://allowed.example"],\n  },\n})) {\n  const dbPool = new MemoryDatabasePool();\n  await runMigrations(dbPool);\n  const server = createCloudServer({ config, dbPool, objectStore: new MemoryObjectStore(), queue: new MemoryDurableQueue() });\n  const port = await server.start(0, "127.0.0.1");\n  return { baseUrl: `http://127.0.0.1:${port}`, stop: async () => { await server.stop(); await dbPool.end(); } };\n}\n\ndescribe("Cloud production security hardening", () => {\n  it("rejects insecure production configuration", () => {\n    expect(() => loadConfig({ environment: "production", auth: { jwtSecret: "dev-jwt-secret-min-16-characters-long", deviceTokenSecret: "dev-device-token-secret-16-chars-long", issuer: "tool-evolver-cloud", audience: "tool-evolver-client", tokenTtlSeconds: 86400, allowDevAuth: true } })).toThrow(/Unsafe production cloud configuration/);\n  });\n\n  it("does not accept development tenant headers in production", async () => {\n    const config = loadConfig({\n      environment: "production",\n      database: { url: "postgres://service:strong-password@db.internal:5432/tool_evolver", host: "db.internal", port: 5432, database: "tool_evolver", user: "service", password: "strong-password", ssl: true, maxConnections: 20, idleTimeoutMs: 30000, connectionTimeoutMs: 5000 },\n      storage: { provider: "s3", bucket: "tool-evolver-prod", region: "us-east-1", accessKeyId: "service-key", secretAccessKey: "service-secret", forcePathStyle: false },\n      queue: { provider: "postgres", concurrency: 10, pollIntervalMs: 1000, visibilityTimeoutMs: 30000, maxAttempts: 3, deadLetterThreshold: 3, backoffBaseMs: 1000 },\n      auth: { jwtSecret: "production-jwt-secret-value-32-characters", deviceTokenSecret: "production-device-secret-value-32-chars", issuer: "tool-evolver-cloud", audience: "tool-evolver-client", tokenTtlSeconds: 3600, allowDevAuth: false },\n      server: { host: "127.0.0.1", port: 0, logLevel: "info", bodyLimitBytes: 1024, requestTimeoutMs: 5000, corsOrigins: ["https://console.example"] },\n    });\n    const { baseUrl, stop } = await startServer(config);\n    try {\n      const response = await fetch(`${baseUrl}/v1/devices`, { headers: { "x-account-id": "victim", "x-workspace-id": "victim-workspace" } });\n      expect(response.status).toBe(401);\n    } finally { await stop(); }\n  });\n\n  it("enforces request body limits and explicit CORS origins", async () => {\n    const config = loadConfig({ environment: "test", server: { host: "127.0.0.1", port: 0, logLevel: "info", bodyLimitBytes: 32, requestTimeoutMs: 5000, corsOrigins: ["https://allowed.example"] } });\n    const { baseUrl, stop } = await startServer(config);\n    try {\n      const corsResponse = await fetch(`${baseUrl}/health/live`, { headers: { Origin: "https://evil.example" } });\n      expect(corsResponse.headers.get("access-control-allow-origin")).toBeNull();\n      const oversized = await fetch(`${baseUrl}/v1/accounts`, { method: "POST", headers: { "Content-Type": "application/json", "x-account-id": "acc-test", "x-workspace-id": "ws-test" }, body: JSON.stringify({ data: "x".repeat(128) }) });\n      expect(oversized.status).toBe(413);\n    } finally { await stop(); }\n  });\n});\n''',
)

(ROOT / ".github/agent/security_auth_api.py").unlink()
(ROOT / ".github/workflows/agent-security-auth-api.yml").unlink()

# retrigger marker
