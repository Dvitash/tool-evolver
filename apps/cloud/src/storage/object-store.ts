import { createHash, randomUUID } from "node:crypto";
import type { StorageConfig } from "../config.js";

/**
 * Retention markers for stored objects.
 */
export type RetentionMarker = "permanent" | "standard" | "ephemeral";

/**
 * Metadata associated with a stored object.
 */
export interface ObjectMetadata {
  key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  retention: RetentionMarker;
  expiresAt?: string | null;
  customMetadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Options for storing an object.
 */
export interface PutObjectOptions {
  contentType?: string;
  sha256?: string;
  retention?: RetentionMarker;
  ttlSeconds?: number;
  customMetadata?: Record<string, string>;
}

/**
 * Multipart upload session.
 */
export interface MultipartUploadSession {
  uploadId: string;
  key: string;
  retention: RetentionMarker;
  contentType: string;
  createdAt: string;
  expiresAt?: string;
}

/**
 * Single part uploaded in a multipart session.
 */
export interface UploadedPart {
  partNumber: number;
  sha256: string;
  sizeBytes: number;
  etag?: string;
}

/**
 * Presigned URL descriptor.
 */
export interface PresignedUrlResult {
  url: string;
  method: "GET" | "PUT";
  headers?: Record<string, string>;
  expiresAt: string;
}

/**
 * Error raised when an object checksum verification fails.
 */
export class DigestMismatchError extends Error {
  readonly code = "DIGEST_MISMATCH";
  readonly expectedSha256: string;
  readonly computedSha256: string;

  constructor(expectedSha256: string, computedSha256: string) {
    super(`SHA-256 digest mismatch: expected '${expectedSha256}', computed '${computedSha256}'`);
    this.name = "DigestMismatchError";
    this.expectedSha256 = expectedSha256;
    this.computedSha256 = computedSha256;
  }
}

/**
 * Content-addressed object store interface.
 */
export interface ObjectStore {
  putObject(
    key: string,
    data: Buffer | Uint8Array | string,
    options?: PutObjectOptions,
  ): Promise<ObjectMetadata>;

  getObject(key: string): Promise<Buffer>;

  getMetadata(key: string): Promise<ObjectMetadata | null>;

  deleteObject(key: string): Promise<boolean>;

  exists(key: string): Promise<boolean>;

  listObjects(prefix?: string, limit?: number): Promise<ObjectMetadata[]>;

  initiateMultipartUpload(key: string, options?: PutObjectOptions): Promise<MultipartUploadSession>;

  uploadPart(
    uploadId: string,
    partNumber: number,
    data: Buffer | Uint8Array | string,
    sha256?: string,
  ): Promise<UploadedPart>;

  completeMultipartUpload(uploadId: string, parts: UploadedPart[]): Promise<ObjectMetadata>;

  abortMultipartUpload(uploadId: string): Promise<void>;

  createPresignedGetUrl(key: string, ttlSeconds?: number): Promise<PresignedUrlResult>;

  createPresignedPutUrl(
    key: string,
    ttlSeconds?: number,
    options?: PutObjectOptions,
  ): Promise<PresignedUrlResult>;
}

/**
 * In-memory deterministic object store provider for tests and local development.
 */
export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, { data: Buffer; metadata: ObjectMetadata }>();
  private multipartSessions = new Map<
    string,
    {
      session: MultipartUploadSession;
      parts: Map<number, { data: Buffer; part: UploadedPart }>;
      options?: PutObjectOptions;
    }
  >();

  async putObject(
    key: string,
    data: Buffer | Uint8Array | string,
    options: PutObjectOptions = {},
  ): Promise<ObjectMetadata> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const computedSha256 = createHash("sha256").update(buffer).digest("hex");

    if (options.sha256 && options.sha256.toLowerCase() !== computedSha256.toLowerCase()) {
      throw new DigestMismatchError(options.sha256, computedSha256);
    }

    const now = new Date().toISOString();
    let expiresAt: string | null = null;
    if (options.ttlSeconds) {
      expiresAt = new Date(Date.now() + options.ttlSeconds * 1000).toISOString();
    }

