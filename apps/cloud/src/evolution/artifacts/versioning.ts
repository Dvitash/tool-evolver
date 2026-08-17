import type { ToolManifest } from "@tool-evolver/contracts";
import type {
  SemanticVersionIncrement,
  VersionDiffReport,
} from "./types.js";

/**
 * Semantic Version Classifier and Manifest Diff Engine.
 * Analyzes structural changes between tool versions to determine appropriate
 * Semantic Versioning increments (major, minor, patch) and produces diff reports.
 */
export class SemanticVersionClassifier {
  /**
   * Compares a candidate manifest against its prior active manifest
   * and produces a detailed VersionDiffReport.
   */
  diffManifests(
    candidateManifest: ToolManifest,
    priorManifest?: ToolManifest,
  ): VersionDiffReport {
    const breakingChanges: string[] = [];
    const contractChanges: string[] = [];

    const schemaChanges = {
      addedParameters: [] as string[],
      removedParameters: [] as string[],
      modifiedParameters: [] as string[],
    };

    const capabilityChanges = {
      addedCapabilities: [] as string[],
      removedCapabilities: [] as string[],
      modifiedCapabilities: [] as string[],
    };

    const dependencyChanges = {
      addedDependencies: [] as string[],
      removedDependencies: [] as string[],
      updatedDependencies: [] as string[],
    };

    if (!priorManifest) {
      const candParams = Object.keys(candidateManifest.parameters?.properties ?? {}).sort();
      const candCaps: string[] = [];
      if (candidateManifest.capabilities) {
        const c = candidateManifest.capabilities;
        if (c.fs?.readPaths?.length) candCaps.push(...c.fs.readPaths.map((p) => `fs:read:${p}`));
        if (c.fs?.writePaths?.length) candCaps.push(...c.fs.writePaths.map((p) => `fs:write:${p}`));
        if (c.net?.allowedHosts?.length) candCaps.push(...c.net.allowedHosts.map((h) => `net:${h}`));
        if (c.command?.allowedCommands?.length) candCaps.push(...c.command.allowedCommands.map((cmd) => `cmd:${cmd}`));
        if (c.secrets?.allowedSecretNames?.length) candCaps.push(...c.secrets.allowedSecretNames.map((s) => `secret:${s}`));
      }

      return {
        previousVersion: undefined,
        newVersion: candidateManifest.version || "1.0.0",
        increment: "major",
        breakingChanges: [],
        schemaChanges: {
          addedParameters: candParams,
          removedParameters: [],
          modifiedParameters: [],
        },
        capabilityChanges: {
          addedCapabilities: candCaps.sort(),
          removedCapabilities: [],
          modifiedCapabilities: [],
        },
        dependencyChanges: {
          addedDependencies: [],
          removedDependencies: [],
          updatedDependencies: [],
        },
        contractChanges: [],
        summary: `Initial release of tool '${candidateManifest.name}' (${candidateManifest.id})`,
      };
    }

    // 1. Parameter schema diffing
    const priorParams = priorManifest.parameters?.properties ?? {};
    const candParams = candidateManifest.parameters?.properties ?? {};
    const priorRequired = new Set(priorManifest.parameters?.required ?? []);
    const candRequired = new Set(candidateManifest.parameters?.required ?? []);

    const priorParamKeys = Object.keys(priorParams);
    const candParamKeys = Object.keys(candParams);

    // Detect removed parameters (Breaking!)
    for (const key of priorParamKeys) {
      if (!(key in candParams)) {
        schemaChanges.removedParameters.push(key);
        breakingChanges.push(`Removed parameter '${key}' from input schema`);
      }
    }

    // Detect added parameters
    for (const key of candParamKeys) {
      if (!(key in priorParams)) {
        schemaChanges.addedParameters.push(key);
        if (candRequired.has(key)) {
          breakingChanges.push(`Added new required parameter '${key}' without default`);
        }
      }
    }

    // Detect modified parameters
    for (const key of priorParamKeys) {
      if (key in candParams) {
        const pProp = priorParams[key] as { type?: string; description?: string; enum?: unknown[] } | undefined;
        const cProp = candParams[key] as { type?: string; description?: string; enum?: unknown[] } | undefined;

        let modified = false;

        // Type changed (Breaking!)
        if (pProp?.type && cProp?.type && pProp.type !== cProp.type) {
          modified = true;
          breakingChanges.push(`Parameter '${key}' type changed from '${pProp.type}' to '${cProp.type}'`);
        }

        // Required status changed (Optional -> Required is breaking!)
        if (!priorRequired.has(key) && candRequired.has(key)) {
          modified = true;
          breakingChanges.push(`Parameter '${key}' changed from optional to required`);
        }

        if (pProp?.description !== cProp?.description) {
          modified = true;
        }

        if (modified) {
          schemaChanges.modifiedParameters.push(key);
        }
      }
    }

    // 2. Capability diffing
    const extractCaps = (m: ToolManifest): Set<string> => {
      const set = new Set<string>();
      const c = m.capabilities;
      if (c) {
        for (const p of c.fs?.readPaths ?? []) set.add(`fs:read:${p}`);
        for (const p of c.fs?.writePaths ?? []) set.add(`fs:write:${p}`);
        for (const h of c.net?.allowedHosts ?? []) set.add(`net:${h}`);
        for (const cmd of c.command?.allowedCommands ?? []) set.add(`cmd:${cmd}`);
        for (const s of c.secrets?.allowedSecretNames ?? []) set.add(`secret:${s}`);
        if (c.command?.allowShellExecution) set.add("cmd:shell");
        if (c.net?.allowOutbound) set.add("net:all_outbound");
      }
      return set;
    };

    const priorCaps = extractCaps(priorManifest);
    const candCaps = extractCaps(candidateManifest);

    for (const cap of priorCaps) {
      if (!candCaps.has(cap)) {
        capabilityChanges.removedCapabilities.push(cap);
        breakingChanges.push(`Removed capability '${cap}'`);
      }
    }

    for (const cap of candCaps) {
      if (!priorCaps.has(cap)) {
        capabilityChanges.addedCapabilities.push(cap);
      }
    }

    // 3. Output schema & contract check
    const priorOutType = priorManifest.outputSchema?.type;
    const candOutType = candidateManifest.outputSchema?.type;
    if (priorOutType && candOutType && priorOutType !== candOutType) {
      breakingChanges.push(`Output schema type changed from '${priorOutType}' to '${candOutType}'`);
    }

    // 4. Determine increment
    let increment: SemanticVersionIncrement = "patch";
    if (breakingChanges.length > 0) {
      increment = "major";
    } else if (
      schemaChanges.addedParameters.length > 0 ||
      capabilityChanges.addedCapabilities.length > 0 ||
      dependencyChanges.addedDependencies.length > 0
    ) {
      increment = "minor";
    } else {
      increment = "patch";
    }

    const nextVersion = this.computeNextVersion(priorManifest.version, increment, candidateManifest.version);

    const summaryParts: string[] = [];
    if (breakingChanges.length > 0) {
      summaryParts.push(`Major bump (${increment}): ${breakingChanges.length} breaking changes detected.`);
    } else if (increment === "minor") {
      summaryParts.push(`Minor bump (${increment}): backward-compatible features and additions.`);
    } else {
      summaryParts.push(`Patch bump (${increment}): backward-compatible fixes and internal updates.`);
    }

    return {
      previousVersion: priorManifest.version,
      newVersion: nextVersion,
      increment,
      breakingChanges,
      schemaChanges,
      capabilityChanges,
      dependencyChanges,
      contractChanges,
      summary: summaryParts.join(" "),
    };
  }

  /**
   * Classifies version increment and returns diff report.
   */
  classifyIncrement(
    candidateManifest: ToolManifest,
    priorManifest?: ToolManifest,
  ): VersionDiffReport {
    return this.diffManifests(candidateManifest, priorManifest);
  }

  /**
   * Computes next semantic version given a prior version string and an increment type.
   */
  computeNextVersion(
    priorVersion: string | undefined,
    increment: SemanticVersionIncrement,
    candidateVersion?: string,
  ): string {
    if (!priorVersion) {
      return candidateVersion || "1.0.0";
    }

    const match = priorVersion.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (!match) {
      return candidateVersion || "1.0.0";
    }

    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const patch = parseInt(match[3], 10);
    const suffix = match[4] || "";

    switch (increment) {
      case "major":
        return `${major + 1}.0.0${suffix}`;
      case "minor":
        return `${major}.${minor + 1}.0${suffix}`;
      case "patch":
      default:
        return `${major}.${minor}.${patch + 1}${suffix}`;
    }
  }
}

/**
 * Factory helper for SemanticVersionClassifier.
 */
export function createSemanticVersionClassifier(): SemanticVersionClassifier {
  return new SemanticVersionClassifier();
}
