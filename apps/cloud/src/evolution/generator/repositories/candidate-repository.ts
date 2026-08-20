import {
  type CandidateState,
  type CapabilityManifest,
  type EvolutionCandidate,
  EvolutionCandidateSchema,
  type ToolManifest,
  ToolManifestSchema,
  canonicalJsonStringify,
  hashCanonical,
} from "@tool-evolver/contracts";
import type { DatabasePool, Queryable } from "../../../db/client.js";
import type { ModelUsage } from "../../../models/types.js";
import type { ObjectStore } from "../../../storage/object-store.js";
import { type TenantContext, TenantGuard } from "../../../tenant.js";
import type { CandidateRevision, GeneratedArtifactSet, SelfReviewVerdict, ToolPlan } from "../types.js";
function normalizeManifest(manifest: unknown): Record<string, unknown> {
  const raw = manifest as Record<string, unknown>;
  // Preserve legacy fs/exec shapes without defaulting fs to true (brokered old schema used allowRead/allowWrite)
  const rawCaps = raw.capabilities as Record<string, unknown> | undefined;
  let preNormalized: Record<string, unknown> = raw;
  if (rawCaps && typeof rawCaps === "object" && (rawCaps.fs || rawCaps.exec)) {
    const capsCopy = JSON.parse(JSON.stringify(rawCaps)) as Record<string, unknown>;
    const fs = capsCopy.fs as Record<string, unknown> | undefined;
    if (fs && typeof fs === "object" && ("allowRead" in fs || "allowWrite" in fs)) {
      const allowRead = Boolean((fs as Record<string, unknown>).allowRead);
      const allowWrite = Boolean((fs as Record<string, unknown>).allowWrite);
      capsCopy.fs = {
        readPaths: Array.isArray(fs.readPaths) ? fs.readPaths : [],
        writePaths: Array.isArray(fs.writePaths) ? fs.writePaths : [],
        allowWorkspaceRoot: allowRead,
        allowTemp: allowRead || allowWrite,
        denyPaths: Array.isArray((fs as Record<string, unknown>).denyPaths) ? (fs as Record<string, unknown>).denyPaths : [],
        maxFileSizeBytes: typeof (fs as Record<string, unknown>).maxFileSizeBytes === "number" ? (fs as Record<string, unknown>).maxFileSizeBytes : 10485760,
      };
    }
    if ((capsCopy as Record<string, unknown>).exec && !(capsCopy as Record<string, unknown>).command) {
      const exec = (capsCopy as Record<string, unknown>).exec as Record<string, unknown>;
      (capsCopy as Record<string, unknown>).command = {
        allowShellExecution: Boolean(exec.allowExec),
        allowedCommands: Array.isArray(exec.allowedCommands) ? exec.allowedCommands : [],
      };
    }
    preNormalized = { ...raw, capabilities: capsCopy };
  }
  const parsed = ToolManifestSchema.parse(preNormalized);
  const { digest: _d, createdAt: _ca, updatedAt: _ua, ...withoutMeta } = parsed as unknown as Record<string, unknown>;
  return JSON.parse(canonicalJsonStringify(withoutMeta)) as Record<string, unknown>;
}

function normalizePlanForComparison(plan: unknown): unknown {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const p = plan as Record<string, unknown>;
  const { createdAt: _ca, updatedAt: _ua, id: _id, planId: _pid, opportunityId: _oid, workspaceId: _wid, metadata: _meta, ...rest } = p;
  return rest;
}
/**
 * Filter options for listing evolution candidates.
 */