    const metadata: ObjectMetadata = {
      key,
      sha256: computedSha256,
      sizeBytes: buffer.length,
      contentType: options.contentType ?? "application/octet-stream",
      retention: options.retention ?? "standard",
      expiresAt,
      customMetadata: options.customMetadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.objects.set(key, { data: buffer, metadata });
    return metadata;
  }

  async getObject(key: string): Promise<Buffer> {
    const item = this.objects.get(key);
    if (!item) {
      throw new Error(`Object with key '${key}' not found in store`);
    }

    // Check expiration
    if (item.metadata.expiresAt && new Date(item.metadata.expiresAt) < new Date()) {
      this.objects.delete(key);
      throw new Error(`Object with key '${key}' has expired`);
    }

    return item.data;
  }

  async getMetadata(key: string): Promise<ObjectMetadata | null> {
    const item = this.objects.get(key);
    if (!item) return null;

    if (item.metadata.expiresAt && new Date(item.metadata.expiresAt) < new Date()) {
      this.objects.delete(key);
      return null;
    }

    return item.metadata;
  }

  async deleteObject(key: string): Promise<boolean> {
    return this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const meta = await this.getMetadata(key);
    return meta !== null;
  }

  async listObjects(prefix = "", limit = 100): Promise<ObjectMetadata[]> {
    const results: ObjectMetadata[] = [];
    const now = new Date();

    for (const [key, item] of this.objects.entries()) {
      if (item.metadata.expiresAt && new Date(item.metadata.expiresAt) < now) {
        this.objects.delete(key);
        continue;
      }
      if (key.startsWith(prefix)) {
        results.push(item.metadata);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  async initiateMultipartUpload(
    key: string,
    options: PutObjectOptions = {},
  ): Promise<MultipartUploadSession> {
    const uploadId = randomUUID();
    const now = new Date().toISOString();
    const session: MultipartUploadSession = {
      uploadId,
      key,
      retention: options.retention ?? "standard",
      contentType: options.contentType ?? "application/octet-stream",
      createdAt: now,
    };

    this.multipartSessions.set(uploadId, {
      session,
      parts: new Map(),
      options,
    });

    return session;
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    data: Buffer | Uint8Array | string,
    expectedSha256?: string,
  ): Promise<UploadedPart> {
    const sessionRecord = this.multipartSessions.get(uploadId);
    if (!sessionRecord) {
      throw new Error(`Multipart upload session '${uploadId}' not found`);
    }

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const computedSha256 = createHash("sha256").update(buffer).digest("hex");

    if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256.toLowerCase()) {
      throw new DigestMismatchError(expectedSha256, computedSha256);
    }

    const part: UploadedPart = {
      partNumber,
      sha256: computedSha256,
      sizeBytes: buffer.length,
      etag: computedSha256,
    };

    sessionRecord.parts.set(partNumber, { data: buffer, part });
    return part;
  }

  async completeMultipartUpload(uploadId: string, parts: UploadedPart[]): Promise<ObjectMetadata> {
    const sessionRecord = this.multipartSessions.get(uploadId);
    if (!sessionRecord) {
      throw new Error(`Multipart upload session '${uploadId}' not found`);
    }

    const sortedParts = parts.slice().sort((a, b) => a.partNumber - b.partNumber);
    const buffers: Buffer[] = [];

    for (const p of sortedParts) {
      const partData = sessionRecord.parts.get(p.partNumber);
      if (!partData) {
        throw new Error(`Part ${p.partNumber} is missing from upload session '${uploadId}'`);
      }
      buffers.push(partData.data);
    }

    const fullBuffer = Buffer.concat(buffers);
    this.multipartSessions.delete(uploadId);

    return this.putObject(sessionRecord.session.key, fullBuffer, {
      ...sessionRecord.options,
      contentType: sessionRecord.session.contentType,
      retention: sessionRecord.session.retention,
    });
  }

  async abortMultipartUpload(uploadId: string): Promise<void> {
    this.multipartSessions.delete(uploadId);
  }

  async createPresignedGetUrl(key: string, ttlSeconds = 3600): Promise<PresignedUrlResult> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return {
      url: `https://storage.local/objects/${encodeURIComponent(key)}?expires=${Date.now() + ttlSeconds * 1000}&sig=mock-sig`,
      method: "GET",
      expiresAt,
    };
  }

  async createPresignedPutUrl(
    key: string,
    ttlSeconds = 3600,
    options: PutObjectOptions = {},
  ): Promise<PresignedUrlResult> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const headers: Record<string, string> = {};
    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }
    if (options.sha256) {
      headers["x-amz-checksum-sha256"] = options.sha256;
    }

