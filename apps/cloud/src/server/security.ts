import type { IncomingMessage } from "node:http";
import { type AuthScope, hasRequiredScope } from "@tool-evolver/protocol";
import { type AuthContext, TokenError } from "../auth/index.js";
import type { CloudConfig } from "../config.js";
import type { DatabasePool } from "../db/client.js";
import type { DurableQueue } from "../queue/queue.js";
import type { ObjectStore } from "../storage/object-store.js";

export class RequestBodyTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(readonly limitBytes: number) {
    super(`Request body exceeds the configured ${limitBytes}-byte limit`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidJsonBodyError extends Error {
  readonly statusCode = 400;
  constructor(message = "Invalid JSON payload") {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
}

export function isOriginAllowed(req: IncomingMessage, config: CloudConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.server.corsOrigins.includes(origin)) return true;
  return (
    (config.environment === "development" || config.environment === "test") &&
    config.server.corsOrigins.includes("*")
  );
}

export function buildStandardHeaders(
  req: IncomingMessage,
  config: CloudConfig,
  traceId: string,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-trace-id": traceId,
    "x-request-id": requestId,
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-trace-id, x-request-id, x-protocol-version",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(req, config)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

export async function readRequestBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    req.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limitBytes) {
        settled = true;
        req.pause();
        reject(new RequestBodyTooLargeError(limitBytes));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export async function readJsonBody(
  req: IncomingMessage,
  limitBytes: number,
): Promise<Record<string, unknown>> {
  const data = await readRequestBody(req, limitBytes);
  if (data.length === 0) return {};
  try {
    const parsed = JSON.parse(data.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidJsonBodyError("JSON request body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) throw error;
    throw new InvalidJsonBodyError();
  }
}

export function assertRequestScope(auth: AuthContext, scope: AuthScope): void {
  if (auth.isDevAuth) return;
  if (!auth.claims || !hasRequiredScope(auth.claims, scope)) {
    throw new TokenError("invalid_scope", `Missing required scope: ${scope}`, 403);
  }
}

export function classifyHttpError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof TokenError) {
    return { status: error.httpStatus, code: error.code.toUpperCase(), message: error.message };
  }
  if (error instanceof RequestBodyTooLargeError) {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: error.message };
  }
  if (error instanceof InvalidJsonBodyError) {
    return { status: 400, code: "INVALID_REQUEST", message: error.message };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function probeReadiness(
  dbPool: DatabasePool,
  objectStore: ObjectStore,
  queue: DurableQueue,
): Promise<{ database: boolean; storage: boolean; queue: boolean }> {
  const database = dbPool.isConnected();
  const [storageResult, queueResult] = await Promise.allSettled([
    objectStore.listObjects("__tool_evolver_health__", 1),
    queue.getQueueStats(),
  ]);
  return {
    database,
    storage: storageResult.status === "fulfilled",
    queue: queueResult.status === "fulfilled",
  };
}
