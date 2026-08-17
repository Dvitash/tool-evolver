import { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync, inflateSync } from "node:zlib";
import { hasRequiredScope, TelemetryBatchRequestSchema } from "@tool-evolver/protocol";
import { ZodError } from "zod";
import { AuthContext } from "../auth/middleware.js";
import { TelemetryBatchConflictError } from "./deduplicator.js";
import { SchemaGuardValidationError } from "./schema-guard.js";
import { AnalyticsService, AnalyticsTenantMismatchError } from "./service.js";

/**
 * Read request body buffer with size limits.
 */
async function readBodyBuffer(req: IncomingMessage, limitBytes = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;

    req.on("data", (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > limitBytes) {
        req.destroy();
        reject(new Error(`Payload too large: exceeded ${limitBytes} bytes limit`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Route handler for POST /v1/telemetry/batch.
 */
export async function handleTelemetryBatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  authContext: AuthContext,
  analyticsService: AnalyticsService,
  sendJson: (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) => void,
  headers: Record<string, string> = {},
): Promise<void> {
  // 1. Check Scope: telemetry:write or admin:all
  if (
    authContext.claims &&
    !hasRequiredScope(authContext.claims, "telemetry:write") &&
    !hasRequiredScope(authContext.claims, "admin:all")
  ) {
    sendJson(
      res,
      403,
      {
        error: "INSUFFICIENT_SCOPE",
        message: "Missing required scope: 'telemetry:write'",
      },
      headers,
    );
    return;
  }

  try {
    const contentEncoding = (req.headers["content-encoding"] || "").toLowerCase();
    const rawBuffer = await readBodyBuffer(req);

    if (rawBuffer.length === 0) {
      sendJson(
        res,
        400,
        {
          error: "EMPTY_PAYLOAD",
          message: "Request body cannot be empty",
        },
        headers,
      );
      return;
    }

    let jsonString: string;
    if (contentEncoding === "gzip") {
      try {
        jsonString = gunzipSync(rawBuffer).toString("utf-8");
      } catch (err: unknown) {
        sendJson(
          res,
          400,
          {
            error: "DECOMPRESSION_FAILED",
            message: `Failed to decompress gzip payload: ${err instanceof Error ? err.message : String(err)}`,
          },
          headers,
        );
        return;
      }
    } else if (contentEncoding === "deflate") {
      try {
        jsonString = inflateSync(rawBuffer).toString("utf-8");
      } catch (err: unknown) {
        sendJson(
          res,
          400,
          {
            error: "DECOMPRESSION_FAILED",
            message: `Failed to decompress deflate payload: ${err instanceof Error ? err.message : String(err)}`,
          },
          headers,
        );
        return;
      }
    } else {
      jsonString = rawBuffer.toString("utf-8");
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(jsonString);
    } catch {
      sendJson(
        res,
        400,
        {
          error: "INVALID_JSON",
          message: "Request body is not valid JSON",
        },
        headers,
      );
      return;
    }

    const validatedRequest = TelemetryBatchRequestSchema.parse(parsedBody);
    const tenant = authContext.tenant;
    if (!tenant) {
      sendJson(
        res,
        401,
        {
          error: "UNAUTHORIZED",
          message: "Active tenant context required",
        },
        headers,
      );
      return;
    }

    const response = await analyticsService.ingestBatch(tenant, validatedRequest);
    sendJson(res, 200, response, headers);
  } catch (err: unknown) {
    if (err instanceof SchemaGuardValidationError) {
      sendJson(
        res,
        400,
        {
          error: "SCHEMA_GUARD_VALIDATION_ERROR",
          message: err.message,
          violations: err.violations,
        },
        headers,
      );
      return;
    }

    if (err instanceof TelemetryBatchConflictError) {
      sendJson(
        res,
        409,
        {
          error: "BATCH_CONFLICT",
          message: err.message,
          batchId: err.batchId,
        },
        headers,
      );
      return;
    }

    if (err instanceof AnalyticsTenantMismatchError) {
      sendJson(
        res,
        403,
        {
          error: "TENANT_MISMATCH",
          message: err.message,
        },
        headers,
      );
      return;
    }

    if (err instanceof ZodError) {
      sendJson(
        res,
        400,
        {
          error: "VALIDATION_ERROR",
          message: "Request payload does not match schema",
          issues: err.issues,
        },
        headers,
      );
      return;
    }

    const message = err instanceof Error ? err.message : "Internal server error";
    sendJson(
      res,
      500,
      {
        error: "INTERNAL_SERVER_ERROR",
        message,
      },
      headers,
    );
  }
}
