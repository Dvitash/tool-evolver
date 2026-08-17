import { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync, inflateSync } from "node:zlib";
import { ChecksumMismatchError, hasRequiredScope } from "@tool-evolver/protocol";
import { AuthContext } from "../auth/middleware.js";
import {
  ConsentRequiredError,
  RawConsentRequiredError,
} from "./consent-guard.js";
import { BatchConflictError } from "./deduplicator.js";
import { QuotaExceededError } from "./quota.js";
import {
  IngestionContext,
  ObservationIngestionService,
  TenantMismatchError,
} from "./service.js";
import {
  CursorOrderingError,
  DecompressionError,
  ObservationValidationError,
  PayloadLimitExceededError,
} from "./validator.js";

/**
 * Reads raw request body as Buffer from IncomingMessage.
 */
async function readBodyBuffer(req: IncomingMessage, limitBytes = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > limitBytes) {
        reject(
          new PayloadLimitExceededError(
            `Request payload size exceeded maximum limit of ${limitBytes} bytes`,
            limitBytes,
            totalLength,
          ),
        );
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
 * Route handler for POST /v1/observations/batch.
 */
export async function handleObservationBatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  authContext: AuthContext,
  ingestionService: ObservationIngestionService,
  sendJson: (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) => void,
  headers: Record<string, string> = {},
): Promise<void> {
  // 1. Check Scope: observations:write
  if (authContext.claims && !hasRequiredScope(authContext.claims, "observations:write")) {
    sendJson(
      res,
      403,
      {
        error: "FORBIDDEN",
        message: "Token lacks required scope 'observations:write' for observation ingestion",
      },
      headers,
    );
    return;
  }

  try {
    // 2. Read Body Buffer
    const rawBuffer = await readBodyBuffer(req);
    const contentEncoding = (req.headers["content-encoding"] || "").toLowerCase();

    let decompressedText: string;
    if (contentEncoding === "gzip") {
      try {
        decompressedText = gunzipSync(rawBuffer).toString("utf8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DecompressionError(`Failed to decompress gzip body: ${msg}`);
      }
    } else if (contentEncoding === "deflate") {
      try {
        decompressedText = inflateSync(rawBuffer).toString("utf8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DecompressionError(`Failed to decompress deflate body: ${msg}`);
      }
    } else {
      decompressedText = rawBuffer.toString("utf8");
    }

    // 3. Parse JSON Body
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(decompressedText);
    } catch {
      throw new ObservationValidationError("Malformed JSON payload in request body");
    }

    // 4. Construct Ingestion Context
    const ingestionContext: IngestionContext = {
      accountId: authContext.tenant.accountId,
      workspaceId: authContext.tenant.workspaceId,
      deviceId: authContext.claims?.deviceId,
      installationId: authContext.claims?.installationId,
      traceId: authContext.tenant.traceId,
      correlationId: authContext.tenant.correlationId,
      scopes: authContext.claims?.scopes,
      rawUploadConsent: authContext.claims?.rawUploadConsent,
    };

    // 5. Ingest Batch
    const response = await ingestionService.ingestBatch(
      ingestionContext,
      parsedBody as Parameters<typeof ingestionService.ingestBatch>[1],
      rawBuffer.length,
    );

    sendJson(res, 200, response, headers);
  } catch (err: unknown) {
    if (err instanceof ObservationValidationError) {
      sendJson(
        res,
        400,
        {
          error: "VALIDATION_ERROR",
          message: err.message,
          errors: err.errors,
        },
        headers,
      );
      return;
    }

    if (err instanceof PayloadLimitExceededError) {
      sendJson(
        res,
        400,
        {
          error: "PAYLOAD_LIMIT_EXCEEDED",
          message: err.message,
          limitBytes: err.limitBytes,
          actualBytes: err.actualBytes,
        },
        headers,
      );
      return;
    }

    if (err instanceof CursorOrderingError) {
      sendJson(
        res,
        400,
        {
          error: "CURSOR_ORDERING_ERROR",
          message: err.message,
        },
        headers,
      );
      return;
    }

    if (err instanceof DecompressionError) {
      sendJson(
        res,
        400,
        {
          error: "DECOMPRESSION_ERROR",
          message: err.message,
        },
        headers,
      );
      return;
    }

    if (err instanceof ChecksumMismatchError) {
      sendJson(
        res,
        400,
        {
          error: "CHECKSUM_MISMATCH",
          message: err.message,
          expectedDigest: err.expectedDigest,
          receivedDigest: err.actualDigest,
        },
        headers,
      );
      return;
    }

    if (err instanceof TenantMismatchError) {
      sendJson(
        res,
        403,
        {
          error: "TENANT_MISMATCH",
          message: err.message,
          field: err.field,
        },
        headers,
      );
      return;
    }

    if (err instanceof ConsentRequiredError) {
      sendJson(
        res,
        403,
        {
          error: "CONSENT_REQUIRED",
          message: err.message,
          workspaceId: err.workspaceId,
        },
        headers,
      );
      return;
    }

    if (err instanceof RawConsentRequiredError) {
      sendJson(
        res,
        403,
        {
          error: "RAW_CONSENT_REQUIRED",
          message: err.message,
          violations: err.violations,
        },
        headers,
      );
      return;
    }

    if (err instanceof BatchConflictError) {
      sendJson(
        res,
        409,
        {
          error: "BATCH_CONFLICT",
          message: err.message,
          batchId: err.batchId,
          cursor: err.cursor,
        },
        headers,
      );
      return;
    }

    if (err instanceof QuotaExceededError) {
      sendJson(
        res,
        429,
        {
          error: "QUOTA_EXCEEDED",
          message: err.message,
          limitType: err.limitType,
          retryAfterSeconds: err.retryAfterSeconds,
        },
        {
          ...headers,
          "Retry-After": String(err.retryAfterSeconds),
        },
      );
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    sendJson(
      res,
      500,
      {
        error: "INTERNAL_ERROR",
        message,
      },
      headers,
    );
  }
}