export interface CandidateFilter {
  state?: CandidateState;
  opportunityId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Maps a database row to an EvolutionCandidate domain entity.
 */
export function mapRowToCandidate(row: Record<string, unknown>): EvolutionCandidate {
  const rawManifest =
    typeof row.manifest === "string"
      ? JSON.parse(row.manifest)
      : (row.manifest as Record<string, unknown>);
  // Stored manifest is normalized without digest/createdAt (stripped on write).
  // Do not re-validate with ToolManifestSchema which requires digest; use raw as base.
  const manifestBase = rawManifest as Record<string, unknown>;
  const createdAtForManifest =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? (rawManifest as Record<string, unknown>).createdAt ?? new Date().toISOString());
  const updatedAtForManifest = row.updated_at
    ? row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at)
    : (rawManifest as Record<string, unknown>).updatedAt
      ? String((rawManifest as Record<string, unknown>).updatedAt)
      : undefined;
  const manifest = {
    ...manifestBase,
    digest: String(row.manifest_digest ?? (rawManifest as Record<string, unknown>).digest ?? ""),
    createdAt: String((rawManifest as Record<string, unknown>).createdAt ?? createdAtForManifest),
    ...(updatedAtForManifest ? { updatedAt: updatedAtForManifest } : {}),
  } as unknown as Record<string, unknown>;
  const requiredCapabilities =
    typeof row.required_capabilities === "string"
      ? JSON.parse(row.required_capabilities)
      : (row.required_capabilities as Record<string, unknown>) || {};

  const evidenceEventIds =
    typeof row.evidence_event_ids === "string"
      ? (JSON.parse(row.evidence_event_ids) as string[])
      : (row.evidence_event_ids as string[]) || [];

  const metrics =
    typeof row.metrics === "string"
      ? JSON.parse(row.metrics)
      : (row.metrics as Record<string, unknown>) || {};

  const evaluationSummary = row.evaluation_summary
    ? typeof row.evaluation_summary === "string"
      ? JSON.parse(row.evaluation_summary)
      : row.evaluation_summary
    : undefined;

  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at || new Date().toISOString());

  const updatedAt = row.updated_at
    ? row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at)
    : undefined;

  return EvolutionCandidateSchema.parse({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    schemaVersion: "1.0.0",
    state: row.state as CandidateState,
    trigger: {
      reason: String(row.trigger_reason),
      evidenceEventIds,
      sessionOccurrences: Number(metrics.sessionOccurrences ?? metrics.patternFrequency ?? 1),
      detectedAt: String(metrics.detectedAt ?? createdAt),
      patternFrequency: Number(metrics.patternFrequency ?? 1),
    },
    proposedTool: manifest,
    requiredCapabilities,
    evaluationSummary,
    sourceCode: row.source_code ? String(row.source_code) : undefined,
    rejectionReason: row.rejection_reason ? String(row.rejection_reason) : undefined,
    createdAt,
    updatedAt,
  });
}

/**
 * Maps a database row to a CandidateRevision domain entity.
 * Reconstructs the full immutable ToolPlan exactly as persisted in
 * provenance.plan when present; falls back to lossy reconstruction for
 * legacy rows without a stored plan.
 */
