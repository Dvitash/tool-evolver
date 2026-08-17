# Cross-Component Compatibility Matrix (V1.0.0)

This document defines the version compatibility matrix across all internal schemas, wire protocols, harness adapters, and execution runtimes for Tool Evolver V1.0.0.

---

## 1. Schema & Contract Versions

| Component / Package | Package Name | Version | Schema / Contract Spec | Backward Compatibility |
|---------------------|--------------|---------|------------------------|------------------------|
| **Domain Contracts** | `@tool-evolver/contracts` | `0.1.0 / 1.0.0` | Domain Schema v1.0 | Compatible with v0.1.0+ |
| **Wire Protocol** | `@tool-evolver/protocol` | `0.1.0 / 1.0.0` | Protocol Spec v1.0 | Compatible with v0.1.0+ |
| **Harness Contracts**| `@tool-evolver/harness-contracts`| `0.1.0 / 1.0.0` | Harness SPI v1.0 | Compatible with v0.1.0+ |
| **Crypto & Vault** | `@tool-evolver/crypto` | `0.1.0 / 1.0.0` | Crypto Spec v1.0 (Ed25519) | Dual-key verification |
| **Database Schema** | `@tool-evolver/db` | `0.1.0 / 1.0.0` | SQLite Schema v1 / PG 16 | Idempotent migrations |
| **Runtime Engine** | `@tool-evolver/runtime` | `0.1.0 / 1.0.0` | Sandbox Spec v1.0 | Deno 2.x & Node 22+ |

---

## 2. AI Coding Harness Compatibility

| Harness Adapter | Adapter Package | Supported Harness Versions | Protocol Bridge |
|-----------------|-----------------|----------------------------|-----------------|
| **Claude Code CLI** | `@tool-evolver/adapter-claude-code` | Claude Code `>= 0.1.0` | MCP over SSE / Stdio |
| **Codex CLI** | `@tool-evolver/adapter-codex` | Codex CLI `>= 0.0.1` | MCP over SSE |
| **Oh My Pi (OMP)** | `@tool-evolver/adapter-omp` | OMP `>= 0.1.0` | MCP over SSE & Hub IPC |

---

## 3. Host Operating Systems & Node.js Matrix

| Platform | Node.js 22.x LTS | Node.js 24.x | Deno 2.x (Worker) | Support Level |
|----------|------------------|--------------|-------------------|---------------|
| **Linux x86_64** | ✅ Supported | ✅ Supported | ✅ Supported | Tier 1 (CI Verified) |
| **Linux arm64** | ✅ Supported | ✅ Supported | ✅ Supported | Tier 1 (CI Verified) |
| **macOS arm64** (Apple Silicon) | ✅ Supported | ✅ Supported | ✅ Supported | Tier 1 (CI Verified) |
| **macOS x86_64** (Intel) | ✅ Supported | ✅ Supported | ✅ Supported | Tier 1 (CI Verified) |
| **WSL2** (Ubuntu 22.04+) | ✅ Supported | ✅ Supported | ✅ Supported | Tier 1 (CI Verified) |

---

## 4. MCP Protocol & Feature Compatibility

| MCP Feature | Implementation | Supported in V1? | Notes |
|-------------|----------------|------------------|-------|
| `tools/list` | Dynamic Catalog | ✅ Yes | Invariant meta-tools + promoted tools |
| `tools/call` | Sandboxed Invoke | ✅ Yes | Enforces capability envelope |
| `resources/list`| Workspace State | ✅ Yes | Read-only workspace inspection |
| `prompts/list` | Context Prompts | ✅ Yes | Evolution guidance prompts |
| `notifications/tools/list_changed` | Real-time Push | ✅ Yes | Broadcast on tool promotion/rollback |

---

## Related Documentation

- [Release Notes](v1.0.0-release-notes.md)
- [Release Evidence Trace](release-evidence.md)
- [Rollback Procedures](rollback-procedure.md)
- [Support Policy](../security/support-policy.md)
