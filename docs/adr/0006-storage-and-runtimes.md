# ADR 0006: Storage Systems and Runtime Technology Stack

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Tool Evolver Core Architecture Team
- **Consulted**: Database Infrastructure, Backend Platform, Runtime Engineering

## Context and Problem Statement

Tool Evolver operates across two distinct environments: the developer's local workstation (which requires instant startup, zero external dependencies, low memory footprint, and bulletproof offline reliability) and the cloud evolution plane (which requires multi-tenant scalability, transactional integrity, blob storage for immutable tool bundles, and asynchronous queue processing).

Selecting the appropriate language runtimes, embedded databases, cloud datastores, and message queuing systems is critical for developer velocity, operational simplicity, and long-term maintainability.

## Decision Drivers

- **Zero Local Setup**: Local developer machines must not require installing or managing external database servers (e.g., no local Postgres/MySQL requirement).
- **Crash Durability**: Local state must survive abrupt power losses, daemon panics, or OS reboots without data corruption.
- **Type Safety End-to-End**: A unified language ecosystem (TypeScript) across local daemon, adapters, contracts, and cloud control plane services.
- **Scalable Cloud Storage**: Cloud infrastructure must handle high-throughput telemetry ingestion, multi-tenant relational queries, immutable artifact hosting, and decoupled background worker queues.

## Considered Options

1. **Option 1: JSON Flat Files Locally + MongoDB in Cloud**
   - *Pros*: Schema flexibility.
   - *Cons*: High risk of file corruption on unexpected power loss locally; lack of ACID transactions; poor query performance on large observation histories.

2. **Option 2: Embedded RocksDB/LevelDB Locally + Cassandra in Cloud**
   - *Pros*: High write throughput.
   - *Cons*: Key-value only, lacks relational querying for complex tool lifecycle queries, complex C++ native bindings prone to build failures.

3. **Option 3: SQLite (WAL mode) Locally + Node.js/TypeScript Control Plane + Postgres/S3/Queue in Cloud + Pinned Deno Sandbox (Selected)**
   - *Pros*: Proven reliability of SQLite; WAL mode provides concurrent read/write performance; pure TypeScript codebase; PostgreSQL provides robust relational guarantees; S3 provides infinite immutable blob storage; Deno provides sandboxed tool execution.
   - *Cons*: Must manage schema migrations across both SQLite and PostgreSQL.

## Decision

We decide on the following storage and runtime technology stack for V1:

### 1. Control Plane & Runtimes

- **Local Daemon & Gateway**: TypeScript on **Node.js (>=22 LTS)**. Node.js provides mature ecosystem support for MCP stdio/HTTP transports, process supervision, and native filesystem operations.
- **Tool Sandbox Execution**: **Pinned Deno runtime** (managed and pinned to a specific version). Used strictly for executing isolated tool bundles with fine-grained sandbox permissions.
- **Cloud Backend Services**: TypeScript on **Node.js (>=22 LTS)** with fastify/express for HTTP/gRPC APIs.

### 2. Local Persistence: Embedded SQLite with WAL

- **Engine**: SQLite via `@tool-evolver/db` (using native `better-sqlite3` or Node 22 built-in `node:sqlite`).
- **Configuration & PRAGMAs**:
  - `journal_mode = WAL` (Write-Ahead Logging for non-blocking concurrent reads during writes).
  - `synchronous = NORMAL` (optimal balance of crash durability and write latency).
  - `foreign_keys = ON` (referential integrity enforcement).
  - `busy_timeout = 5000` (handles transient file locks gracefully).
- **Local Data Model**:
  - `workspaces`: Registered workspace paths, configurations, and capability envelopes.
  - `tool_registry`: Local active tool specs, version tags, and activation statuses.
  - `tool_candidates`: Candidate versions under synthesis or canary evaluation.
  - `observations`: Local conversation traces and sanitized telemetry records.
  - `audit_events`: Tamper-evident cryptographic audit logs.

### 3. Cloud Persistence & Infrastructure

- **Relational Store (PostgreSQL >= 16)**: Multi-tenant metadata, user/team accounts, global tool catalogs, authorization policies, and aggregation metrics.
- **Object / Blob Storage (S3-Compatible)**: Immutable storage for tool bundle tarballs, compiled AST snapshots, candidate test fixtures, and benchmark datasets.
- **Asynchronous Task Queue (Redis / BullMQ / SQS)**: Decoupled background processing for tool synthesis jobs, LLM inference pipelines, multi-version benchmark matrices, and telemetry aggregation.

```
+---------------------------------------------------------------+
| Local Workstation Storage Architecture                        |
|                                                               |
|  +----------------------------------------------------------+ |
|  | Local Node.js Control Plane (@tool-evolver/db)           | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|                              v (WAL Mode, synchronous=NORMAL) |
|  +----------------------------------------------------------+ |
|  | Embedded SQLite Database (~/.tool-evolver/state.db)      | |
|  | - tool_registry       - observations                     | |
|  | - tool_candidates     - audit_events                     | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
| Cloud Infrastructure Storage Architecture                     |
|                                                               |
|  +---------------------+  +-----------------+  +------------+ |
|  | PostgreSQL (>=16)   |  | S3-Compatible   |  | Queue /    | |
|  | Relational Metadata |  | Immutable Tools |  | Task Bus   | |
|  | Multi-Tenant Tables |  | Tarball Bundles |  | BullMQ/SQS | |
|  +---------------------+  +-----------------+  +------------+ |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- Zero external daemon dependencies on the developer's local machine; installation is self-contained.
- Embedded SQLite with WAL mode delivers microsecond query latencies for local tool resolution.
- Standardized TypeScript across the entire monorepo maximizes code reuse between `@tool-evolver/contracts`, `@tool-evolver/protocol`, local daemon, and cloud services.
- S3 + PostgreSQL in the cloud provides industry-standard scalability, backup, and disaster recovery.

### Negative / Trade-offs
- Maintaining two database dialects (SQLite locally and PostgreSQL in cloud) requires careful ORM/migration abstraction.

### Mitigations
- Use shared schema definition patterns and strict contract validation packages (`@tool-evolver/contracts`) to prevent schema divergence.
- Automated CI integration tests run against both in-memory SQLite and PostgreSQL test instances.

## Compliance and Verification

- Monorepo package checks ensure `@tool-evolver/db` is the sole provider of local database access.
- SQLite migration tests verify schema upgrades and downgrades execute with zero data loss.
