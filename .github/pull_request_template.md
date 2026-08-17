## Summary & Motivation

<!-- Provide a concise explanation of the change, background context, and link the related issue. -->
Closes #<!-- Issue Number -->

---

## Acceptance Criteria Evidence

<!-- List every acceptance criterion from the issue or specification and provide verifiable proof/output. -->

- [ ] **Criterion 1:** <!-- Description -->
  - *Evidence:* `<!-- Command output / artifact ref / test report -->`
- [ ] **Criterion 2:** <!-- Description -->
  - *Evidence:* `<!-- Command output / artifact ref / test report -->`
- [ ] **Criterion 3:** <!-- Description -->
  - *Evidence:* `<!-- Command output / artifact ref / test report -->`

---

## Test Commands & Local Verification

<!-- Document the exact local commands executed and confirm that all pass with 0 errors. -->

- [ ] Complete CI verification gate executed locally:
  ```bash
  pnpm run check:all
  ```
- [ ] Verification summary:
  - ADR verification: `pnpm run check:adrs` (PASS)
  - Package boundaries: `pnpm run check:boundaries` (PASS)
  - Biome linting: `pnpm run lint` (PASS)
  - TypeScript typecheck: `pnpm run typecheck` (PASS)
  - Monorepo build: `pnpm run build` (PASS)
  - Unit test suite: `pnpm run test` (PASS)
  - E2E integration test suite: `pnpm run test:e2e` (PASS)
  - Binary smoke verification: `pnpm run check:smoke` (PASS)
  - Release artifact & doc verification: `pnpm run release:verify` (PASS)
  - Release test suite: `pnpm run release:test` (PASS)

---

## Security & Privacy Impact

<!-- Check all applicable areas and describe any security or privacy implications. -->

- [ ] **Cryptographic Operations & Signing:** No unauthorized key handling or signature changes.
- [ ] **Secret Management:** No credentials, tokens, or private keys committed (verified by secret scanner).
- [ ] **Privacy & Data Residency:** No unconsented telemetry, PII leakage, or violation of ADR 0005.
- [ ] **Capability Envelope & Sandboxing:** Process boundaries and permission constraints preserved (ADR 0002 / ADR 0007).
- [ ] **Network & IPC Boundaries:** Verified against `docs/architecture/boundaries.md`.

*Notes / Threat Model Considerations:*
<!-- Any specific notes or risk mitigations -->

---

## Migrations & Breaking Changes

- **Database / Schema Migrations:** <!-- None / details -->
- **Protocol / Wire Contract Changes:** <!-- None / details -->
- **Breaking API Changes:** <!-- None / details -->
- **Rollback Compatibility:** <!-- Verified against docs/release/rollback-procedure.md -->

---

## Generated Artifacts & Build Outputs

- [ ] Workspace binary entry points compile and pass smoke checks (`node scripts/verify-binaries.mjs`).
- [ ] Release manifest, SBOM, and checksums updated if release configuration changed.
- [ ] Documentation cross-links valid (0 broken links across `docs/`).

---

## Review & Governance Verification

- [ ] PR targets `main` and is ready for PR-only release gates.
- [ ] Requires at least one independent code owner approval (author cannot self-approve).
- [ ] Stale reviews are dismissed upon pushing new commits.
- [ ] All 10 required status check jobs in `.github/workflows/ci.yml` and `ci-gate` pass.
