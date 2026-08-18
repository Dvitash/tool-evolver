#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadTrustedReleaseKeysFromEnv } from "./release-trust.mjs";

export function embedCliReleaseTrust(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const trusted = loadTrustedReleaseKeysFromEnv(options.env || process.env);
  const records = Object.values(trusted);
  if (records.length !== 1) {
    throw new Error(`Production bootstrap requires exactly one active release trust root, found ${records.length}.`);
  }
  const signingKey = records[0];
  const payload = {
    schemaVersion: "1.0.0",
    trustDomain: "production",
    signingKey,
  };
  const outputPath = path.resolve(rootDir, "apps/cli/dist/release-trust.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { outputPath, signingKey };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = embedCliReleaseTrust();
  console.log(`Embedded production release trust root '${result.signingKey.keyId}' into ${result.outputPath}.`);
}
