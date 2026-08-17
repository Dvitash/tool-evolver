# Tool Evolver

Tool Evolver is an autonomous harness and engineering runtime designed for automated tool evolution, evaluation, and verified adaptation.

## Monorepo Layout

```
tool-evolver/
├── apps/                     # Deployable applications & binaries
│   ├── cli/                  # Developer and automated CLI entrypoint
│   ├── cloud/                # Central cloud coordination service
│   ├── gateway/              # Protocol & execution gateway
│   └── observer/             # Telemetry, monitoring, and audit log observer
├── packages/                 # Core shared libraries and domain packages
│   ├── contracts/            # Core schema, interfaces, and shared types
│   ├── crypto/               # Cryptographic primitives, signatures, hashes
│   ├── db/                   # Database access layer and migrations
│   ├── harness-contracts/    # Harness interface specifications
│   ├── protocol/             # Wire protocol & message formats
│   └── runtime/              # Execution runtime and isolation engine
├── adapters/                 # Harness adapters for external agents
│   ├── claude-code/          # Claude Code harness adapter
│   ├── codex-cli/            # Codex CLI harness adapter
│   └── omp/                  # Oh My Pi (OMP) harness adapter
├── fixtures/                 # Standardized fixtures and integration suites
│   └── test-fixtures/        # Reusable evaluation fixtures & mocks
├── infra/                    # Local development infrastructure (Docker Compose)
└── scripts/                  # Repository maintenance & boundary verification scripts
```

## Prerequisites

- **Node.js**: `>= 22.0.0` (LTS recommended)
- **pnpm**: `>= 10.0.0` (Pinned to `10.24.0` via `packageManager`)

## Getting Started

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Build All Packages

```bash
pnpm build
```

### 3. Run Tests

```bash
pnpm test
```

### 4. Code Quality & Verification

```bash
# Typecheck across the entire workspace
pnpm typecheck

# Lint & format check with Biome
pnpm lint

# Format code
pnpm format

# Verify package import boundaries
pnpm check:boundaries

# Run all verification checks
pnpm check
```

### 5. Local Infrastructure

Start local PostgreSQL, MinIO (S3 compatible), and Valkey (Redis compatible) services:

```bash
docker compose -f infra/docker-compose.yml up -d
```

## Boundary Rules

1. **No direct source imports across package boundaries**: Always import packages through their declared package exports (e.g. `import { ... } from "@tool-evolver/contracts"`). Never use relative paths into another package or reach into internal `src/` directories.
2. **Explicit dependencies**: Any package imported must be declared in the consumer's `package.json`.
3. Run `pnpm check:boundaries` to verify boundary compliance.
