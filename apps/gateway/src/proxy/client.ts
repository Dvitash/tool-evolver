import {
  type CapabilityEnvelope,
  type ToolArtifact,
  ToolArtifactSchema,
  type ToolManifest,
  ToolManifestSchema,
  hashCanonicalContent,
  normalizeSha256,
} from "@tool-evolver/contracts";
import {
  type CatalogSnapshotRequest,
  type CatalogSnapshotResponse,
  CatalogSnapshotResponseSchema,
  ProtocolError,
  type ProtocolClient,
  ValidationError,
} from "@tool-evolver/protocol";
import { CloudCircuitBreaker } from "./circuit-breaker.js";
import { computeManifestDigest } from "../registry/validator.js";

export interface CloudCatalogClientOptions {
  workspaceId: string;
  deviceId?: string;
  baseUrl?: string;
  authToken?: string;
  protocolClient?: ProtocolClient;
  circuitBreaker?: CloudCircuitBreaker;
  defaultEnvelope?: CapabilityEnvelope;
  fetchFn?: typeof fetch;
  snapshotFetcher?: (request: CatalogSnapshotRequest, signal?: AbortSignal) => Promise<CatalogSnapshotResponse>;
}

export class CloudCatalogClient {
  readonly workspaceId: string;
  readonly deviceId: string;
  private readonly baseUrl?: string;
  private readonly authToken?: string;
  private readonly protocolClient?: ProtocolClient;
  private readonly circuitBreaker: CloudCircuitBreaker;
  private readonly defaultEnvelope?: CapabilityEnvelope;
  private readonly fetchFn: typeof fetch;
  private readonly snapshotFetcher?: (request: CatalogSnapshotRequest, signal?: AbortSignal) => Promise<CatalogSnapshotResponse>;

  constructor(options: CloudCatalogClientOptions) {
    this.workspaceId = options.workspaceId;
    this.deviceId = options.deviceId || `device_${options.workspaceId}`;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.protocolClient = options.protocolClient;
    this.circuitBreaker = options.circuitBreaker ?? new CloudCircuitBreaker();
    this.defaultEnvelope = options.defaultEnvelope;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.snapshotFetcher = options.snapshotFetcher;
  }

  getCircuitBreaker(): CloudCircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Fetches a scoped cloud catalog snapshot, validating schema, canonical checksum, and manifest digests.
   */
  async fetchCatalogSnapshot(options: {
    currentVersion?: string;
    filterScopes?: string[];
    signal?: AbortSignal;
  } = {}): Promise<CatalogSnapshotResponse> {
    // 1. Check circuit breaker state
    if (!this.circuitBreaker.canExecute()) {
      const health = this.circuitBreaker.getHealth();
      throw new ProtocolError(
        "retryable",
        `Cloud catalog service is currently offline/unavailable (circuit state: ${health.circuitState}, status: ${health.status})`,
        { status: 503, details: { health } }
      );
    }

    try {
      // 2. Fetch snapshot from provider
      const request: CatalogSnapshotRequest = {
        workspaceId: this.workspaceId,
        deviceId: this.deviceId,
        currentVersion: options.currentVersion,
        filterScopes: options.filterScopes,
      };

      const rawResponse = await this.executeFetch(request, options.signal);

      // 3. Validate response schema with protocol parser
      const parsed = CatalogSnapshotResponseSchema.safeParse(rawResponse);
      if (!parsed.success) {
        throw new ValidationError("Invalid catalog snapshot response schema from cloud", {
          details: { issues: parsed.error.issues },
        });
      }
      const response = parsed.data;

      // 4. Verify canonical checksum
      const computedChecksum = hashCanonicalContent({
        tools: response.tools,
        activeDeployments: response.activeDeployments,
      });

      if (normalizeSha256(computedChecksum) !== normalizeSha256(response.checksum)) {
        throw new ValidationError("Catalog snapshot checksum mismatch: payload may be tampered or corrupted", {
          details: {
            expected: response.checksum,
            computed: computedChecksum,
          },
        });
      }

      // 5. Validate individual ToolManifests and digests
      for (const tool of response.tools) {
        const manifestResult = ToolManifestSchema.safeParse(tool);
        if (!manifestResult.success) {
          throw new ValidationError(`Invalid tool manifest schema for tool '${tool.id || tool.name}'`, {
            details: { issues: manifestResult.error.issues, toolId: tool.id },
          });
        }

        // Verify manifest digest
        const manifest = manifestResult.data;
        if (manifest.digest) {
          const computedDigest = computeManifestDigest(manifest);
          if (normalizeSha256(manifest.digest) !== normalizeSha256(computedDigest)) {
            throw new ValidationError(`Manifest digest verification failed for tool '${manifest.id}'`, {
              details: { declaredDigest: manifest.digest, computedDigest },
            });
          }
        }
      }

      // 6. Record success in circuit breaker
      this.circuitBreaker.recordSuccess();

      return response;
    } catch (error) {
      // Record failure in circuit breaker
      this.circuitBreaker.recordFailure(error);
      throw error;
    }
  }

  private async executeFetch(
    request: CatalogSnapshotRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    // Path 1: Custom snapshot fetcher
    if (this.snapshotFetcher) {
      return await this.snapshotFetcher(request, signal);
    }

    // Path 2: ProtocolClient instance
    if (this.protocolClient) {
      return this.protocolClient.getCatalogSnapshot(request.currentVersion);
    }

    // Path 3: Direct HTTP REST fetch
    if (this.baseUrl) {
      const url = new URL(`${this.baseUrl}/v1/catalog/snapshot`);
      url.searchParams.set("workspaceId", request.workspaceId);
      url.searchParams.set("deviceId", request.deviceId);
      if (request.currentVersion) {
        url.searchParams.set("currentVersion", request.currentVersion);
      }
      if (request.filterScopes && request.filterScopes.length > 0) {
        url.searchParams.set("filterScopes", request.filterScopes.join(","));
      }

      const headers: Record<string, string> = {
        "Accept": "application/json",
      };
      if (this.authToken) {
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }

      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers,
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let parsedError: Record<string, unknown> | null = null;
        try {
          parsedError = JSON.parse(errorBody);
        } catch {
          // ignore json parse error
        }

        const message =
          (parsedError && typeof parsedError.message === "string" ? parsedError.message : null) ||
          `HTTP error ${response.status}: ${response.statusText}`;

        if (response.status === 401 || response.status === 403) {
          throw new ProtocolError("unauthorized", message, { status: response.status, details: parsedError ?? undefined });
        }
        if (response.status === 426) {
          throw new ProtocolError("upgrade_required", message, { status: 426, details: parsedError ?? undefined });
        }
        if (response.status === 429) {
          throw new ProtocolError("rate_limited", message, { status: 429, details: parsedError ?? undefined });
        }
        if (response.status >= 500) {
          throw new ProtocolError("retryable", message, { status: response.status, details: parsedError ?? undefined });
        }

        throw new ProtocolError("terminal", message, { status: response.status, details: parsedError ?? undefined });
      }

      return await response.json();
    }

    throw new Error("No transport configured for CloudCatalogClient (provide baseUrl, protocolClient, or snapshotFetcher)");
  }
}
