import { parseTarArchive } from "@tool-evolver/runtime";
import { describe, expect, it } from "vitest";
import { ArtifactBuilder } from "../../../src/evolution/artifacts/builder.js";
import { createMockEvolutionCandidate, createMockToolManifest } from "./helpers.js";

describe("ArtifactBuilder - Production Bundle Construction & Determinism", () => {
  const builder = new ArtifactBuilder();

  it("should assemble a deterministic bundle where identical inputs yield identical SHA-256 digests and bytes", async () => {
    const manifest = createMockToolManifest({ version: "1.2.0" });
    const candidate = createMockEvolutionCandidate({ proposedTool: manifest });
    const sourceCode = `export function add(a: number, b: number) { return a + b; }\n`;
    const testCode = `import { describe, it, expect } from 'vitest';\nit('works', () => expect(1 + 1).toBe(2));\n`;

    const bundle1 = await builder.buildBundle({
      manifest,
      sourceCode,
      testCode,
      candidate,
    });

    const bundle2 = await builder.buildBundle({
      manifest,
      sourceCode,
      testCode,
      candidate,
    });

    expect(bundle1.artifactDigest).toBe(bundle2.artifactDigest);
    expect(bundle1.manifestDigest).toBe(bundle2.manifestDigest);
    expect(bundle1.provenanceDigest).toBe(bundle2.provenanceDigest);
    expect(bundle1.archiveBuffer.equals(bundle2.archiveBuffer)).toBe(true);
    expect(bundle1.fileDigests).toEqual(bundle2.fileDigests);
  });

  it("should include all TE-019 standard bundle files in the TAR archive", async () => {
    const manifest = createMockToolManifest();
    const candidate = createMockEvolutionCandidate({ proposedTool: manifest });
    const sourceCode = `export function main() { return 'ok'; }\n`;
    const testCode = `test('main', () => {});\n`;

    const bundle = await builder.buildBundle({
      manifest,
      sourceCode,
      testCode,
      candidate,
    });

    const entries = parseTarArchive(bundle.archiveBuffer);
    const paths = entries.map((e) => e.path);

    expect(paths).toContain("manifest.json");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("tests/index.test.ts");
    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
    expect(paths).toContain("package-lock.json");
    expect(paths).toContain("provenance.json");
    expect(paths).toContain("integrity.json");

    // Verify integrity.json maps files correctly
    const integrityEntry = entries.find((e) => e.path === "integrity.json");
    expect(integrityEntry).toBeDefined();
    const integrityData = JSON.parse(integrityEntry!.content.toString("utf8"));
    expect(integrityData["src/index.ts"]).toBeDefined();
    expect(integrityData["manifest.json"]).toBeDefined();
  });

  it("should auto-generate markdown documentation and package metadata from manifest", async () => {
    const manifest = createMockToolManifest({
      id: "tool_custom_doc",
      name: "Custom Doc Tool",
      description: "A tool that does custom tasks.",
    });

    const doc = builder.generateDocumentation(manifest);
    expect(doc).toContain("# Custom Doc Tool");
    expect(doc).toContain("A tool that does custom tasks.");
    expect(doc).toContain("## Parameters");
    expect(doc).toContain("## Capabilities");

    const pkg = builder.generatePackageJson(manifest);
    expect(pkg.name).toBe("@tool-evolver-tools/tool_custom_doc");
    expect(pkg.version).toBe(manifest.version);
    expect(pkg.main).toBe("src/index.ts");
  });

  it("should support extra files and deterministic compression mode", async () => {
    const manifest = createMockToolManifest();
    const sourceCode = `export const v = 1;\n`;

    const uncompressed = await builder.buildBundle({
      manifest,
      sourceCode,
      compress: false,
      extraFiles: [
        {
          path: "extra/data.json",
          content: '{"key": "value"}',
          mode: 0o644,
        },
      ],
    });

    const entries = parseTarArchive(uncompressed.archiveBuffer);
    expect(entries.map((e) => e.path)).toContain("extra/data.json");

    const compressed1 = await builder.buildBundle({
      manifest,
      sourceCode,
      compress: true,
    });

    const compressed2 = await builder.buildBundle({
      manifest,
      sourceCode,
      compress: true,
    });

    expect(compressed1.archiveBuffer.equals(compressed2.archiveBuffer)).toBe(true);
    expect(compressed1.artifactDigest).toBe(compressed2.artifactDigest);
  });
});