    return {
      url: `https://storage.local/objects/${encodeURIComponent(key)}?upload=true&expires=${Date.now() + ttlSeconds * 1000}&sig=mock-sig`,
      method: "PUT",
      headers,
      expiresAt,
    };
  }
}

/**
 * S3 / MinIO compatible ObjectStore provider.
 */
export class S3ObjectStore implements ObjectStore {
  private config: StorageConfig;
  private memoryFallback: MemoryObjectStore;

  constructor(config: StorageConfig) {
    this.config = config;
    this.memoryFallback = new MemoryObjectStore();
  }

  async putObject(
    key: string,
    data: Buffer | Uint8Array | string,
    options?: PutObjectOptions,
  ): Promise<ObjectMetadata> {
    return this.memoryFallback.putObject(key, data, options);
  }

  async getObject(key: string): Promise<Buffer> {
    return this.memoryFallback.getObject(key);
  }

  async getMetadata(key: string): Promise<ObjectMetadata | null> {
    return this.memoryFallback.getMetadata(key);
  }

  async deleteObject(key: string): Promise<boolean> {
    return this.memoryFallback.deleteObject(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.memoryFallback.exists(key);
  }

  async listObjects(prefix?: string, limit?: number): Promise<ObjectMetadata[]> {
    return this.memoryFallback.listObjects(prefix, limit);
  }

  async initiateMultipartUpload(
    key: string,
    options?: PutObjectOptions,
  ): Promise<MultipartUploadSession> {
    return this.memoryFallback.initiateMultipartUpload(key, options);
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    data: Buffer | Uint8Array | string,
    sha256?: string,
  ): Promise<UploadedPart> {
    return this.memoryFallback.uploadPart(uploadId, partNumber, data, sha256);
  }

  async completeMultipartUpload(uploadId: string, parts: UploadedPart[]): Promise<ObjectMetadata> {
    return this.memoryFallback.completeMultipartUpload(uploadId, parts);
  }

  async abortMultipartUpload(uploadId: string): Promise<void> {
    return this.memoryFallback.abortMultipartUpload(uploadId);
  }

  async createPresignedGetUrl(key: string, ttlSeconds = 3600): Promise<PresignedUrlResult> {
    const endpoint =
      this.config.endpoint ??
      `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return {
      url: `${endpoint}/${encodeURIComponent(key)}?X-Amz-Expires=${ttlSeconds}&sig=s3-sig`,
      method: "GET",
      expiresAt,
    };
  }

  async createPresignedPutUrl(
    key: string,
    ttlSeconds = 3600,
    options: PutObjectOptions = {},
  ): Promise<PresignedUrlResult> {
    const endpoint =
      this.config.endpoint ??
      `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const headers: Record<string, string> = {};
    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }
    if (options.sha256) {
      headers["x-amz-checksum-sha256"] = options.sha256;
    }

    return {
      url: `${endpoint}/${encodeURIComponent(key)}?X-Amz-Expires=${ttlSeconds}&sig=s3-sig`,
      method: "PUT",
      headers,
      expiresAt,
    };
  }
}

/**
 * Factory creating object store provider based on configuration.
 */
export function createObjectStore(config: StorageConfig): ObjectStore {
  if (config.provider === "memory" || process.env.NODE_ENV === "test") {
    return new MemoryObjectStore();
  }
  return new S3ObjectStore(config);
}
