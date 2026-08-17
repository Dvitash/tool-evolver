# Contributing to Tool Evolver

Thank you for contributing to Tool Evolver! Please follow the guidelines below to maintain quality, security, and architectural integrity across the repository.

---

## Development Workflow & Local Verification

Before submitting any pull request or pushing changes, ensure your local workspace passes all required checks.

### Complete Local Verification Gate

Run the master verification command that mirrors the complete CI gate set:

```bash
pnpm run check:all
```

`pnpm run check:all` executes the complete sequence in order:
1. `pnpm run check:adrs` — Architecture Decision Record (ADR) format, sequence, and glossary validation
2. `pnpm run check:boundaries` — Monorepo package boundary and architectural import validation
3. `pnpm run lint` — Biome formatting and code style linting
4. `pnpm run typecheck` — TypeScript strict type checking across all packages and apps
5. `pnpm run build` — Topological build of all workspace packages and apps
6. `pnpm run test` — Unit test suite execution via Vitest
7. `pnpm run test:e2e` — End-to-end integration test execution
8. `pnpm run check:smoke` — Binary entry-point smoke tests for all 4 executable binaries
9. `pnpm run release:verify` — Release artifact, manifest signature, SBOM, and documentation cross-link verification

### Individual Commands

- **Install Dependencies:** `pnpm install --frozen-lockfile`
- **Lint & Format:** `pnpm run lint` / `pnpm run format`
- **Typecheck:** `pnpm run typecheck`
- **Build:** `pnpm run build`
- **Unit Tests:** `pnpm run test`
- **E2E Tests:** `pnpm run test:e2e`
- **Smoke Tests:** `pnpm run check:smoke` (or `pnpm run smoke`)
- **Package Boundaries:** `pnpm run check:boundaries`
- **ADR Check:** `pnpm run check:adrs`
- **Release Verification:** `pnpm run release:verify`
- **Release Test Suite:** `pnpm run release:test`

---

## Pull Request Lifecycle & Governance Policy

### Branch Protection & PR-Only Gate

The `main` branch is strictly protected and enforces PR-only release gates:
- **Direct Pushes Blocked:** Direct commits and pushes to `main` are disabled. All changes must arrive via pull request.
- **Force Pushes Disabled:** Force-pushing to `main` is strictly forbidden.
- **Independent Code Review Required:** Every PR requires at least one approving review from a designated code owner (`.github/CODEOWNERS`). The PR author cannot approve their own pull request.
- **Dismiss Stale Approvals:** Any new commits pushed to an open pull request automatically dismiss previous approvals, requiring re-review.
- **Required Status Checks:** All 10 parallel CI jobs and the rollup `ci-gate` must pass before merging:
  1. `lint` (Biome Lint & Format Check)
  2. `typecheck` (TypeScript Typecheck)
  3. `build` (Monorepo Build)
  4. `test-unit` (Unit Tests)
  5. `test-e2e` (End-to-End Tests)
  6. `check-boundaries` (Package Boundaries Check)
  7. `check-adrs` (ADR Verification)
  8. `release-verification` (Release Artifact Verification)
  9. `binary-smoke` (Binary Smoke Tests)
  10. `secret-scan` (Gitleaks Secret Scanning)
  11. `ci-gate` (Rollup Status Gate)

### PR Template & Checklist

All pull requests must use `.github/pull_request_template.md` and provide:
- Detailed acceptance criteria evidence with verifiable command outputs or test artifacts.
- Local verification commands executed (`pnpm run check:all`).
- Security and privacy impact assessment (cryptography, secrets, capability envelopes, data residency).
- Migration and backward compatibility impact.
- Confirmation that workspace binary entry points build and pass smoke checks.

---

## Code Style & Architectural Boundaries

1. **Package Boundaries:**
   - Packages must strictly communicate through declared exports (e.g. `@tool-evolver/contracts`).
   - Deep imports into internal files (`src/`) of sibling packages are prohibited.
   - All cross-package dependencies must be explicitly declared in `package.json`.
2. **Deterministic Release Packaging:**
   - Release assets, tarballs, and SBOMs must be generated through `scripts/package-release.mjs`.
   - Signatures are verified cryptographically via Ed25519 in `scripts/verify-release.mjs`.
