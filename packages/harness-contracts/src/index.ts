// Core Types & Schemas
export * from "./types.js";

// Harness Adapter Interface
export * from "./adapter.js";

// Session Event Source Interface
export * from "./source.js";

// Configuration Mutation Planning & Atomic Rollback
export * from "./config.js";

// Catalog Refresh Outcomes & Handlers
export * from "./refresh.js";

// Observation Fidelity Descriptors & Presets
export * from "./fidelity.js";

// Error Taxonomy
export * from "./errors.js";

// Fake Adapter & Event Source for Deterministic Testing
export * from "./fake.js";

export const HARNESS_CONTRACTS_VERSION = "0.1.0";
