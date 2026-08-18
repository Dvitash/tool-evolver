import { randomUUID } from "node:crypto";
import {
  type EvaluationResult,
  type EvolutionCandidate,
  type ProvenanceMetadata,
  type SignatureMetadata,
  type ToolArtifact,
  type ToolManifest,
  type ToolVersion,
  type ToolVersionStatus,
  canonicalJson,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import { computeSha256 } from "@tool-evolver/runtime";
import type { DatabasePool, Queryable } from "../../db/client.js";
import { type OutboxPublisher, OutboxRepository } from "../../db/outbox.js";
import type { ObjectStore } from "../../storage/object-store.js";
import { TenantGuard, getTenantContext } from "../../tenant.js";
import { ArtifactBuilder } from "./builder.js";
import { SigningKeyRepository, ToolRegistryRepository } from "./repositories/index.js";
import { ArtifactSigner } from "./signer.js";
import type {
  ArtifactStream,
  PublishCandidateOptions,
  SigningKeyAlgorithm,
  SigningKeyMetadata,
  ToolPublicationRecord,
} from "./types.js";
import { SemanticVersionClassifier } from "./versioning.js";

/**
 * Error raised when an evolution candidate is not eligible for publication.
 */
export class CandidateIneligibleError extends Error {
  readonly code = "CANDIDATE_INELIGIBLE";
  constructor(message: string) {
    super(message);
    this.name = "CandidateIneligibleError";
  }
}

/**
 * Error raised when candidate manifest or source digests do not match canonical hashes.
 */
export class CandidateDigestMismatchError extends Error {
  readonly code = "CANDIDATE_DIGEST_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "CandidateDigestMismatchError";
  }
}

/**
 * Error raised when a requested tool version does not exist.
 */
export class ToolVersionNotFoundError extends Error {
  readonly code = "TOOL_VERSION_NOT_FOUND";
  constructor(toolId: string, version: string, workspaceId: string) {
    super(`Tool version '${toolId}@${version}' not found in workspace '${workspaceId}'`);
    this.name = "ToolVersionNotFoundError";
  }
}

/**
 * Error raised when attempting to download or execute a revoked tool version.
 */
export class ToolVersionRevokedError extends Error {
  readonly code = "TOOL_VERSION_REVOKED";
  constructor(toolId: string, version: string) {
    super(`Tool version '${toolId}@${version}' is revoked and cannot be accessed`);
    this.name = "ToolVersionRevokedError";
  }
}

/**
 * Error raised when downloaded artifact digest fails integrity check.
 */
export class ArtifactIntegrityError extends Error {
  readonly code = "ARTIFACT_INTEGRITY_MISMATCH";
  constructor(expectedSha256: string, computedSha256: string) {
    super(
      `Artifact digest mismatch: expected '${expectedSha256}' but computed '${computedSha256}'`,
    );
    this.name = "ArtifactIntegrityError";
  }
}

/**
 * Error raised when signing is attempted with a revoked key.
 */
export class SigningKeyRevokedError extends Error {
  readonly code = "SIGNING_KEY_REVOKED";
  constructor(keyId: string) {
    super(`Signing key '${keyId}' is revoked and cannot be used for artifact publication`);
    this.name = "SigningKeyRevokedError";
  }
}

/**
 * Tool Artifact Registry Service.
 * Manages end-to-end candidate artifact packaging, cryptographic signing,
 * immutable version publication, ObjectStore storage, and tenant-isolated distribution.
 */
export class ToolArtifactRegistryService {
  readonly toolRegistryRepo: ToolRegistryRepository;
  readonly signingKeyRepo: SigningKeyRepository;
  readonly builder: ArtifactBuilder;
  readonly signer: ArtifactSigner;
  readonly versioning: SemanticVersionClassifier;

  constructor(
    private readonly pool: DatabasePool,
    private readonly objectStore: ObjectStore,
    options: {
      toolRegistryRepo?: ToolRegistryRepository;
      signingKeyRepo?: SigningKeyRepository;
      builder?: ArtifactBuilder;
      signer?: ArtifactSigner;
      versioning?: SemanticVersionClassifier;
      outboxPublisher?: OutboxPublisher;
    } = {},
  ) {
    this.toolRegistryRepo = options.toolRegistryRepo ?? new ToolRegistryRepository(this.pool);
    this.signingKeyRepo = options.signingKeyRepo ?? new SigningKeyRepository(this.pool);
    this.builder = options.builder ?? new ArtifactBuilder();
    this.signer = options.signer ?? new ArtifactSigner();
    this.versioning = options.versioning ?? new SemanticVersionClassifier();
  }

