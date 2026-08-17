import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { CloudConfig, loadConfig } from "../config.js";
import { DatabasePool, createDatabasePool } from "../db/client.js";
import { OutboxPublisher, OutboxRepository } from "../db/outbox.js";
import { DurableQueue, createDurableQueue } from "../queue/queue.js";
import { createJobEnvelope } from "../queue/envelope.js";
import { ObjectStore, createObjectStore } from "../storage/object-store.js";
import {
  TenantContext,
  TenantGuard,
  getTenantContext,
  runWithTenant,
} from "../tenant.js";
import {
  AuthContext,
  AuthService,
  TokenError,
  authenticateHttpRequest,
  authenticateWebSocket,
  createAuthService,
  handleAuthRoutes,
} from "../auth/index.js";
import {
  ObservationIngestionService,
  createObservationIngestionService,
  handleObservationBatchRoute,
} from "../ingestion/index.js";
import {
  CloudCatalogService,
  createCloudCatalogService,
  CloudMcpServer,
  createCloudMcpServer,
} from "../mcp/index.js";

/**
 * Health check status response.
 */
export interface HealthStatus {
  status: "ok" | "degraded" | "unready";
  timestamp: number;
  uptime: number;
  checks?: {
    database: boolean;
    storage: boolean;
    queue: boolean;
  };
}

/**
 * Cloud API Server options.
 */
export interface CloudServerOptions {
  config?: CloudConfig;
  dbPool?: DatabasePool;
  objectStore?: ObjectStore;
  queue?: DurableQueue;
  outboxPublisher?: OutboxPublisher;
  authService?: AuthService;
  ingestionService?: ObservationIngestionService;
  catalogService?: CloudCatalogService;
  mcpServer?: CloudMcpServer;
}
/**
 * Cloud API Server shell providing HTTP endpoints, health checks,
 * tenant context middleware, and trace propagation.
 */
export class CloudServer {
  private config: CloudConfig;
  private dbPool: DatabasePool;
  private objectStore: ObjectStore;
  private queue: DurableQueue;
  private outboxPublisher: OutboxPublisher;
  private server: Server | null = null;
  private authService: AuthService;
  private ingestionService: ObservationIngestionService;
  private catalogService: CloudCatalogService;
  private mcpServer: CloudMcpServer;
  private startTime: number;

  constructor(options: CloudServerOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.dbPool = options.dbPool ?? createDatabasePool(this.config.database);
    this.objectStore = options.objectStore ?? createObjectStore(this.config.storage);
    this.queue = options.queue ?? createDurableQueue(this.config.queue, this.dbPool);
    this.outboxPublisher = options.outboxPublisher ?? new OutboxPublisher(this.dbPool);
    this.authService =
      options.authService ??
      createAuthService({
        config: this.config.auth,
      });
    this.startTime = Date.now();
    this.ingestionService =
      options.ingestionService ??
      createObservationIngestionService({
        dbPool: this.dbPool,
        consentManager: this.authService.consentManager,
      });
    this.catalogService =
      options.catalogService ??
      createCloudCatalogService({
        dbPool: this.dbPool,
        outboxPublisher: this.outboxPublisher,
      });

    this.mcpServer =
      options.mcpServer ??
      createCloudMcpServer({
        catalogService: this.catalogService,
      });
  }

  getDbPool(): DatabasePool {
    return this.dbPool;
  }

  getObjectStore(): ObjectStore {
    return this.objectStore;
  }

  getQueue(): DurableQueue {
    return this.queue;
  }

  getOutboxPublisher(): OutboxPublisher {
    return this.outboxPublisher;
  }

  getIngestionService(): ObservationIngestionService {
    return this.ingestionService;
  }

  getConfig(): CloudConfig {
    return this.config;
  }

  getCatalogService(): CloudCatalogService {
    return this.catalogService;
  }

  getMcpServer(): CloudMcpServer {
    return this.mcpServer;
  }

  /**
   * Start the HTTP server.
   */
  async start(port = this.config.server.port, host = this.config.server.host): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<number>();

    this.server = createServer((req, res) => this.handleRequest(req, res));

