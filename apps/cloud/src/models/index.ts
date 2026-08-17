import { InferenceService, InferenceServiceOptions } from "./service.js";

// Core Types & Schemas
export * from "./types.js";

// Providers
export * from "./provider.js";

// Prompt Registry & Templates
export * from "./prompt-registry.js";

// Structured Output Validator & Repair
export * from "./validator.js";

// Model Routing & Policies
export * from "./router.js";

// Cache & Tenant Isolation
export * from "./cache.js";

// Privacy Gate & Redaction
export * from "./privacy-gate.js";

// Inference Service Orchestrator
export * from "./service.js";

/**
 * Factory function creating an InferenceService instance.
 */
export function createInferenceService(options: InferenceServiceOptions = {}): InferenceService {
  return new InferenceService(options);
}
