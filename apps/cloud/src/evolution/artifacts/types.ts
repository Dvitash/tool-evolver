import { z } from "zod";
import {
  type CapabilityEnvelope,
  type CapabilityManifest,
  type EvolutionCandidate,
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  type ToolArtifact,
  ToolArtifactSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  ToolVersionSchema,
  type ToolVersionStatus,
  ToolVersionStatusSchema,
  type EvaluationResult,
} from "@tool-evolver/contracts";
import type { CandidateRevision } from "../generator/types.js";
import type { BundleFileEntry, ToolBundleSpec } from "@tool-evolver/runtime";

/**
 * Lifecycle states during candidate artifact packaging, verification, and publication.
 */
export const PublicationStateSchema = z.enum([
  "assembling",
  "validating",
  "signing",
  "published",
  "quarantined",
  "revoked",
  "retired",
]);

export type PublicationState = z.infer<typeof PublicationStateSchema>;

/**
 * Semantic version increment category.
 */
export const SemanticVersionIncrementSchema = z.enum(["patch", "minor", "major"]);

export type SemanticVersionIncrement = z.infer<typeof SemanticVersionIncrementSchema>;

/**
 * Detailed difference report between a candidate and its prior active version.
 */
export const VersionDiffReportSchema = z.object({
  previousVersion: SchemaVersionSchema.optional(),
  newVersion: SchemaVersionSchema,
  increment: SemanticVersionIncrementSchema,
  breakingChanges: z.array(z.string()).default([]),
  schemaChanges: z.object({
    addedParameters: z.array(z.string()).default([]),
    removedParameters: z.array(z.string()).default([]),
    modifiedParameters: z.array(z.string()).default([]),
  }),
  capabilityChanges: z.object({
    addedCapabilities: z.array(z.string()).default([]),
    removedCapabilities: z.array(z.string()).default([]),
    modifiedCapabilities: z.array(z.string()).default([]),
  }),
  dependencyChanges: z.object({
    addedDependencies: z.array(z.string()).default([]),
    removedDependencies: z.array(z.string()).default([]),
    updatedDependencies: z.array(z.string()).default([]),
  }),
  contractChanges: z.array(z.string()).default([]),
  summary: z.string(),
});

export type VersionDiffReport = z.infer<typeof VersionDiffReportSchema>;

/**
 * Tool Publication Record tracking artifact publication lifecycle and audit trail.
 */
export const ToolPublicationRecordSchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  candidateId: IdentifierSchema,
  revisionId: IdentifierSchema.optional(),
  state: PublicationStateSchema,
  manifestDigest: Sha256DigestSchema,
  artifactDigest: Sha256DigestSchema,
  storageUri: z.string().min(1),
  signedBy: z.string().optional(),
  signatureAlgorithm: z.string().optional(),
  provenanceDigest: Sha256DigestSchema.optional(),
  versionDiff: VersionDiffReportSchema.optional(),
  errorMessage: z.string().optional(),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
  publishedAt: ISOTimestampSchema.optional(),
});

export type ToolPublicationRecord = z.infer<typeof ToolPublicationRecordSchema>;

/**
 * Supported cryptographic signing algorithms.
 */
export const SigningKeyAlgorithmSchema = z.enum([
  "ed25519",
  "ecdsa_p256_sha256",
  "rsa_pss_sha256",
]);

export type SigningKeyAlgorithm = z.infer<typeof SigningKeyAlgorithmSchema>;

/**
 * Status of a signing key in the trust store.
 */
export const SigningKeyStatusSchema = z.enum(["active", "rotated", "revoked"]);

export type SigningKeyStatus = z.infer<typeof SigningKeyStatusSchema>;

/**
 * Trust level assigned to a signing key.
 */
export const SigningKeyTrustLevelSchema = z.enum(["production", "staging", "development"]);

export type SigningKeyTrustLevel = z.infer<typeof SigningKeyTrustLevelSchema>;

/**
 * Cryptographic signing key metadata and public credentials.
 */
export const SigningKeyMetadataSchema = z.object({
  keyId: z.string().min(1),
  algorithm: SigningKeyAlgorithmSchema,
  publicKeyPem: z.string().min(1),
  privateKeyPem: z.string().optional(),
  status: SigningKeyStatusSchema.default("active"),
  trustLevel: SigningKeyTrustLevelSchema.default("production"),
  revocationReason: z.string().optional(),
  revokedAt: ISOTimestampSchema.optional(),
  createdAt: ISOTimestampSchema,
  rotatedAt: ISOTimestampSchema.optional(),
});

export type SigningKeyMetadata = z.infer<typeof SigningKeyMetadataSchema>;

/**
 * Logical tool record in the catalog.
 */
export interface ToolEntity {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  description?: string;
  activeVersion?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Version alias pointer.
 */
export interface ToolVersionAliasEntity {
  id: string;
  accountId: string;
  workspaceId: string;
  toolId: string;
  alias: string;
  version: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Result of artifact bundle construction.
 */
export interface BuiltArtifactBundle {
  archiveBuffer: Buffer;
  artifactDigest: string;
  manifestDigest: string;
  provenanceDigest: string;
  fileDigests: Record<string, string>;
  totalSizeBytes: number;
  files: BundleFileEntry[];
  manifest: ToolManifest;
  spec: ToolBundleSpec;
}

/**
 * Downloaded artifact bundle stream and metadata.
 */
export interface ArtifactStream {
  stream: Buffer | NodeJS.ReadableStream;
  metadata: ToolArtifact;
  manifest: ToolManifest;
  version: ToolVersion;
  contentType: string;
  sizeBytes: number;
  digest: string;
  filename: string;
}

/**
 * Options for publishing an evolution candidate.
 */
export interface PublishCandidateOptions {
  revision?: CandidateRevision;
  sourceCode?: string;
  testCode?: string;
  documentation?: string;
  packageJson?: Record<string, unknown>;
  packageLock?: Record<string, unknown> | string;
  synthesizerModel?: string;
  targetVersionIncrement?: SemanticVersionIncrement;
  overrideVersion?: string;
  keyId?: string;
  skipOutbox?: boolean;
}