export function mapRowToRevision(row: Record<string, unknown>): CandidateRevision {
  const inputSchema =
    typeof row.input_schema === "string"
      ? JSON.parse(row.input_schema)
      : (row.input_schema as Record<string, unknown>);

  const outputSchema =
    typeof row.output_schema === "string"
      ? JSON.parse(row.output_schema)
      : (row.output_schema as Record<string, unknown>);

  const rawManifest =
    typeof row.manifest === "string"
      ? JSON.parse(row.manifest)
      : (row.manifest as Record<string, unknown>);
  // Stored manifest is normalized without digest/createdAt; reconstruct without re-validating.
  const manifestBaseRev = rawManifest as Record<string, unknown>;
  const createdAtRev = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? (rawManifest as Record<string, unknown>).createdAt ?? new Date().toISOString());
  const manifest = {
    ...manifestBaseRev,
    digest: String(row.manifest_digest ?? (rawManifest as Record<string, unknown>).digest ?? ""),
    createdAt: String((rawManifest as Record<string, unknown>).createdAt ?? createdAtRev),
  } as unknown as Record<string, unknown>;

  const capabilities =
    typeof row.capabilities === "string"
      ? JSON.parse(row.capabilities)
      : (row.capabilities as Record<string, unknown>);

  const selfReview =
    typeof row.self_review === "string"
      ? (JSON.parse(row.self_review) as SelfReviewVerdict)
      : (row.self_review as SelfReviewVerdict) || {
          passed: true,
          issues: [],
          reviewedAt: new Date().toISOString(),
        };

  const repairHistory =
    typeof row.repair_history === "string"
      ? JSON.parse(row.repair_history)
      : (row.repair_history as CandidateRevision["repairHistory"]) || [];

  const usage =
    typeof row.usage === "string"
      ? JSON.parse(row.usage)
      : (row.usage as Record<string, unknown>) || {};

  const provenance =
    typeof row.provenance === "string"
      ? JSON.parse(row.provenance)
      : (row.provenance as Record<string, unknown>) || {};

  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at || new Date().toISOString());

  const sourceCode = String(row.source_code);

  let plan: ToolPlan;
  const storedPlan = (provenance as Record<string, unknown>).plan;
  if (storedPlan && typeof storedPlan === "object" && !Array.isArray(storedPlan)) {
    const sp = storedPlan as Record<string, unknown>;
    // If stored plan is minimal (missing runtime/id) from legacy synthesized path, enrich with fallback defaults while preserving original artifacts
    const isMinimal = !sp.runtime || !sp.id || !sp.opportunityId;
    if (isMinimal) {
      const fallback = {
        id: `plan_${String(row.candidate_id)}`,
        opportunityId: String((provenance as Record<string, unknown>).opportunityId ?? ""),
        workspaceId: String(row.workspace_id),
        targetType: (manifest as Record<string, unknown>).scope === "workspace" ? "single_tool" : "single_tool",
        intent: String((manifest as Record<string, unknown>).description ?? ""),
        name: String((manifest as Record<string, unknown>).name ?? ""),
        description: String((manifest as Record<string, unknown>).description ?? ""),
        variableInputs: [],
        invariantInputs: [],
        inputSchema,
        outputSchema,
        steps: [],
        capabilities: capabilities as unknown as CapabilityManifest,
        capabilityRequirements: capabilities as unknown as CapabilityManifest,
        runtime: {
          runtime: "deno",
          memoryLimitMb: 128,
          timeoutMs: 30000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 1048576,
        },
        metadata: {},
        createdAt,
      } as Record<string, unknown>;
      plan = { ...fallback, ...sp } as unknown as ToolPlan;
      if (sp.capabilities) plan.capabilities = sp.capabilities as CapabilityManifest;
      if (sp.capabilityRequirements) plan.capabilityRequirements = sp.capabilityRequirements as CapabilityManifest;
      if (sp.workflowContract) (plan as unknown as Record<string, unknown>).workflowContract = sp.workflowContract;
      else delete (plan as unknown as Record<string, unknown>).workflowContract;
      if (sp.workflowCoverage) (plan as unknown as Record<string, unknown>).workflowCoverage = sp.workflowCoverage;
      else delete (plan as unknown as Record<string, unknown>).workflowCoverage;
    } else {
      plan = sp as unknown as ToolPlan;
    }
  } else {
    plan = {
      id: `plan_${String(row.candidate_id)}`,
      opportunityId: String((provenance as Record<string, unknown>).opportunityId ?? ""),
      workspaceId: String(row.workspace_id),
      targetType: (manifest as Record<string, unknown>).scope === "workspace" ? "single_tool" : "single_tool",
      intent: String((manifest as Record<string, unknown>).description ?? ""),
      name: String((manifest as Record<string, unknown>).name ?? ""),
      description: String((manifest as Record<string, unknown>).description ?? ""),
      variableInputs: [],
      invariantInputs: [],
      inputSchema,
      outputSchema,
      steps: [],
      capabilities: capabilities as unknown as CapabilityManifest,
      capabilityRequirements: capabilities as unknown as CapabilityManifest,
      runtime: {
        runtime: "deno",
        memoryLimitMb: 128,
        timeoutMs: 30000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
      metadata: {},
      createdAt,
      workflowContract: (provenance as Record<string, unknown>).workflowContract as unknown as ToolPlan["workflowContract"],
      workflowCoverage: (provenance as Record<string, unknown>).workflowCoverage as unknown as ToolPlan["workflowCoverage"],
    };
  }

  const artifacts: GeneratedArtifactSet = {
    plan,
    manifest: manifest as unknown as ToolManifest,
    capabilities: capabilities as unknown as CapabilityManifest,
    sourceCode,
    workflowDefinition: row.workflow_definition
      ? typeof row.workflow_definition === "string"
        ? JSON.parse(row.workflow_definition)
        : (row.workflow_definition as Record<string, unknown>)
      : (provenance as Record<string, unknown>).workflowDefinition
        ? ((provenance as Record<string, unknown>).workflowDefinition as Record<string, unknown>)
        : undefined,
    tests: row.tests
      ? typeof row.tests === "string"
        ? JSON.parse(row.tests)
        : (row.tests as GeneratedArtifactSet["tests"])
      : (provenance as Record<string, unknown>).tests
        ? ((provenance as Record<string, unknown>).tests as GeneratedArtifactSet["tests"])
        : undefined,
    generatedAt: createdAt,
  };

  return {
    revisionId: String(row.id),
    candidateId: String(row.candidate_id),
    revisionNumber: Number(row.revision_number ?? 1),
    parentRevisionId: row.parent_revision_id ? String(row.parent_revision_id) : undefined,
    artifacts,
    selfReview,
    repairHistory,
    capabilityDiff: (provenance as Record<string, unknown>).capabilityDiff
      ? ((provenance as Record<string, unknown>).capabilityDiff as CandidateRevision["capabilityDiff"])
      : undefined,
    cost: (provenance as Record<string, unknown>).cost ? ((provenance as Record<string, unknown>).cost as CandidateRevision["cost"]) : undefined,
    storageUri: row.storage_uri ? String(row.storage_uri) : undefined,
    provenance: provenance as Record<string, unknown>,
    usage: usage as unknown as ModelUsage,
    promptTemplateVersion: row.prompt_template_version
      ? String(row.prompt_template_version)
      : undefined,
    promptDigest: row.prompt_digest ? String(row.prompt_digest) : undefined,
    modelProvider: row.model_provider ? String(row.model_provider) : undefined,
    modelId: row.model_id ? String(row.model_id) : undefined,
    requestId: row.request_id ? String(row.request_id) : undefined,
    createdAt,
  };
}

