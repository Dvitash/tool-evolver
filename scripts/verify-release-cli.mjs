#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { RELEASE_VERSION } from "./package-release.mjs";
import { verifyRelease } from "./verify-release.mjs";

const rootDir = process.cwd();
const releaseDir = path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);
const allowTestEvidence = process.env.TOOL_EVOLVER_RELEASE_TEST_ONLY === "1";

const result = verifyRelease({
  rootDir,
  releaseDir,
  allowTestEvidence,
});

if (!result.valid) {
  process.exit(1);
}