    this.server.on("error", (err) => {
      reject(err);
    });
    this.server.on("upgrade", async (req, socket: Socket, _head) => {
      try {
        const authContext = await authenticateWebSocket(req, this.authService, {
          allowDevHeaders: true,
        });

        if (!authContext) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        if (authContext.claims?.deviceId) {
          const isRevoked = await this.authService.tokenRepository.isDeviceRevoked(
            authContext.claims.deviceId,
          );
          if (isRevoked) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
        }

        this.server?.emit("wsConnection", socket, authContext);
      } catch {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });

    this.server.listen(port, host, () => {
      const addr = this.server?.address() as AddressInfo;
      const actualPort = addr ? addr.port : port;
      resolve(actualPort);
    });

    return promise;
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.outboxPublisher.stop();

    this.server.close((err) => {
      this.server = null;
      if (err) reject(err);
      else resolve();
    });

    return promise;
  }

  /**
   * Get listening server address info.
   */
  address(): AddressInfo | null {
    if (!this.server) return null;
    return this.server.address() as AddressInfo | null;
  }

  private async parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        resolve(bodyStr ? JSON.parse(bodyStr) : {});
      } catch (err) {
        reject(new Error("Invalid JSON payload"));
      }
    });

    req.on("error", (err) => {
      reject(err);
    });

    return promise;
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      ...headers,
    });
    res.end(JSON.stringify(data));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const traceId = (req.headers["x-trace-id"] as string) || randomUUID();
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();

    // Standard headers
    const standardHeaders: Record<string, string> = {
      "x-trace-id": traceId,
      "x-request-id": requestId,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-account-id, x-workspace-id, x-trace-id, x-request-id",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, standardHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // 1. Health checks (public, no auth required)
    if (path === "/health/live" && req.method === "GET") {
      this.sendJson(
        res,
        200,
        {
          status: "ok",
          timestamp: Date.now(),
          uptime: (Date.now() - this.startTime) / 1000,
        },
        standardHeaders,
      );
      return;
    }

    if (path === "/health/ready" && req.method === "GET") {
      const dbOk = this.dbPool.isConnected();
      const storageOk = true;
      const queueOk = true;
      const allOk = dbOk && storageOk && queueOk;

      const healthStatus: HealthStatus = {
        status: allOk ? "ok" : "degraded",
        timestamp: Date.now(),
        uptime: (Date.now() - this.startTime) / 1000,
        checks: {
          database: dbOk,
          storage: storageOk,
          queue: queueOk,
        },
      };

      this.sendJson(res, allOk ? 200 : 503, healthStatus, standardHeaders);
      return;
    }

    // 2. Authentication routes under /v1/auth/*
    if (path.startsWith("/v1/auth/")) {
      try {
        let body: Record<string, unknown> = {};
        if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
          body = await this.parseJsonBody(req);
        }
        const handled = await handleAuthRoutes(
          req,
          res,
          path,
          body,
          this.authService,
          standardHeaders,
        );
        if (handled) return;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.sendJson(
          res,
          400,
          {
            error: "INVALID_REQUEST",
            message,
          },
          standardHeaders,
        );
        return;
      }
    }

    // 3. For all other /v1/* endpoints, authenticate and establish tenant context
    // 3. For all other /v1/* endpoints, /mcp, or /mcp/sse, authenticate and establish tenant context
    if (path.startsWith("/v1/") || path === "/mcp" || path === "/mcp/sse") {
      const isPublicRegistration = path === "/v1/accounts" && req.method === "POST";
      let activeContext: TenantContext;
      let authContext: AuthContext;

      if (isPublicRegistration) {
        activeContext = {
          accountId: "system",
          workspaceId: "system",
          traceId,
          correlationId: requestId,
        };
        authContext = {
          tenant: activeContext,
          isDevAuth: false,
        };
      } else {
        try {
          authContext = await authenticateHttpRequest(req, this.authService, {
            allowDevHeaders: true,
          });
          activeContext = authContext.tenant;
        } catch (err: unknown) {
          if (err instanceof TokenError) {
            this.sendJson(
              res,
              err.httpStatus,
              {
                error: err.code === "unauthorized_client" ? "UNAUTHORIZED" : err.code.toUpperCase(),
                message: err.message,
              },
              standardHeaders,
            );
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          this.sendJson(
            res,
            401,
            {
              error: "UNAUTHORIZED",
              message: message || "Missing or invalid authorization credentials",
            },
            standardHeaders,
          );
          return;
        }
      }

      try {
        await runWithTenant(activeContext, async () => {
          await this.routeV1(req, res, path, url, standardHeaders, authContext);
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.sendJson(
          res,
          500,
          {
            error: "INTERNAL_ERROR",
            message,
          },
          standardHeaders,
        );
      }
      return;
    }

    this.sendJson(res, 404, { error: "NOT_FOUND", message: `Route ${path} not found` }, standardHeaders);
  }

  private async routeV1(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
    headers: Record<string, string>,
    authContext: AuthContext,
  ): Promise<void> {
    const tenant = getTenantContext()!;

    // Observation Batch Ingestion
    if (path === "/v1/observations/batch" && req.method === "POST") {
      await handleObservationBatchRoute(
        req,
        res,
        authContext,
        this.ingestionService,
        (r, status, data, h) => this.sendJson(r, status, data, h),
        headers,
      );
      return;
    }

    // Cloud MCP Protocol Endpoint (JSON-RPC)
    if ((path === "/v1/mcp" || path === "/mcp") && req.method === "POST") {
      await this.mcpServer.handleHttpJsonRpc(req, res, authContext);
      return;
    }

    // Cloud MCP SSE Streaming Transport
    if ((path === "/v1/mcp/sse" || path === "/mcp/sse") && req.method === "GET") {
      await this.mcpServer.handleSseStream(req, res, authContext);
      return;
    }

    // Cloud MCP Tool Invocation (Gateway Proxy compatibility)
    if (path === "/v1/tools/invoke" && req.method === "POST") {
      await this.mcpServer.handleToolInvoke(req, res, authContext);
      return;
    }

    // Cloud Catalog Snapshot
    if (path === "/v1/catalog/snapshot" && (req.method === "GET" || req.method === "POST")) {
      await this.mcpServer.handleCatalogSnapshot(req, res, authContext);
      return;
    }

    // Accounts
    if (path === "/v1/accounts") {
      if (req.method === "GET") {
        const result = await this.dbPool.query("SELECT * FROM accounts WHERE id = $1", [tenant.accountId]);
        this.sendJson(res, 200, { accounts: result.rows }, headers);
        return;
      }
      if (req.method === "POST") {
        const body = await this.parseJsonBody(req);
        const id = (body.id as string) || `acc-${randomUUID().slice(0, 8)}`;
        const name = (body.name as string) || "Default Account";
        const plan = (body.plan as string) || "standard";
        await this.dbPool.query(
          "INSERT INTO accounts (id, name, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
          [id, name, plan, new Date().toISOString(), new Date().toISOString()],
        );
        this.sendJson(res, 201, { account: { id, name, plan } }, headers);
        return;
      }
    }

    // Workspaces
    if (path === "/v1/workspaces") {
      if (req.method === "GET") {
        const result = await this.dbPool.query(
          "SELECT * FROM workspaces WHERE account_id = $1",
          [tenant.accountId],
        );
        this.sendJson(res, 200, { workspaces: result.rows }, headers);
        return;
      }
      if (req.method === "POST") {
        const body = await this.parseJsonBody(req);
        const id = (body.id as string) || `ws-${randomUUID().slice(0, 8)}`;
        const name = (body.name as string) || "Default Workspace";
        const slug = (body.slug as string) || "default";
        await this.dbPool.query(
          "INSERT INTO workspaces (id, account_id, name, slug, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
          [id, tenant.accountId, name, slug, new Date().toISOString(), new Date().toISOString()],
        );
        this.sendJson(res, 201, { workspace: { id, accountId: tenant.accountId, name, slug } }, headers);
        return;
      }
    }

    // Devices
    if (path === "/v1/devices") {
      if (req.method === "GET") {
        const result = await this.dbPool.query(
          "SELECT * FROM devices WHERE account_id = $1 AND workspace_id = $2",
          [tenant.accountId, tenant.workspaceId],
        );
        this.sendJson(res, 200, { devices: result.rows }, headers);
        return;
      }
      if (req.method === "POST") {
        const body = await this.parseJsonBody(req);
        const id = (body.id as string) || `dev-${randomUUID().slice(0, 8)}`;
        const name = (body.name as string) || "Developer Device";
        const platform = (body.platform as string) || "darwin-arm64";
        await this.dbPool.query(
          "INSERT INTO devices (id, account_id, workspace_id, name, platform, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [id, tenant.accountId, tenant.workspaceId, name, platform, "registered", new Date().toISOString(), new Date().toISOString()],
        );
        this.sendJson(res, 201, { device: { id, accountId: tenant.accountId, workspaceId: tenant.workspaceId, name, platform } }, headers);
        return;
      }
    }

    // Queue Jobs
    if (path === "/v1/jobs") {
      if (req.method === "POST") {
        const body = await this.parseJsonBody(req);
        const envelope = createJobEnvelope({
          jobType: (body.jobType as string) || "general",
          version: (body.version as string) || "1.0.0",
          tenantContext: tenant,
          payload: body.payload ?? {},
          idempotencyKey: body.idempotencyKey as string | undefined,
        });

        const jobId = await this.queue.enqueue(envelope);
        this.sendJson(res, 202, { jobId, status: "enqueued", envelope }, headers);
        return;
      }
      if (req.method === "GET") {
        const stats = await this.queue.getQueueStats();
        this.sendJson(res, 200, { stats }, headers);
        return;
      }
    }

    // Dead Letter Queue
    if (path === "/v1/jobs/dead-letter") {
      if (req.method === "GET") {
        const dlqJobs = await this.queue.getDeadLetterJobs();
        const filtered = dlqJobs.filter((j) => j.accountId === tenant.accountId && j.workspaceId === tenant.workspaceId);
        this.sendJson(res, 200, { deadLetterJobs: filtered }, headers);
        return;
      }
    }

    if (path === "/v1/jobs/dead-letter/requeue" && req.method === "POST") {
      const body = await this.parseJsonBody(req);
      const deadLetterId = body.deadLetterId as string;
      if (!deadLetterId) {
        this.sendJson(res, 400, { error: "BAD_REQUEST", message: "Missing deadLetterId" }, headers);
        return;
      }
      const envelope = await this.queue.requeue(deadLetterId);
      this.sendJson(res, 200, { requeued: true, jobId: envelope.jobId }, headers);
      return;
    }

    // Storage Objects
    if (path === "/v1/objects/presigned-url" && req.method === "POST") {
      const body = await this.parseJsonBody(req);
      const key = body.key as string;
      const method = (body.method as "GET" | "PUT") || "GET";
      const ttl = Number(body.ttlSeconds ?? 3600);

      const scopedKey = `${tenant.accountId}/${tenant.workspaceId}/${key}`;

      const presigned = method === "PUT"
        ? await this.objectStore.createPresignedPutUrl(scopedKey, ttl, { contentType: body.contentType as string })
        : await this.objectStore.createPresignedGetUrl(scopedKey, ttl);

      this.sendJson(res, 200, presigned, headers);
      return;
    }

    if (path.startsWith("/v1/objects/")) {
      const rawKey = decodeURIComponent(path.slice("/v1/objects/".length));
      const scopedKey = `${tenant.accountId}/${tenant.workspaceId}/${rawKey}`;

      if (req.method === "GET") {
        try {
          const buffer = await this.objectStore.getObject(scopedKey);
          const meta = await this.objectStore.getMetadata(scopedKey);
          res.writeHead(200, {
            ...headers,
            "Content-Type": meta?.contentType ?? "application/octet-stream",
            "x-sha256": meta?.sha256 ?? "",
          });
          res.end(buffer);
          return;
        } catch {
          this.sendJson(res, 404, { error: "NOT_FOUND", message: `Object '${rawKey}' not found` }, headers);
          return;
        }
      }

      if (req.method === "PUT") {
        const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);

        const data = await promise;
        const meta = await this.objectStore.putObject(scopedKey, data, {
          contentType: req.headers["content-type"] as string,
          sha256: req.headers["x-sha256"] as string,
        });

        this.sendJson(res, 201, { object: meta }, headers);
        return;
      }
    }

    // Outbox
    if (path === "/v1/outbox") {
      if (req.method === "GET") {
        const records = await OutboxRepository.fetchPending(this.dbPool);
        const scoped = records.filter((r) => r.accountId === tenant.accountId && r.workspaceId === tenant.workspaceId);
        this.sendJson(res, 200, { outbox: scoped }, headers);
        return;
      }
      if (req.method === "POST") {
        const body = await this.parseJsonBody(req);
        const record = await OutboxRepository.insert(this.dbPool, {
          accountId: tenant.accountId,
          workspaceId: tenant.workspaceId,
          aggregateType: (body.aggregateType as string) || "generic",
          aggregateId: (body.aggregateId as string) || randomUUID(),
          eventType: (body.eventType as string) || "GenericEvent",
          payload: (body.payload as Record<string, unknown>) ?? {},
        });
        this.sendJson(res, 201, { outbox: record }, headers);
        return;
      }
    }

    if (path === "/v1/outbox/dispatch" && req.method === "POST") {
      const dispatched = await this.outboxPublisher.dispatchBatch();
      this.sendJson(res, 200, { dispatchedCount: dispatched }, headers);
      return;
    }

    this.sendJson(res, 404, { error: "NOT_FOUND", message: `V1 endpoint '${path}' not found` }, headers);
  }
}

/**
 * Factory function creating a CloudServer instance.
 */
export function createCloudServer(options: CloudServerOptions = {}): CloudServer {
  return new CloudServer(options);
}