/**
 * PostgreSQL repository for persisting evolution candidates, revisions,
 * lineage tracking, and provenance metadata with strict tenant isolation.
 */
export class CandidateRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly objectStore?: ObjectStore,
  ) {}

  /**
   * Persists or updates an evolution candidate idempotently.
   */
  async saveCandidate(
    tenant: TenantContext,
    candidate: EvolutionCandidate,
    options: {
      activeRevision?: CandidateRevision;
      provenance?: Record<string, unknown>;
      db?: Queryable;
    } = {},
  ): Promise<EvolutionCandidate> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    const client = options.db ?? this.pool;
    const idempotencyKey = hashCanonical({
      workspaceId: tenant.workspaceId,
      candidateId: candidate.id,
      proposedToolDigest: candidate.proposedTool.digest,
    });

    const metrics = {
      sessionOccurrences: candidate.trigger.sessionOccurrences,
      patternFrequency: candidate.trigger.patternFrequency,
      detectedAt: candidate.trigger.detectedAt,
    };

    const query = `
      INSERT INTO evolution_candidates (
        id,
        account_id,
        workspace_id,
        opportunity_id,
        structural_hash,
        idempotency_key,
        state,
        proposed_tool_name,
        proposed_tool_version,
        manifest,
        manifest_digest,
        required_capabilities,
        trigger_reason,
        evidence_event_ids,
        metrics,
        provenance,
        active_revision_id,
        source_code,
        evaluation_summary,
        rejection_reason,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        state = EXCLUDED.state,
        manifest = EXCLUDED.manifest,
        manifest_digest = EXCLUDED.manifest_digest,
        required_capabilities = EXCLUDED.required_capabilities,
        active_revision_id = COALESCE(EXCLUDED.active_revision_id, evolution_candidates.active_revision_id),
        source_code = COALESCE(EXCLUDED.source_code, evolution_candidates.source_code),
        evaluation_summary = COALESCE(EXCLUDED.evaluation_summary, evolution_candidates.evaluation_summary),
        rejection_reason = COALESCE(EXCLUDED.rejection_reason, evolution_candidates.rejection_reason),
        provenance = EXCLUDED.provenance,
        metrics = EXCLUDED.metrics,
        updated_at = EXCLUDED.updated_at
      RETURNING *;
    `;

    const values = [
      candidate.id,
      tenant.accountId,
      tenant.workspaceId,
      (options.provenance?.opportunityId as string) || `opp_${candidate.id}`,
      (options.provenance?.structuralHash as string) || candidate.id,
      idempotencyKey,
      candidate.state,
      candidate.proposedTool.name,
      candidate.proposedTool.version,
      canonicalJsonStringify(normalizeManifest(candidate.proposedTool)),
      candidate.proposedTool.digest,
      JSON.stringify(candidate.requiredCapabilities),
      candidate.trigger.reason,
      JSON.stringify(candidate.trigger.evidenceEventIds),
      JSON.stringify(metrics),
      JSON.stringify(options.provenance || {}),
      options.activeRevision?.revisionId || null,
      candidate.sourceCode || options.activeRevision?.artifacts.sourceCode || null,
      candidate.evaluationSummary ? JSON.stringify(candidate.evaluationSummary) : null,
      candidate.rejectionReason || null,
      candidate.createdAt || new Date().toISOString(),
      candidate.updatedAt || new Date().toISOString(),
    ];

    const result = await client.query<Record<string, unknown>>(query, values);
    return mapRowToCandidate(result.rows[0]);
  }

  /**
   * Persists a candidate revision with complete provenance and optional object storage backup.
   */
  async saveRevision(
    tenant: TenantContext,
    revision: CandidateRevision,
    options: { db?: Queryable } = {},
  ): Promise<CandidateRevision> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    const client = options.db ?? this.pool;
    // Enforce immutability: same revision ID must not be overwritten with different artifacts.
    // Identical delivery (same revisionId + same artifact hash) is idempotent; different artifacts must use new revisionId.
    const existingRevision = await this.getRevisionById(tenant, revision.revisionId, client);
    if (existingRevision) {
      const normalizeForComparison = (rev: CandidateRevision) => {
        return hashCanonical({
          manifest: normalizeManifest(rev.artifacts.manifest),
          sourceCode: rev.artifacts.sourceCode ?? "",
          capabilities: rev.artifacts.capabilities ?? {},
          tests: rev.artifacts.tests ?? null,
          workflowDefinition: rev.artifacts.workflowDefinition ?? null,
          plan: normalizePlanForComparison(rev.artifacts.plan) ?? null,
        });
      };
      const existingHash = normalizeForComparison(existingRevision);
      const newHash = normalizeForComparison(revision);
      if (existingHash !== newHash) {
        throw new Error(
          `Immutable revision violation: revision ${revision.revisionId} already exists with different artifacts; new revision ID required for changed artifacts`,
        );
      }
      return existingRevision;
    }

    let storageUri = revision.storageUri;
    if (this.objectStore && !storageUri) {
      const storageKey = `candidates/${tenant.workspaceId}/${revision.candidateId}/${revision.revisionId}/tool.ts`;
      const storeResult = await this.objectStore.putObject(
        storageKey,
        revision.artifacts.sourceCode,
        {
          contentType: "text/typescript",
          customMetadata: {
            workspaceId: tenant.workspaceId,
            candidateId: revision.candidateId,
            revisionId: revision.revisionId,
          },
        },
      );
      storageUri = `objectstore://${storeResult.key}`;
    }

    const sourceDigest = hashCanonical(revision.artifacts.sourceCode);
    const schemaDigest = hashCanonical({
      input: revision.artifacts.plan.inputSchema,
      output: revision.artifacts.plan.outputSchema,
    });

    const query = `
      INSERT INTO candidate_revisions (
        id,
        candidate_id,
        account_id,
        workspace_id,
        revision_number,
        parent_revision_id,
        source_code,
        source_digest,
        input_schema,
        output_schema,
        schema_digest,
        manifest,
        manifest_digest,
        capabilities,
        state,
        prompt_template_id,
        prompt_template_version,
        prompt_digest,
        model_provider,
        model_id,
        request_id,
        usage,
        provenance,
        self_review,
        repair_history,
        storage_uri,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
      ON CONFLICT (workspace_id, id) DO NOTHING
      RETURNING *;
    `;

    const values = [
      revision.revisionId,
      revision.candidateId,
      tenant.accountId,
      tenant.workspaceId,
      revision.revisionNumber,
      revision.parentRevisionId || null,
      revision.artifacts.sourceCode,
      sourceDigest,
      JSON.stringify(revision.artifacts.plan.inputSchema),
      JSON.stringify(revision.artifacts.plan.outputSchema),
      schemaDigest,
      canonicalJsonStringify(normalizeManifest(revision.artifacts.manifest)),
      revision.artifacts.manifest.digest,
      JSON.stringify(revision.artifacts.capabilities),
      "active",
      revision.promptTemplateId || null,
      revision.promptTemplateVersion || null,
      revision.promptDigest || null,
      revision.modelProvider || null,
      revision.modelId || null,
      revision.requestId || null,
      JSON.stringify(revision.usage || {}),
      JSON.stringify({
        ...revision.provenance,
        capabilityDiff: revision.capabilityDiff,
        cost: revision.cost,
        workflowDefinition: revision.artifacts.workflowDefinition,
        tests: revision.artifacts.tests,
        workflowContract: revision.artifacts.plan?.workflowContract,
        workflowCoverage: revision.artifacts.plan?.workflowCoverage,
        plan: revision.artifacts.plan,
      }),
      JSON.stringify(revision.selfReview),
      JSON.stringify(revision.repairHistory || []),
      storageUri || null,
      revision.createdAt || new Date().toISOString(),
      new Date().toISOString(),
    ];

    const result = await client.query<Record<string, unknown>>(query, values);
    if (result.rows.length === 0) {
      const existing = await this.getRevisionById(tenant, revision.revisionId, client);
      if (existing) return existing;
      throw new Error(`Failed to persist revision ${revision.revisionId}`);
    }
    return mapRowToRevision(result.rows[0]);
  }

  /**
   * Retrieves a candidate by ID within tenant isolation boundary.
   */
  async getCandidateById(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<EvolutionCandidate | null> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    const client = db ?? this.pool;
    const query = `
      SELECT * FROM evolution_candidates
      WHERE workspace_id = $1 AND id = $2;
    `;

    const result = await client.query<Record<string, unknown>>(query, [
      tenant.workspaceId,
      candidateId,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return mapRowToCandidate(result.rows[0]);
  }

  /**
   * Retrieves a revision by ID within tenant isolation boundary.
   */
  async getRevisionById(
    tenant: TenantContext,
    revisionId: string,
    db?: Queryable,
  ): Promise<CandidateRevision | null> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    const client = db ?? this.pool;
    const query = `
      SELECT * FROM candidate_revisions
      WHERE workspace_id = $1 AND id = $2;
    `;

    const result = await client.query<Record<string, unknown>>(query, [
      tenant.workspaceId,
      revisionId,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return mapRowToRevision(result.rows[0]);
  }

  /**
   * Lists candidates for a tenant with optional filtering.
   */
  async listCandidates(
    tenant: TenantContext,
    filter: CandidateFilter = {},
    db?: Queryable,
  ): Promise<EvolutionCandidate[]> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    const client = db ?? this.pool;
    const conditions: string[] = [`workspace_id = $1`];
    const params: unknown[] = [tenant.workspaceId];
    let paramIdx = 2;

    if (filter.state) {
      conditions.push(`state = $${paramIdx++}`);
      params.push(filter.state);
    }

    if (filter.opportunityId) {
      conditions.push(`opportunity_id = $${paramIdx++}`);
      params.push(filter.opportunityId);
    }

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    const query = `
      SELECT * FROM evolution_candidates
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset};
    `;

    const result = await client.query<Record<string, unknown>>(query, params);
    return result.rows.map(mapRowToCandidate);
  }

  /**
   * Lists all revisions for a candidate in chronological order.
   */
  async listRevisions(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<CandidateRevision[]> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    const client = db ?? this.pool;
    const query = `
      SELECT * FROM candidate_revisions
      WHERE workspace_id = $1 AND candidate_id = $2
      ORDER BY revision_number ASC;
    `;

    const result = await client.query<Record<string, unknown>>(query, [
      tenant.workspaceId,
      candidateId,
    ]);

    return result.rows.map(mapRowToRevision);
  }

  /**
   * Retrieves active revision for a candidate.
   */
  async getActiveRevision(
    tenant: TenantContext,
    candidateId: string,
    db?: Queryable,
  ): Promise<CandidateRevision | null> {
    const candidate = await this.getCandidateById(tenant, candidateId, db);
    if (!candidate) return null;

    if (candidate.id) {
      const revisions = await this.listRevisions(tenant, candidateId, db);
      if (revisions.length === 0) return null;
      return revisions[revisions.length - 1];
    }

    return null;
  }
}
