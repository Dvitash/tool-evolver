import { hashCanonical } from "@tool-evolver/contracts";
import type { InferenceProvenance } from "./types.js";

/**
 * Cached inference entry payload.
 */
export interface CachedInferenceEntry<T = unknown> {
  key: string;
  tenantId: string;
  output: T;
  rawOutput?: string;
  provenance: InferenceProvenance;
  createdAt: number;
  expiresAt: number;
}

/**
 * Parameters used to compute a deterministic cache key.
 */
export interface CacheKeyParams {
  tenantId: string;
  providerId: string;
  model: string;
  templateId: string;
  templateVersion: string;
  inputDigest: string;
  schemaDigest: string;
}

/**
 * Cache metrics and telemetry.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

/**
 * Computes a deterministic SHA-256 cache key including tenant isolation.
 */
export function computeInferenceCacheKey(params: CacheKeyParams): string {
  return hashCanonical({
    tenantId: params.tenantId,
    providerId: params.providerId,
    model: params.model,
    templateId: params.templateId,
    templateVersion: params.templateVersion,
    inputDigest: params.inputDigest,
    schemaDigest: params.schemaDigest,
  });
}

/**
 * Deterministic inference response cache with strict tenant isolation.
 */
export class InferenceCache {
  private entries: Map<string, CachedInferenceEntry<unknown>> = new Map();
  private maxEntries: number;
  private defaultTtlSeconds: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    options: {
      maxEntries?: number;
      defaultTtlSeconds?: number;
    } = {},
  ) {
    this.maxEntries = options.maxEntries ?? 5000;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 3600;
  }

  /**
   * Retrieves a cached response, strictly enforcing tenant isolation and TTL.
   */
  async get<T = unknown>(key: string, tenantId: string): Promise<CachedInferenceEntry<T> | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Tenant isolation check
    if (entry.tenantId !== tenantId) {
      this.misses++;
      return null;
    }

    // Expiration check
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry as CachedInferenceEntry<T>;
  }

  /**
   * Caches an inference response for a tenant.
   */
  async set<T = unknown>(
    key: string,
    tenantId: string,
    entry: {
      output: T;
      rawOutput?: string;
      provenance: InferenceProvenance;
    },
    ttlSeconds?: number,
  ): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    const now = Date.now();

    // Evict oldest if capacity reached
    if (this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }

    const cachedEntry: CachedInferenceEntry<unknown> = {
      key,
      tenantId,
      output: entry.output,
      rawOutput: entry.rawOutput,
      provenance: {
        ...entry.provenance,
        cached: true,
        cacheKey: key,
      },
      createdAt: now,
      expiresAt: now + ttl * 1000,
    };

    this.entries.set(key, cachedEntry);
  }

  /**
   * Invalidates a specific cache key.
   */
  async invalidateKey(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  /**
   * Invalidates all cache entries belonging to a tenant.
   */
  async invalidateTenant(tenantId: string): Promise<number> {
    let count = 0;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.tenantId === tenantId) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clears the entire cache.
   */
  async clear(): Promise<void> {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Returns current cache statistics.
   */
  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.entries.size,
      evictions: this.evictions,
    };
  }

  private evictOldest(): void {
    const firstKey = this.entries.keys().next().value;
    if (firstKey) {
      this.entries.delete(firstKey);
      this.evictions++;
    }
  }
}
