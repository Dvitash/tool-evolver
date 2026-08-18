import zlib from "node:zlib";
import {
  type EvolutionCandidate,
  type ProvenanceMetadata,
  type ToolManifest,
  canonicalJson,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import {
  type BuiltToolBundle,
  type BundleFileInput,
  buildToolBundle,
  computeSha256,
} from "@tool-evolver/runtime";
import type { CandidateRevision } from "../generator/types.js";
import type { BuiltArtifactBundle } from "./types.js";

/**
 * Options for constructing a production tool artifact bundle.
 */
export interface BuildArtifactOptions {
  manifest: ToolManifest;
  sourceCode: string;
  testCode?: string;
  documentation?: string;
  packageJson?: Record<string, unknown>;
  packageLock?: Record<string, unknown> | string;
  provenance?: ProvenanceMetadata;
  candidate?: EvolutionCandidate;
  revision?: CandidateRevision;
  synthesizerModel?: string;
  extraFiles?: BundleFileInput[];
  compress?: boolean;
  workflowDefinition?: Record<string, unknown>;
}

/**
 * Production Tool Artifact Bundle Builder.
 * Assembles deterministic, reproducible artifact packages matching the TE-019 bundle specification.
 */
export class ArtifactBuilder {
  /**
   * Generates a standard README documentation markdown string if not explicitly provided.
   */
  generateDocumentation(manifest: ToolManifest): string {
    const lines: string[] = [];
    lines.push(`# ${manifest.name}`);
    lines.push("");
    lines.push(`> Version: ${manifest.version}`);
    lines.push("");
    lines.push(manifest.description || "Synthesized tool created by Tool Evolver.");
    lines.push("");
    lines.push("## Parameters");
    lines.push("");

    const params = manifest.parameters?.properties ?? {};
    const required = new Set(manifest.parameters?.required ?? []);

    if (Object.keys(params).length === 0) {
      lines.push("This tool takes no parameters.");
    } else {
      lines.push("| Parameter | Type | Required | Description |");
      lines.push("| --- | --- | --- | --- |");
      const sortedKeys = Object.keys(params).sort();
      for (const key of sortedKeys) {
        const prop = params[key] as { type?: string; description?: string } | undefined;
        const typeStr = prop?.type ?? "any";
        const reqStr = required.has(key) ? "Yes" : "No";
        const descStr = prop?.description ?? "-";
        lines.push(`| \`${key}\` | \`${typeStr}\` | ${reqStr} | ${descStr} |`);
      }
    }

    lines.push("");
    lines.push("## Capabilities");
    lines.push("");

    const caps = manifest.capabilities;
    const capLines: string[] = [];
    if (caps) {
      if (caps.fs?.readPaths?.length || caps.fs?.writePaths?.length) {
        capLines.push(
          `- **Filesystem**: Read \`[${(caps.fs.readPaths || []).join(", ")}]\`, Write \`[${(caps.fs.writePaths || []).join(", ")}]\``,
        );
      }
      if (caps.net?.allowedHosts?.length) {
        capLines.push(`- **Network**: Allowed hosts \`[${caps.net.allowedHosts.join(", ")}]\``);
      }
      if (caps.command?.allowedCommands?.length || caps.command?.allowShellExecution) {
        capLines.push(
          `- **Command Execution**: \`[${(caps.command.allowedCommands || []).join(", ")}]\` (Shell: ${caps.command.allowShellExecution ?? false})`,
        );
      }
      if (caps.secrets?.allowedSecretNames?.length) {
        capLines.push(`- **Secrets**: \`[${caps.secrets.allowedSecretNames.join(", ")}]\``);
      }
    }

    if (capLines.length === 0) {
      lines.push("No elevated capabilities requested.");
    } else {
      lines.push(...capLines);
    }

    lines.push("");
    return lines.join("\n");
  }

  /**
   * Generates a standard package.json definition if not explicitly provided.
   */
  generatePackageJson(
    manifest: ToolManifest,
    custom?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      name: `@tool-evolver-tools/${manifest.id}`,
      version: manifest.version,
      description: manifest.description,
      main: "src/index.ts",
      types: "src/index.ts",
      type: "module",
      ...custom,
    };
  }

  /**
   * Generates a deterministic package-lock.json structure.
   */
  generatePackageLock(
    manifest: ToolManifest,
    custom?: Record<string, unknown> | string,
  ): Record<string, unknown> {
    if (typeof custom === "object" && custom !== null) {
      return custom;
    }
    return {
      name: `@tool-evolver-tools/${manifest.id}`,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: `@tool-evolver-tools/${manifest.id}`,
          version: manifest.version,
        },
      },
    };
  }

  /**
   * Generates deterministic provenance metadata for the artifact.
   */
  generateProvenance(
    candidate?: EvolutionCandidate,
    revision?: CandidateRevision,
    synthesizerModel = "claude-3-7-sonnet",
  ): ProvenanceMetadata {
    const candidateId = candidate?.id ?? revision?.candidateId ?? "cand_synthetic";
    const promptHash = hashCanonicalContent({
      candidateId,
      trigger: candidate?.trigger,
      plan: revision?.artifacts?.plan,
    });

    return {
      sourceCandidateId: candidateId,
      synthesizedAt: candidate?.createdAt ?? new Date(0).toISOString(),
      synthesizerModel,
      promptHash,
      deterministicBuildHash: hashCanonicalContent({ candidateId, promptHash }),
      environment: {
        platform: "cloud",
        runtime: "node",
      },
    };
  }

  /**
   * Assembles a deterministic production bundle.
   */
  async buildBundle(options: BuildArtifactOptions): Promise<BuiltArtifactBundle> {
    const files: BundleFileInput[] = [];

    // 1. Source code entrypoint
    const sourceCode = `${options.sourceCode.trimEnd()}\n`;
    files.push({
      path: "src/index.ts",
      content: sourceCode,
      mode: 0o644,
    });

    // 2. Test code (if available)
    const testCode = options.testCode ?? options.revision?.artifacts?.tests?.[0]?.code;
    if (testCode) {
      files.push({
        path: "tests/index.test.ts",
        content: `${testCode.trimEnd()}\n`,
        mode: 0o644,
      });
    }

    // 3. Documentation (README.md)
    const documentation = options.documentation ?? this.generateDocumentation(options.manifest);
    files.push({
      path: "README.md",
      content: `${documentation.trimEnd()}\n`,
      mode: 0o644,
    });

    // 4. Package.json
    const packageJson = this.generatePackageJson(options.manifest, options.packageJson);
    files.push({
      path: "package.json",
      content: canonicalJson(packageJson),
      mode: 0o644,
    });

    // 5. Package-lock.json
    const packageLock = this.generatePackageLock(options.manifest, options.packageLock);
    files.push({
      path: "package-lock.json",
      content: typeof packageLock === "string" ? packageLock : canonicalJson(packageLock),
      mode: 0o644,
    });

    // 6. Provenance metadata
    const provenance =
      options.provenance ??
      this.generateProvenance(options.candidate, options.revision, options.synthesizerModel);
    files.push({
      path: "provenance.json",
      content: canonicalJson(provenance),
      mode: 0o644,
    });

    // 6b. Workflow definition (if available)
    const workflowDef =
      options.workflowDefinition ?? options.revision?.artifacts?.workflowDefinition;
    if (workflowDef) {
      files.push({
        path: "workflow.json",
        content: `${canonicalJson(workflowDef)}\n`,
        mode: 0o644,
      });
    }
    // 7. Extra files (if any)
    if (options.extraFiles) {
      for (const extra of options.extraFiles) {
        files.push(extra);
      }
    }
    // 8. File integrity manifest
    const fileDigestsMap: Record<string, string> = {
      "manifest.json": hashCanonicalContent(options.manifest),
    };
    for (const f of files) {
      const contentBuf = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content;
      fileDigestsMap[f.path] = computeSha256(contentBuf);
    }
    files.push({
      path: "integrity.json",
      content: canonicalJson(fileDigestsMap),
      mode: 0o644,
    });

    // Build raw tar bundle deterministically via @tool-evolver/runtime
    const builtBundle: BuiltToolBundle = await buildToolBundle({
      manifest: options.manifest,
      files,
      entrypoint: "src/index.ts",
      testsPath: testCode ? "tests/index.test.ts" : undefined,
      packageJson,
      format: "tar",
      createdAt: new Date(0).toISOString(),
    });

    let finalArchive = builtBundle.archiveBuffer;
    if (options.compress) {
      // Deterministic gzip compression (mtime=0)
      finalArchive = zlib.gzipSync(builtBundle.archiveBuffer);
    }

    const artifactDigest = computeSha256(finalArchive);
    const manifestDigest = options.manifest.digest || hashCanonicalContent(options.manifest);
    const provenanceDigest = hashCanonicalContent(provenance);

    return {
      archiveBuffer: finalArchive,
      artifactDigest,
      manifestDigest,
      provenanceDigest,
      fileDigests: builtBundle.fileDigests,
      totalSizeBytes: finalArchive.length,
      files: builtBundle.files,
      manifest: options.manifest,
      spec: builtBundle.spec,
    };
  }
}

/**
 * Factory helper for ArtifactBuilder.
 */
export function createArtifactBuilder(): ArtifactBuilder {
  return new ArtifactBuilder();
}
