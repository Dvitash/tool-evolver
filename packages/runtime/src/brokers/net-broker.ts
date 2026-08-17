import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { NetCapability } from "@tool-evolver/contracts";
import {
  canonicalizeHost,
  isPrivateOrReservedIp,
  matchesHostPattern,
} from "../policy/canonicalizers.js";
import { withResolvers } from "../worker/protocol.js";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";

/**
 * Standard parameters for brokered network requests.
 */
export interface NetRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  redirect?: "follow" | "error" | "manual";
  maxRedirects?: number;
}

/**
 * Standard response result for brokered network requests.
 */
export interface NetResponseResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
  redirected: boolean;
  bytesReceived: number;
}

/**
 * Capability broker for outbound network operations.
 * Enforces allowed protocols, ports, domain/host allowlists, private/loopback IP blocking,
 * DNS pre-resolution against rebinding, redirect containment, and response size limits.
 */
export class NetworkBroker extends BaseCapabilityBroker {
  readonly serviceName = "net" as const;

  constructor(options: BaseCapabilityBrokerOptions = {}) {
    super(options);
  }

  /**
   * Validates a target URL against the granted network capability and resolves DNS to detect private IP ranges.
   */
  private async validateAndAuthorizeUrl(targetUrl: string, netCap: NetCapability): Promise<URL> {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new BrokerSecurityError("INVALID_PATH", `Invalid URL format: ${targetUrl}`);
    }

    // 1. Protocol check
    const protocol = parsed.protocol.replace(":", "").toLowerCase();
    const allowedProtocols = netCap.allowedProtocols ?? ["https"];
    if (!allowedProtocols.includes(protocol as "http" | "https" | "ws" | "wss")) {
      throw new BrokerSecurityError(
        "DISALLOWED_PROTOCOL",
        `Protocol '${protocol}' is not permitted by capability policy (allowed: ${allowedProtocols.join(", ")})`,
        { url: targetUrl, protocol, allowedProtocols },
      );
    }

    // 2. Port check
    const defaultPort = protocol === "https" || protocol === "wss" ? 443 : 80;
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;
    const allowedPorts = netCap.allowedPorts ?? [];
    if (allowedPorts.length > 0 && !allowedPorts.includes(port)) {
      throw new BrokerSecurityError(
        "DISALLOWED_PORT",
        `Port ${port} is not permitted by capability policy`,
        { url: targetUrl, port, allowedPorts },
      );
    }

    // 3. Host / Domain matching
    const rawHostname = parsed.hostname;
    const normHostname = canonicalizeHost(rawHostname);

    const allowedDomains = netCap.allowedDomains ?? [];
    const allowedHosts = netCap.allowedHosts ?? [];
    const hasExplicitAllowlist = allowedDomains.length > 0 || allowedHosts.length > 0;

    if (hasExplicitAllowlist) {
      let isHostAllowed = false;

      for (const hostPattern of allowedHosts) {
        if (normHostname === canonicalizeHost(hostPattern)) {
          isHostAllowed = true;
          break;
        }
      }

      if (!isHostAllowed) {
        for (const domainPattern of allowedDomains) {
          if (matchesHostPattern(normHostname, domainPattern)) {
            isHostAllowed = true;
            break;
          }
        }
      }

      if (!isHostAllowed) {
        throw new BrokerSecurityError(
          "DISALLOWED_HOST",
          `Host '${rawHostname}' is not in allowed domains/hosts list`,
          { host: rawHostname, allowedDomains, allowedHosts },
        );
      }
    } else if (!netCap.allowOutbound) {
      throw new BrokerSecurityError(
        "OUTBOUND_NETWORK_DISABLED",
        "Outbound network access is disabled by capability policy",
        { url: targetUrl },
      );
    }

    // 4. Localhost check
    const isLoopbackHost = (h: string): boolean => {
      return (
        h === "localhost" ||
        h.endsWith(".localhost") ||
        h === "127.0.0.1" ||
        h.startsWith("127.") ||
        h === "::1" ||
        h === "0.0.0.0" ||
        h === "0" ||
        h === "[::1]" ||
        h === "::ffff:127.0.0.1"
      );
    };

