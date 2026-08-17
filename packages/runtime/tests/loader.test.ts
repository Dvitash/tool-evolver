import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { buildToolBundle } from "../src/bundle/builder.js";
import { generateBundleKeyPair, InMemoryKeyStore } from "../src/bundle/signature.js";
import { ArtifactCache } from "../src/loader/cache.js";
import {
  BundleSignatureError,
  BundleValidationError,
  ToolBundleLoader,
} from "../src/loader/loader.js";
import { QuarantineManager } from "../src/loader/quarantine.js";
import { BundleSecurityError } from "../src/loader/security-checks.js";

const validManifest: ToolManifest = {
  id: "test-tool-loader",
  name: "loader-tool",
  version: "1.0.0",
  description: "A tool bundle to test loader functionality",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  runtime: {
    runtime: "deno",
    memoryLimitMb: 128,
    timeoutMs: 10000,
    cpuLimitPercent: 100,
    maxOutputSizeBytes: 1048576,
  },
  capabilities: {
    version: "1.0.0",
    description: "Loader test tool capabilities",
    fs: { read: ["."], write: [] },
    net: { allowedHosts: [], allowDns: false },
    exec: { allowedCommands: [], allowPipes: false },
    harness: { allowRegistration: false, allowTelemetry: false },
  },
  limits: {
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
    maxMemoryBytes: 134217728,
    maxConcurrentInvocations: 1,
  },
  scope: "workspace",
  digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  metadata: {},
  createdAt: "2026-08-17T00:00:00.000Z",
};

describe("tool bundle loader", () => {
  it("safely extracts, validates, and stages a valid tool bundle into cache", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine });

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: "export function run() { return 'ok'; }" },
          { path: "tests/index.test.ts", content: "test('ok', () => {});" },
        ],
      });

      const loaded = await loader.loadBundle(built.archiveBuffer, {
        reference: {
          refId: "deployment-001",
          refType: "active",
          toolId: validManifest.id,
          createdAt: new Date().toISOString(),
        },
      });

      expect(loaded.digest).toBe(built.bundleDigest);
      expect(loaded.manifest.name).toBe("loader-tool");
      expect(loaded.isCached).toBe(false);
      expect(fs.existsSync(loaded.entrypointPath)).toBe(true);

      // Verify reference tracking
      const refs = await cache.getReferences(loaded.digest);
      expect(refs.length).toBe(1);
      expect(refs[0]?.refId).toBe("deployment-001");

      // Load again to verify cache hit
      const cachedLoad = await loader.loadBundle(built.archiveBuffer);
      expect(cachedLoad.isCached).toBe(true);
      expect(cachedLoad.digest).toBe(built.bundleDigest);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("quarantines payload and throws error on digest mismatch", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-mismatch-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine });

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: "export const x = 1;" }],
      });

      const fakeDigest = "0".repeat(64);

      await expect(
        loader.loadBundle(built.archiveBuffer, { expectedDigest: fakeDigest }),
      ).rejects.toThrowError(BundleSecurityError);

      // Check quarantine
      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("digest_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("quarantines payload and throws on invalid signature", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-sig-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const keyPair = generateBundleKeyPair("ed25519", "trusted-key");
      const untrustedKeyPair = generateBundleKeyPair("ed25519", "untrusted-key");

      const keyStore = new InMemoryKeyStore([
        {
          keyId: keyPair.keyId,
          algorithm: keyPair.algorithm,
          publicKeyPem: keyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      // Build bundle signed with untrusted key
      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: "export const x = 1;" }],
        signOptions: {
          keyId: untrustedKeyPair.keyId,
          privateKeyPem: untrustedKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleSignatureError,
      );

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("quarantines and rejects bundle with missing entrypoint or invalid manifest", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-invalid-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine });

      // Bundle without src/index.ts
      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "other.ts", content: "export const x = 1;" }],
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleValidationError,
      );

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("manifest_invalid");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
