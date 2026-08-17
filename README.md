# Tool Evolver

Tool Evolver is an autonomous harness and engineering runtime designed for automated tool evolution, evaluation, and verified adaptation.

## Monorepo Layout

```
tool-evolver/
├── apps/                     # Deployable applications & binaries
│   ├── cli/                  # Developer and automated CLI entrypoint (`tool-evolver`)
│   ├── cloud/                # Central cloud coordination service
│   ├── gateway/              # Protocol & execution gateway (`tool-evolver-mcp`)
│   └── observer/             # Telemetry, monitoring, and audit daemon (`tool-evolver-daemon`)
├── packages/                 # Core shared libraries and domain packages
│   ├── contracts/            # Core schema, interfaces, and validation rules
│   ├── crypto/               # Cryptographic primitives, vault, and credential management
│   ├── db/                   # Database client, migrations, and repositories
│   ├── harness-contracts/    # Harness interfaces and adapter specifications
│   ├── protocol/             # Wire protocol schemas and framing
│   └── runtime/              # Sandboxed execution runtime and engine
├── adapters/                 # AI coding harness integration adapters
│   ├── claude-code/          # Claude Code integration adapter
│   ├── codex-cli/            # Codex CLI integration adapter
│   └── omp/                  # OMP (Oh My Pi) harness adapter
├── fixtures/                 # Conformance test suites and mock data
│   ├── e2e/                  # End-to-end integration and smoke tests
│   └── test-fixtures/        # Conformance fixtures and CLI (`tool-evolver-conformance`)
├── docs/                     # Canonical documentation and architecture decision records
└── scripts/                  # Packaging, verification, and boundary check tooling
```

## Quick Start

### 1. Install Dependencies

```bash
pnpm install --frozen-lockfile
```

### 2. Build Monorepo

```bash
pnpm build
```

### 3. Run Tests

```bash
# Run all unit tests
pnpm test

# Run end-to-end integration tests
pnpm test:e2e

# Run binary smoke verification across all 4 entry points
pnpm check:smoke
```

### 4. Complete Verification & Quality Gates

Run the comprehensive local verification gate that mirrors all CI checks:

```bash
pnpm run check:all
```

`pnpm run check:all` executes the complete release verification sequence:
1. `pnpm run check:adrs` — ADR structure, sequence, and canonical glossary term validation
2. `pnpm run check:boundaries` — Package boundary and dependency graph validation
3. `pnpm run check:secrets` — Standalone secret scanning for private keys, tokens, credentials, and canary leaks
4. `pnpm run lint` — Biome formatting and linter validation
5. `pnpm run typecheck` — TypeScript strict type validation
6. `pnpm run build` — Topological build across all workspace packages
7. `pnpm run test` — Unit test suite execution
8. `pnpm run release:test` — Unit & integrity tests for release packaging and Ed25519 verification
9. `pnpm run test:e2e` — End-to-end test execution
10. `pnpm run check:smoke` — Binary smoke execution for CLI, Daemon, Gateway MCP, and Conformance Runner
11. `pnpm run release:verify` — Release tarballs, SHA-256 digests, Ed25519 signatures, SBOM, and docs cross-links

### 5. Local Infrastructure

Start local PostgreSQL, MinIO (S3 compatible), and Valkey (Redis compatible) services:

```bash
docker compose -f infra/docker-compose.yml up -d
```

## Binary Entry Points

Tool Evolver builds and packages 4 primary binary entry points:
- `@tool-evolver/cli` (`apps/cli/dist/bin/cli.js` -> `tool-evolver`)
- `@tool-evolver/observer` (`apps/observer/dist/bin/daemon.js` -> `tool-evolver-daemon`)
- `@tool-evolver/gateway` (`apps/gateway/dist/bin/mcp-shim.js` -> `tool-evolver-mcp`)
- `@tool-evolver/test-fixtures` (`fixtures/test-fixtures/dist/cli.js` -> `tool-evolver-conformance`)

Run `pnpm run check:smoke` to verify binary existence, manifest declarations, node shebang headers, and `--help` CLI smoke execution.

## Boundary Rules

1. **No direct source imports across package boundaries**: Always import packages through their declared package exports (e.g. `import { ... } from "@tool-evolver/contracts"`). Never use relative paths into another package or reach into internal `src/` directories.
2. **Explicit dependencies**: Any package imported must be declared in the consumer's `package.json`.
3. Run `pnpm check:boundaries` to verify boundary compliance.

## Governance & Release Gates

- **PR-Only Gate**: All modifications must land via pull request targeting `main`. Direct pushes and force-pushes to `main` are blocked.
- **Automated Branch Protection**: Run `./scripts/configure-branch-protection.sh` to configure strict branch protection rules via GitHub API / gh CLI.
- **Independent Code Review**: Every pull request requires review and approval from designated code owners (`.github/CODEOWNERS`). Self-approvals are prohibited.
- **Stale Approval Dismissal**: Pushing new commits to an open PR invalidates prior approvals.
- **Required CI Status Checks**: All 10 parallel CI jobs (`lint`, `typecheck`, `build`, `test-unit`, `test-e2e`, `check-boundaries`, `check-adrs`, `release-verification`, `binary-smoke`, `secret-scan`) and the rollup `ci-gate` must pass before merge.
