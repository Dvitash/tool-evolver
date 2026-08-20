import type { ToolOutputSchema } from "@tool-evolver/contracts";
import type { WorkflowContract } from "../opportunity/types.js";
import type { WorkflowCoverage, WorkflowStep } from "./types.js";

/**
 * Build deterministic coverage of a WorkflowContract by a set of WorkflowSteps and an outputSchema.
 * Coverage is complete only when every contract operation and every required output is represented.
 * Returns undefined when contract is undefined (legacy opportunity).
 */
export function buildWorkflowCoverage(
  contract: WorkflowContract | undefined,
  steps: WorkflowStep[],
  outputSchema: ToolOutputSchema | Record<string, unknown> | undefined,
): WorkflowCoverage | undefined {
  if (!contract) return undefined;

  const operations = [...contract.operations].sort((a, b) => a.order - b.order);

  const operationCoverage: WorkflowCoverage["operationCoverage"] = operations.map((op) => {
    const stepIds = steps
      .filter((step) => Array.isArray(step.coveredOperationIds) && step.coveredOperationIds.includes(op.id))
      .map((step) => step.id);
    // Deterministic: sort stepIds
    stepIds.sort();
    return { operationId: op.id, stepIds };
  });

  const uncoveredOperationIds = operationCoverage
    .filter((entry) => entry.stepIds.length === 0)
    .map((entry) => entry.operationId);

  // Output coverage: one entry per contract output requirement, sorted by outputName for determinism
  const sortedRequirements = [...contract.outputRequirements].sort((a, b) => a.name.localeCompare(b.name));

  const outputCoverage: WorkflowCoverage["outputCoverage"] = sortedRequirements.map((req) => {
    const schemaPaths = findSchemaPaths(req.name, outputSchema);
    return {
      outputName: req.name,
      schemaPaths,
      sourceOperationIds: [req.sourceOperationId],
    };
  });

  const uncoveredOutputNames = outputCoverage
    .filter((entry) => {
      if (entry.schemaPaths.length !== 0) return false;
      const req = contract.outputRequirements.find((r) => r.name === entry.outputName);
      // Only required outputs count toward incompleteness
      return req ? req.required : true;
    })
    .map((entry) => entry.outputName);

  const complete = uncoveredOperationIds.length === 0 && uncoveredOutputNames.length === 0;

  return {
    operationCoverage,
    outputCoverage,
    uncoveredOperationIds,
    uncoveredOutputNames,
    complete,
  };
}

/**
 * Produce deterministic diagnostics for missing coverage.
 * Empty array when coverage is complete or when coverage is undefined (legacy).
 */
export function workflowCoverageDiagnostics(coverage: WorkflowCoverage | undefined): string[] {
  if (!coverage) return [];
  const diagnostics: string[] = [];
  const sortedUncoveredOps = [...coverage.uncoveredOperationIds].sort();
  const sortedUncoveredOutputs = [...coverage.uncoveredOutputNames].sort();

  for (const opId of sortedUncoveredOps) {
    diagnostics.push(`Missing operation coverage: ${opId} (no step covers this operation)`);
  }
  for (const outName of sortedUncoveredOutputs) {
    diagnostics.push(`Missing output coverage: ${outName} (required output not in outputSchema)`);
  }
  if (!coverage.complete && diagnostics.length === 0) {
    diagnostics.push("Coverage incomplete: unknown missing mappings");
  }
  diagnostics.sort();
  return diagnostics;
}

function findSchemaPaths(
  outputName: string,
  schema: ToolOutputSchema | Record<string, unknown> | undefined,
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const paths: string[] = [];
  const s = schema as Record<string, unknown>;

  const properties = s.properties as Record<string, unknown> | undefined;
  if (properties && typeof properties === "object") {
    if (Object.prototype.hasOwnProperty.call(properties, outputName)) {
      paths.push(`properties.${outputName}`);
    }
    // Nested under `data` wrapper pattern (common for tool outputs)
    const dataSection = properties.data as Record<string, unknown> | undefined;
    if (dataSection && typeof dataSection === "object") {
      const dataProps = (dataSection as Record<string, unknown>).properties as Record<string, unknown> | undefined;
      if (dataProps && typeof dataProps === "object" && Object.prototype.hasOwnProperty.call(dataProps, outputName)) {
        paths.push(`properties.data.properties.${outputName}`);
      }
    }
    // Support for schema being { data: { properties: { ... } } } alternative
    const innerData = s.data as Record<string, unknown> | undefined;
    if (innerData && typeof innerData === "object") {
      const innerProps = (innerData as Record<string, unknown>).properties as Record<string, unknown> | undefined;
      if (innerProps && typeof innerProps === "object" && Object.prototype.hasOwnProperty.call(innerProps, outputName)) {
        paths.push(`data.properties.${outputName}`);
      }
    }
  }

  // Check for schema having top-level required includes output
  const required = s.required as unknown;
  if (Array.isArray(required) && required.includes(outputName) && paths.length === 0) {
    // If required mentions output but not in properties, still treat as missing? But be permissive
  }

  // Also support schema being a plain Record with outputName at top-level (rare)
  if (s[outputName] !== undefined && paths.length === 0) {
    paths.push(`${outputName}`);
  }

  // Also check for nested outputSchema wrapped in `schema` field
  const rawSchema = s.schema as Record<string, unknown> | undefined;
  if (rawSchema && typeof rawSchema === "object") {
    const rawProps = rawSchema.properties as Record<string, unknown> | undefined;
    if (rawProps && typeof rawProps === "object") {
      if (Object.prototype.hasOwnProperty.call(rawProps, outputName)) {
        paths.push(`schema.properties.${outputName}`);
      }
      const rawData = (rawProps.data as Record<string, unknown> | undefined);
      if (rawData && typeof rawData === "object") {
        const rawDataProps = (rawData as Record<string, unknown>).properties as Record<string, unknown> | undefined;
        if (rawDataProps && typeof rawDataProps === "object" && Object.prototype.hasOwnProperty.call(rawDataProps, outputName)) {
          paths.push(`schema.properties.data.properties.${outputName}`);
        }
      }
    }
  }

  // Also support schema being a plain Record with outputName at top-level (rare)
  // No additional handling needed.

  return paths;
}
