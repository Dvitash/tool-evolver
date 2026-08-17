# Contributing to Tool Evolver

Thank you for contributing to Tool Evolver! Please follow the guidelines below.

## Development Workflow

1. **Prerequisites**:
   - Node.js >= 22.0.0
   - pnpm 10.24.0 (`corepack enable` or install via `npm i -g pnpm@10.24.0`)

2. **Branching & PRs**:
   - Create feature branches off `main`.
   - Ensure all CI checks pass before requesting review.

3. **Code Style & Formatting**:
   - We use [Biome](https://biomejs.dev/) for fast linting and formatting.
   - Run `pnpm lint` or `pnpm format` to ensure adherence.

4. **Type Safety & TypeScript**:
   - Strict TypeScript is enforced throughout all packages.
   - Run `pnpm typecheck` to verify types across project references.

5. **Package Boundary Rules**:
   - Packages must strictly communicate through declared exports (`@tool-evolver/<pkg>`).
   - Deep imports into internal files of sibling packages are rejected by `pnpm check:boundaries` and CI.
   - All cross-package dependencies must be listed in `package.json`.

6. **Testing**:
   - Write unit tests under `tests/` using [Vitest](https://vitest.dev/).
   - Run `pnpm test` before committing.
