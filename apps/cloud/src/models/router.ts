import {
  type CircuitState,
  ModelCapability,
  type ModelPolicy,
  ModelPolicySchema,
  type ModelProvider,
  type ModelTaskClass,
  type RouteSelectionResult,
} from "./types.js";

/**
 * Error thrown when a tenant exceeds their inference rate limit.
 */
export class TenantRateLimitExceededError extends Error {
  public readonly tenantId: string;
  public readonly limit: number;
  public readonly retryAfterSeconds: number;

  constructor(tenantId: string, limit: number, retryAfterSeconds = 60) {
    super(`Rate limit of ${limit} requests/min exceeded for tenant '${tenantId}'`);
    this.name = "TenantRateLimitExceededError";
    this.tenantId = tenantId;
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Error thrown when no available provider can satisfy the request routing criteria.
 */
export class NoAvailableProviderError extends Error {
  public readonly taskClass: ModelTaskClass;
  public readonly reasons: string[];

  constructor(taskClass: ModelTaskClass, reasons: string[] = []) {
    super(`No available provider found for task class '${taskClass}': ${reasons.join("; ")}`);
    this.name = "NoAvailableProviderError";
    this.taskClass = taskClass;
    this.reasons = reasons;
  }
}

/**
 * Internal circuit breaker record for a provider.
 */
interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number;
  lastStateChange: number;
  halfOpenInFlight: boolean;
}

/**
 * Request parameter for route selection.
 */
export interface RouteSelectionRequest {
  tenantId: string;
  taskClass: ModelTaskClass;
  policyOverride?: Partial<ModelPolicy>;
  preferredProviderId?: string;
  preferredModel?: string;
  excludeProviderIds?: string[];
}

/**
 * Model router managing provider routing, capability matching, tenant rate limits,
 * circuit breaking, and multi-provider failover.
 */
export class ModelRouter {
  private providers: Map<string, ModelProvider> = new Map();
  private policies: Map<ModelTaskClass, ModelPolicy> = new Map();
  private circuits: Map<string, CircuitRecord> = new Map();
  private tenantRequestTimestamps: Map<string, number[]> = new Map();

  public readonly failureThreshold: number;
  public readonly circuitCooldownMs: number;

  constructor(
    options: {
      failureThreshold?: number;
      circuitCooldownMs?: number;
    } = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.circuitCooldownMs = options.circuitCooldownMs ?? 30000;
    this.initializeDefaultPolicies();
  }

  /**
   * Registers a model provider.
   */
  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Unregisters a model provider.
   */
  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
    this.circuits.delete(providerId);
  }

  /**
   * Retrieves a registered provider by ID.
   */
  getProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Lists all registered providers.
   */
  listProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Registers or updates a policy for a specific task class.
   */
  registerPolicy(taskClass: ModelTaskClass, policy: ModelPolicy): void {
    this.policies.set(taskClass, policy);
  }

  /**
   * Retrieves the policy for a task class.
   */
  getPolicy(taskClass: ModelTaskClass, override?: Partial<ModelPolicy>): ModelPolicy {
    const basePolicy = this.policies.get(taskClass) ?? this.getDefaultPolicy(taskClass);
    if (!override) {
      return basePolicy;
    }
    return ModelPolicySchema.parse({
      ...basePolicy,
      ...override,
    });
  }