  /**
   * Publishes an evaluated evolution candidate as an immutable, signed tool version.
   */
  async publishCandidate(
    candidate: EvolutionCandidate,
    evaluationResult: EvaluationResult,
    options: PublishCandidateOptions = {},
  ): Promise<ToolVersion> {
    const currentTenant = getTenantContext();
    const workspaceId = candidate.workspaceId;
    const accountId = currentTenant?.accountId ?? "account_default";
    const tenant = { accountId, workspaceId };

    // 1. Eligibility validation
    if (candidate.state === "rejected" || candidate.state === "failed") {
      throw new CandidateIneligibleError(
        `Candidate '${candidate.id}' is in terminal invalid state '${candidate.state}'`,
      );
    }

    if (evaluationResult.overallDecision.verdict === "fail") {
      throw new CandidateIneligibleError(
        `Candidate '${candidate.id}' evaluation verdict failed (${evaluationResult.overallDecision.notes || "score below threshold"})`,
      );
    }

    if (evaluationResult.candidateId !== candidate.id) {
      throw new CandidateIneligibleError(
        `Evaluation result candidateId '${evaluationResult.candidateId}' does not match candidate '${candidate.id}'`,
      );
    }

    if (evaluationResult.toolId !== candidate.proposedTool.id) {
      throw new CandidateIneligibleError(
        `Evaluation result toolId '${evaluationResult.toolId}' does not match candidate toolId '${candidate.proposedTool.id}'`,
      );
    }

    // Check hard security gate in evaluation dimensions
    const securityDim = evaluationResult.dimensions.find((d) => d.name === "security");
    if (securityDim && !securityDim.passed) {
      throw new CandidateIneligibleError(
        `Candidate '${candidate.id}' failed mandatory security evaluation gate`,
      );
    }

    // 2. Digest consistency validation
    const { digest: candidateDigest, ...manifestWithoutDigest } = candidate.proposedTool;
    const expectedManifestDigest = hashCanonicalContent(manifestWithoutDigest);
    if (candidateDigest && candidateDigest !== expectedManifestDigest) {
      throw new CandidateDigestMismatchError(
        `Candidate manifest digest mismatch: specified '${candidateDigest}' but computed '${expectedManifestDigest}'`,
      );
    }

    const sourceCode =
      options.sourceCode ?? options.revision?.artifacts?.sourceCode ?? candidate.sourceCode;
    if (!sourceCode || sourceCode.trim().length === 0) {
      throw new CandidateIneligibleError(
        `Candidate '${candidate.id}' contains no source code for publication`,
      );
    }

    // 3. Version resolution and semantic diffing
    const priorActiveVersion = await this.toolRegistryRepo.getLatestActiveVersion(
      tenant,
      candidate.proposedTool.id,
    );
    const diffReport = this.versioning.diffManifests(
      candidate.proposedTool,
      priorActiveVersion ? priorActiveVersion.manifest : undefined,
    );

    let targetVersion = options.overrideVersion;
    if (!targetVersion) {
      if (options.targetVersionIncrement) {
        targetVersion = this.versioning.computeNextVersion(
          priorActiveVersion?.version,
          options.targetVersionIncrement,
          candidate.proposedTool.version,
        );
      } else {
        targetVersion = diffReport.newVersion;
      }
    }

    const { digest: _prevDigest, ...baseManifest } = candidate.proposedTool;
    const manifestForVersion = {
      ...baseManifest,
      version: targetVersion,
    };
    const finalDigest = hashCanonicalContent(manifestForVersion);
    const finalManifest: ToolManifest = {
      ...manifestForVersion,
      digest: finalDigest,
    };

    // 4. Initial publication record (assembling state)
    const pubRecordId = `pub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();

    const publicationRecord: ToolPublicationRecord = {
      id: pubRecordId,
      accountId,
      workspaceId,
      toolId: candidate.proposedTool.id,
      version: targetVersion,
      candidateId: candidate.id,
      revisionId: options.revision?.revisionId,
      state: "assembling",
      manifestDigest: finalManifest.digest,
      artifactDigest: "pending",
      storageUri: "pending",
      versionDiff: diffReport,
      createdAt: now,
      updatedAt: now,
    };

    await this.toolRegistryRepo.savePublicationRecord(tenant, publicationRecord);

    try {
      // 5. Build deterministic bundle matching TE-019
      await this.toolRegistryRepo.updatePublicationState(pubRecordId, "validating");

      const bundle = await this.builder.buildBundle({
        manifest: finalManifest,
        sourceCode,
        testCode: options.testCode ?? options.revision?.artifacts?.tests?.[0]?.code,
        documentation: options.documentation,
        packageJson: options.packageJson,
        packageLock: options.packageLock,
        candidate,
        revision: options.revision,
        synthesizerModel: options.synthesizerModel,
        workflowDefinition:
          options.workflowDefinition ?? options.revision?.artifacts?.workflowDefinition,
      });

      // 6. Cryptographic Signing
      await this.toolRegistryRepo.updatePublicationState(pubRecordId, "signing");

      const signingAlgorithm: SigningKeyAlgorithm = "ed25519";
      let signingKey: SigningKeyMetadata | null = null;

      if (options.keyId) {
        signingKey = await this.signingKeyRepo.getKey(options.keyId);
        if (!signingKey) {
          throw new Error(`Specified signing key '${options.keyId}' not found`);
        }
      } else {
        signingKey = await this.signingKeyRepo.getActiveKey(signingAlgorithm);
        if (!signingKey) {
          // Initialize active key if none exists in store
          signingKey = this.signer.generateKeyPair(signingAlgorithm, "production");
          await this.signingKeyRepo.saveKey(signingKey);
        }
      }

      if (signingKey.status === "revoked") {
        throw new SigningKeyRevokedError(signingKey.keyId);
      }

      if (!signingKey.privateKeyPem) {
        throw new Error(
          `Signing key '${signingKey.keyId}' does not have a private key available for signing`,
        );
      }

      const signature: SignatureMetadata = this.signer.signArtifact(
        bundle.artifactDigest,
        finalManifest,
        {
          keyId: signingKey.keyId,
          privateKeyPem: signingKey.privateKeyPem,
          algorithm: signingKey.algorithm,
        },
      );

      // 7. Store bundle in ObjectStore
      const storageKey = `artifacts/${workspaceId}/${candidate.proposedTool.id}/${targetVersion}/${bundle.artifactDigest}.tar`;
      await this.objectStore.putObject(storageKey, bundle.archiveBuffer, {
        sha256: bundle.artifactDigest,
        contentType: "application/x-tar",
        retention: "permanent",
        customMetadata: {
          toolId: candidate.proposedTool.id,
          version: targetVersion,
          workspaceId,
          manifestDigest: finalManifest.digest,
          artifactDigest: bundle.artifactDigest,
        },
      });

      const storageUri = `storage://${storageKey}`;

      // 8. Persist ToolVersion and update publication record atomically in transaction
      const artifact: ToolArtifact = {
        artifactDigest: bundle.artifactDigest,
        bundleReference: {
          uri: storageUri,
          hash: bundle.artifactDigest,
          sizeBytes: bundle.totalSizeBytes,
          format: "tar_gz",
        },
        entrypoint: "src/index.ts",
        sourceCode,
        checksums: bundle.fileDigests,
      };

      const provenance: ProvenanceMetadata = {
        sourceCandidateId: candidate.id,
        synthesizedAt: candidate.createdAt,
        synthesizerModel: options.synthesizerModel ?? "claude-3-7-sonnet",
        deterministicBuildHash: bundle.artifactDigest,
        environment: {
          platform: "cloud",
          runtime: "node",
        },
      };

      const toolVersion: ToolVersion = {
        toolId: candidate.proposedTool.id,
        version: targetVersion,
        manifestDigest: finalManifest.digest,
        artifactDigest: bundle.artifactDigest,
        manifest: finalManifest,
        artifact,
        provenance,
        signature,
        status: "active",
        createdAt: new Date().toISOString(),
        createdBy: "evolution-service",
      };

      await this.pool.transaction(async (txClient) => {
        // Save logical tool
        await this.toolRegistryRepo.saveTool(
          tenant,
          {
            id: candidate.proposedTool.id,
            name: candidate.proposedTool.name,
            description: candidate.proposedTool.description,
            activeVersion: targetVersion,
          },
          txClient,
        );

        // Deprecate prior active version if superseded
        if (priorActiveVersion && priorActiveVersion.version !== targetVersion) {
          await this.toolRegistryRepo.setVersionStatus(
            tenant,
            candidate.proposedTool.id,
            priorActiveVersion.version,
            "deprecated",
            targetVersion,
            txClient,
          );
        }

        // Save immutable ToolVersion
        await this.toolRegistryRepo.saveToolVersion(tenant, toolVersion, txClient);

        // Update aliases
        await this.toolRegistryRepo.setAlias(
          tenant,
          candidate.proposedTool.id,
          "latest",
          targetVersion,
          txClient,
        );
        await this.toolRegistryRepo.setAlias(
          tenant,
          candidate.proposedTool.id,
          "active",
          targetVersion,
          txClient,
        );

        // Update publication record
        await txClient.query(
          `UPDATE tool_publication_records SET
            state = 'published',
            artifact_digest = $1,
            storage_uri = $2,
            signed_by = $3,
            signature_algorithm = $4,
            provenance_digest = $5,
            published_at = $6,
            updated_at = $7
           WHERE id = $8`,
          [
            bundle.artifactDigest,
            storageUri,
            signature.keyId,
            signature.algorithm,
            bundle.provenanceDigest,
            new Date().toISOString(),
            new Date().toISOString(),
            pubRecordId,
          ],
        );

        // Enqueue outbox event
        if (!options.skipOutbox) {
          await OutboxRepository.insert(txClient, {
            accountId,
            workspaceId,
            aggregateType: "tool_version",
            aggregateId: `${candidate.proposedTool.id}:${targetVersion}`,
            eventType: "tool.version.published",
            payload: {
              toolId: candidate.proposedTool.id,
              version: targetVersion,
              manifestDigest: finalManifest.digest,
              artifactDigest: bundle.artifactDigest,
              storageUri,
              workspaceId,
              publishedAt: new Date().toISOString(),
            },
          });
        }
      });

      return toolVersion;
    } catch (err) {
      await this.toolRegistryRepo.updatePublicationState(pubRecordId, "quarantined", {
        errorMessage: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Downloads a published artifact bundle with tenant isolation and digest verification.
   */
  async downloadArtifact(
    toolId: string,
    version: string,
    workspaceId: string,
    options?: { accountId?: string; allowRevoked?: boolean },
  ): Promise<ArtifactStream> {
    const accountId = options?.accountId || "account_default";
    const tenant = { accountId, workspaceId };

    // Tenant boundary check
    const currentTenant = getTenantContext();
    if (currentTenant) {
      TenantGuard.assertAccess({ accountId, workspaceId }, currentTenant);
    }

    // Retrieve tool version record
    const toolVersion = await this.toolRegistryRepo.getToolVersion(tenant, toolId, version);
    if (!toolVersion) {
      throw new ToolVersionNotFoundError(toolId, version, workspaceId);
    }

    if (toolVersion.status === "revoked" && !options?.allowRevoked) {
      throw new ToolVersionRevokedError(toolId, version);
    }

    // Extract storage key from URI (e.g. storage://artifacts/... -> artifacts/...)
    let storageKey = toolVersion.artifact.bundleReference.uri;
    if (storageKey.startsWith("storage://")) {
      storageKey = storageKey.slice("storage://".length);
    }

    const archiveBuffer = await this.objectStore.getObject(storageKey);

    // Verify digest integrity
    const computedSha = computeSha256(archiveBuffer);
    if (computedSha !== toolVersion.artifactDigest) {
      throw new ArtifactIntegrityError(toolVersion.artifactDigest, computedSha);
    }

    return {
      stream: archiveBuffer,
      metadata: toolVersion.artifact,
      manifest: toolVersion.manifest,
      version: toolVersion,
      contentType: "application/x-tar",
      sizeBytes: archiveBuffer.length,
      digest: toolVersion.artifactDigest,
      filename: `${toolId}-${version}.tar`,
    };
  }

  /**
   * Alias for downloadArtifact using TenantContext.
   */
  async getArtifactStream(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    version: string,
  ): Promise<ArtifactStream> {
    return this.downloadArtifact(toolId, version, tenant.workspaceId, {
      accountId: tenant.accountId,
    });
  }

  /**
   * Enumerates eligible rollback target versions for a tool within a workspace.
   */
  async getEligibleRollbackTargets(
    toolId: string,
    workspaceId: string,
    options?: { accountId?: string },
  ): Promise<ToolVersion[]> {
    const accountId = options?.accountId || "account_default";
    const currentTenant = getTenantContext();
    if (currentTenant) {
      TenantGuard.assertAccess({ accountId, workspaceId }, currentTenant);
    }

    return this.toolRegistryRepo.getEligibleRollbackTargets({ accountId, workspaceId }, toolId);
  }
}

/**
 * Factory helper for ToolArtifactRegistryService.
 */
export function createToolArtifactRegistryService(
  pool: DatabasePool,
  objectStore: ObjectStore,
  options?: {
    toolRegistryRepo?: ToolRegistryRepository;
    signingKeyRepo?: SigningKeyRepository;
    builder?: ArtifactBuilder;
    signer?: ArtifactSigner;
    versioning?: SemanticVersionClassifier;
    outboxPublisher?: OutboxPublisher;
  },
): ToolArtifactRegistryService {
  return new ToolArtifactRegistryService(pool, objectStore, options);
}