    if (!netCap.allowLocalhost) {
      if (isLoopbackHost(normHostname)) {
        throw new BrokerSecurityError(
          "BLOCKED_IP_RANGE",
          `Access to localhost is denied: ${rawHostname}`,
          { host: rawHostname },
        );
      }
    }

    // 5. Private / Reserved IP Range and DNS Rebinding Defense
    const denyPrivate = netCap.denyPrivateRanges ?? true;
    if (denyPrivate) {
      const isBlocked = (ip: string) => {
        if (netCap.allowLocalhost && isLoopbackHost(ip)) {
          return false;
        }
        return isPrivateOrReservedIp(ip);
      };

      // Direct IP check
      if (isBlocked(normHostname)) {
        throw new BrokerSecurityError(
          "BLOCKED_IP_RANGE",
          `Access to private, loopback, link-local, or cloud metadata IP is denied: ${rawHostname}`,
          { host: rawHostname },
        );
      }

      // DNS Resolution check (prevent DNS rebinding)
      try {
        const addresses = await dns.promises.lookup(normHostname, { all: true });
        for (const addr of addresses) {
          if (isBlocked(addr.address)) {
            throw new BrokerSecurityError(
              "BLOCKED_IP_RANGE",
              `DNS resolution for host '${rawHostname}' resolved to private/reserved IP '${addr.address}'`,
              { host: rawHostname, resolvedIp: addr.address },
            );
          }
        }
      } catch (dnsErr) {
        if (dnsErr instanceof BrokerSecurityError) throw dnsErr;
        // If hostname fails to resolve and is not an IP, reject as DNS failure
        throw new BrokerSecurityError(
          "DNS_RESOLUTION_FAILED",
          `Failed to resolve DNS for host '${rawHostname}': ${(dnsErr as Error).message}`,
          { host: rawHostname },
        );
      }
    }