  /**
   * Checks and updates tenant rate limits. Throws TenantRateLimitExceededError if rate limit is reached.
   */
  checkTenantRateLimit(tenantId: string, limitPerMinute: number): void {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    let timestamps = this.tenantRequestTimestamps.get(tenantId);
    if (!timestamps) {
      timestamps = [];
      this.tenantRequestTimestamps.set(tenantId, timestamps);
    }

    // Filter timestamps within the sliding window
    const validTimestamps = timestamps.filter((t) => t > oneMinuteAgo);
    this.tenantRequestTimestamps.set(tenantId, validTimestamps);

    if (validTimestamps.length >= limitPerMinute) {
      const oldestInWindow = validTimestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + 60000 - now) / 1000);
      throw new TenantRateLimitExceededError(tenantId, limitPerMinute, Math.max(1, retryAfter));
    }

    validTimestamps.push(now);
  }

  /**
   * Retrieves the current circuit breaker state for a provider.
   */
  getCircuitState(providerId: string): CircuitState {
    const circuit = this.circuits.get(providerId);
    if (!circuit) {
      return "CLOSED";
    }

    if (circuit.state === "OPEN") {
      const elapsed = Date.now() - circuit.lastFailureTime;
      if (elapsed >= this.circuitCooldownMs) {
        circuit.state = "HALF_OPEN";
        circuit.lastStateChange = Date.now();
        circuit.halfOpenInFlight = false;
      }
    }

    return circuit.state;
  }

  /**
   * Records a successful execution for a provider, resetting failure counts and closing circuits.
   */
  recordSuccess(providerId: string): void {
    const circuit = this.circuits.get(providerId);
    if (circuit) {
      circuit.consecutiveFailures = 0;
      circuit.state = "CLOSED";
      circuit.lastStateChange = Date.now();
      circuit.halfOpenInFlight = false;
    }
  }

  /**
   * Records an execution failure for a provider, incrementing failure count and tripping circuit if threshold exceeded.
   */
  recordFailure(providerId: string): void {
    let circuit = this.circuits.get(providerId);
    if (!circuit) {
      circuit = {
        state: "CLOSED",
        consecutiveFailures: 0,
        lastFailureTime: Date.now(),
        lastStateChange: Date.now(),
        halfOpenInFlight: false,
      };
      this.circuits.set(providerId, circuit);
    }

    circuit.consecutiveFailures++;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === "HALF_OPEN" || circuit.consecutiveFailures >= this.failureThreshold) {
      circuit.state = "OPEN";
      circuit.lastStateChange = Date.now();
      circuit.halfOpenInFlight = false;
    }
  }

  /**
   * Resets all circuit breakers to CLOSED.
   */
  resetCircuits(): void {
    this.circuits.clear();
  }

  /**
   * Selects the optimal provider route for an inference request based on policy, priority, capabilities, and circuit health.
   */
  selectRoute(request: RouteSelectionRequest): RouteSelectionResult {
    const policy = this.getPolicy(request.taskClass, request.policyOverride);
    const candidates = this.getCandidateRoutes(request, policy);

    if (candidates.length === 0) {
      throw new NoAvailableProviderError(request.taskClass, [
        `No registered provider matches taskClass '${request.taskClass}' with healthy circuits`,
      ]);
    }

    return candidates[0];
  }

  /**
   * Returns ordered fallback routes excluding already failed providers.
   */
  getFallbackRoutes(
    request: RouteSelectionRequest,
    failedProviderId?: string,
  ): RouteSelectionResult[] {
    const policy = this.getPolicy(request.taskClass, request.policyOverride);
    const excludeIds = new Set(request.excludeProviderIds ?? []);
    if (failedProviderId) {
      excludeIds.add(failedProviderId);
    }

    return this.getCandidateRoutes(
      { ...request, excludeProviderIds: Array.from(excludeIds) },
      policy,
    );
  }

  /**
   * Resolves ranked candidate routes according to priority, capabilities, and circuit state.
   */
  private getCandidateRoutes(
    request: RouteSelectionRequest,
    policy: ModelPolicy,
  ): RouteSelectionResult[] {
    const excludeIds = new Set(request.excludeProviderIds ?? []);
    const availableProviders = Array.from(this.providers.values()).filter(
      (p) => !excludeIds.has(p.id),
    );

    const scoredCandidates: Array<{
      route: RouteSelectionResult;
      score: number;
    }> = [];

    for (const provider of availableProviders) {
      // Check circuit breaker status
      const circuitState = this.getCircuitState(provider.id);
      if (circuitState === "OPEN") {
        continue;
      }

      // Check task class support
      if (!provider.supportsTaskClass(request.taskClass)) {
        continue;
      }

      const capability = provider.getCapability();
      if (!capability) {
        continue;
      }

      // Check privacy level matching
      if (!policy.allowedPrivacyLevels.includes(capability.privacyLevel)) {
        continue;
      }

      const model = request.preferredModel ?? capability.name;

      // Check disallowed models
      if (policy.disallowedModels.includes(model)) {
        continue;
      }

      let score = 100;

      // Preferred provider boost
      if (request.preferredProviderId === provider.id) {
        score += 500;
      }

      // Policy priority provider bonus
      const priorityIndex = policy.priorityProviders.indexOf(provider.id);
      if (priorityIndex !== -1) {
        score += 100 - priorityIndex * 10;
      }

      // Half-open circuit penalty (prefer fully closed)
      if (circuitState === "HALF_OPEN") {
        score -= 50;
      }

      scoredCandidates.push({
        route: {
          providerId: provider.id,
          provider,
          model,
          policy,
        },
        score,
      });
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    return scoredCandidates.map((c) => c.route);
  }

  private getDefaultPolicy(taskClass: ModelTaskClass): ModelPolicy {
    return {
      taskClass,
      allowedPrivacyLevels: ["cloud_sanitized", "cloud_private", "local", "airgapped"],
      defaultTemperature: 0.2,
      maxTemperature: 1.0,
      maxTokens: 4096,
      priorityProviders: [],
      disallowedModels: [],
      cacheTtlSeconds: 3600,
      rateLimitPerMinute: 60,
      redactionStrictness: "strict",
      allowRawTranscripts: false,
    };
  }

  private initializeDefaultPolicies(): void {
    const taskClasses: ModelTaskClass[] = [
      "opportunity_detection",
      "candidate_planning",
      "tool_synthesis",
      "test_generation",
      "candidate_scoring",
    ];

    for (const tc of taskClasses) {
      this.policies.set(tc, this.getDefaultPolicy(tc));
    }
  }
}