    return parsed;
  }

  /**
   * Executes a brokered network request with redirect validation, size limits, and timeout enforcement.
   */
  async request(params: NetRequestParams, context: BrokerContext): Promise<NetResponseResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const netCap = grant.capabilities.net ?? {};
    const limits = grant.capabilities.limits;

    const method = (params.method ?? "GET").toUpperCase();
    const redirectMode = params.redirect ?? "follow";
    const maxRedirects = params.maxRedirects ?? 5;
    const maxResponseBytes = limits?.maxOutputSizeBytes ?? 10485760; // 10MB default
    const timeoutMs = Math.min(
      params.timeoutMs ?? limits?.maxExecutionTimeMs ?? 30000,
      limits?.maxExecutionTimeMs ?? 30000,
    );

    let currentUrl = params.url;
    let redirectCount = 0;
    let redirected = false;

    while (true) {
      try {
        const parsedUrl = await this.validateAndAuthorizeUrl(currentUrl, netCap);

        const response = await this.executeHttpRequest({
          url: parsedUrl,
          method,
          headers: params.headers ?? {},
          body: params.body,
          timeoutMs,
          maxResponseBytes,
        });

        // Track response bytes against output limits
        this.trackOutputBytes(context.invocationId, response.bytesReceived, limits);

        // Check for redirects (301, 302, 303, 307, 308)
        const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
        const locationHeader = response.headers.location;

        if (isRedirect && locationHeader && redirectMode === "follow") {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new BrokerSecurityError(
              "MAX_REDIRECTS_EXCEEDED",
              `Maximum redirect limit of ${maxRedirects} exceeded`,
              { redirectCount, maxRedirects },
            );
          }

          // Resolve relative redirect URL
          const nextUrl = new URL(locationHeader, currentUrl).toString();

          // Validate next URL
          await this.validateAndAuthorizeUrl(nextUrl, netCap);

          currentUrl = nextUrl;
          redirected = true;
          continue; // Follow redirect
        }
        if (isRedirect && redirectMode === "error") {
          throw new BrokerSecurityError(
            "DISALLOWED_REDIRECT",
            `Redirect encountered with redirectMode='error': ${locationHeader}`,
            { status: response.status, location: locationHeader },
          );
        }

        this.recordAudit(
          "request",
          context,
          "allowed",
          {
            url: currentUrl,
            method,
            status: response.status,
            bytesReceived: response.bytesReceived,
            redirected,
          },
          { durationMs: Date.now() - startTime },
        );

        return {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: response.body,
          url: currentUrl,
          redirected,
          bytesReceived: response.bytesReceived,
        };
      } catch (error) {
        const err =
          error instanceof BrokerSecurityError
            ? error
            : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);

        this.recordAudit(
          "request",
          context,
          "denied",
          {
            url: currentUrl,
            method,
          },
          {
            error: { code: err.code, message: err.message },
            durationMs: Date.now() - startTime,
          },
        );

        throw err;
      }
    }
  }

  /**
   * Low-level HTTP/HTTPS execution helper with timeout and response size bounds.
   */
  private executeHttpRequest(options: {
    url: URL;
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytesReceived: number;
  }> {
    const { promise, resolve, reject } = withResolvers<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      bytesReceived: number;
    }>();

    const isHttps = options.url.protocol === "https:";
    const transport = isHttps ? https : http;

    const reqHeaders: Record<string, string> = { ...options.headers };
    if (options.body && !reqHeaders["content-length"] && !reqHeaders["Content-Length"]) {
      reqHeaders["Content-Length"] = String(Buffer.byteLength(options.body));
    }

    const req = transport.request(
      options.url,
      {
        method: options.method,
        headers: reqHeaders,
        timeout: options.timeoutMs,
        rejectUnauthorized: true, // Strict TLS
      },
      (res) => {
        let bytesReceived = 0;
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => {
          bytesReceived += chunk.length;
          if (bytesReceived > options.maxResponseBytes) {
            req.destroy();
            reject(
              new BrokerSecurityError(
                "RESPONSE_TOO_LARGE",
                `Response payload size ${bytesReceived} bytes exceeded limit ${options.maxResponseBytes} bytes`,
                { bytesReceived, maxBytes: options.maxResponseBytes },
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          const bodyBuffer = Buffer.concat(chunks);
          const bodyText = bodyBuffer.toString("utf-8");

          const normalizedHeaders: Record<string, string> = {};
          for (const [key, val] of Object.entries(res.headers)) {
            if (val !== undefined) {
              normalizedHeaders[key.toLowerCase()] = Array.isArray(val)
                ? val.join(", ")
                : String(val);
            }
          }

          resolve({
            status: res.statusCode ?? 200,
            statusText: res.statusMessage ?? "OK",
            headers: normalizedHeaders,
            body: bodyText,
            bytesReceived,
          });
        });

        res.on("error", (err) => {
          reject(
            new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              `Response stream error: ${err.message}`,
            ),
          );
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(
        new BrokerSecurityError(
          "REQUEST_TIMEOUT",
          `Network request timed out after ${options.timeoutMs}ms`,
          { timeoutMs: options.timeoutMs },
        ),
      );
    });

    req.on("error", (err) => {
      if (
        err.message.includes("CERT_") ||
        err.message.includes("certificate") ||
        err.message.includes("TLS")
      ) {
        reject(new BrokerSecurityError("TLS_ERROR", `TLS verification failed: ${err.message}`));
      } else {
        reject(
          new BrokerSecurityError("OPERATION_NOT_PERMITTED", `Request failed: ${err.message}`),
        );
      }
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();

    return promise;
  }

  /**
   * Fetch-compatible interface for convenience.
   */
  async fetch(
    url: string,
    init: Partial<NetRequestParams>,
    context: BrokerContext,
  ): Promise<NetResponseResult> {
    return this.request({ ...init, url }, context);
  }
}
