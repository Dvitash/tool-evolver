from pathlib import Path
import re


def edit(path: str, transform):
    p = Path(path)
    source = p.read_text()
    updated = transform(source)
    if updated == source:
        raise SystemExit(f"no change made to {path}")
    p.write_text(updated)


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        if new in source:
            return source
        raise SystemExit(f"missing marker: {label}")
    return source.replace(old, new, 1)


# Preserve deterministic, non-secret command profiles as part of the opportunity contract.
def patch_types(source: str) -> str:
    return replace_once(
        source,
        "  suggestedToolName?: string;\n  provenance?: Record<string, unknown>;",
        "  suggestedToolName?: string;\n  commandProfiles?: string[];\n  provenance?: Record<string, unknown>;",
        "OpportunityClassification.commandProfiles",
    )


edit("apps/cloud/src/evolution/opportunity/types.ts", patch_types)


def patch_signature(source: str) -> str:
    insertion = '''
/**
 * Normalizes an observed command into a stable, non-shell command profile.
 * Paths are reduced to semantic aliases while executable, subcommand, and flags remain exact.
 */
export function normalizeCommandProfile(rawCommand: string): string {
  const normalized = rawCommand.replace(/[\\r\\n\\0]/g, " ").trim().replace(/\\s+/g, " ");
  if (!normalized) return "";

  return normalized
    .split(" ")
    .slice(0, 32)
    .map((part, index) => {
      if (index === 0) {
        const portable = part.replace(/\\\\/g, "/");
        return portable.slice(portable.lastIndexOf("/") + 1).toLowerCase();
      }
      if (part.startsWith("-")) return part;
      if (part.includes("/") || /\\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java)$/i.test(part)) {
        return normalizePathAlias(part);
      }
      return part;
    })
    .join(" ");
}
'''
    marker = '''function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}
'''
    if "export function normalizeCommandProfile" not in source:
        source = replace_once(source, marker, marker + insertion, "normalizeCommandProfile insertion")

    old_tool = '''        const cls = classifyToolOrCommand(toolEvt.toolName);
        toolClasses.push(cls);

        const argHash = extractArgumentShape(toolEvt.parameters);'''
    new_tool = '''        const rawCommand =
          toolEvt.parameters && typeof toolEvt.parameters === "object"
            ? ((toolEvt.parameters as Record<string, unknown>).command ??
              (toolEvt.parameters as Record<string, unknown>).cmd ??
              (toolEvt.parameters as Record<string, unknown>).executable)
            : undefined;
        const commandText = typeof rawCommand === "string" ? rawCommand : undefined;
        const cls = classifyToolOrCommand(toolEvt.toolName, commandText);
        toolClasses.push(cls);
        if (commandText) {
          const commandProfile = normalizeCommandProfile(commandText);
          if (commandProfile) commandPatterns.push(commandProfile);
        }

        const argHash = extractArgumentShape(toolEvt.parameters);'''
    source = replace_once(source, old_tool, new_tool, "tool-call command classification")

    old_exec = '''        // Normalize command pattern: e.g. "pnpm test" -> "pnpm:test"
        const parts = cmdEvt.command.trim().split(/\\s+/).slice(0, 3);
        commandPatterns.push(parts.join(":"));'''
    new_exec = '''        const commandProfile = normalizeCommandProfile(
          [cmdEvt.command, ...(cmdEvt.args ?? [])].join(" "),
        );
        if (commandProfile) commandPatterns.push(commandProfile);'''
    source = replace_once(source, old_exec, new_exec, "command-exec profile")

    source = replace_once(
        source,
        '''    const structuralDescriptor = {
      ops: operationSequence,
      classes: toolClasses,
      args: argumentShapeHashes,
    };''',
        '''    const structuralDescriptor = {
      ops: operationSequence,
      classes: toolClasses,
      commands: commandPatterns,
      args: argumentShapeHashes,
    };''',
        "command profiles in structural hash",
    )
    return source


edit("apps/cloud/src/evolution/opportunity/signature.ts", patch_signature)


def patch_classifier(source: str) -> str:
    source = replace_once(
        source,
        "  const inferredInputs: OpportunityInferredInput[] = [];\n",
        "  const inferredInputs: OpportunityInferredInput[] = [];\n  const commandProfiles = [...sig.commandPatterns];\n",
        "classifier command profiles",
    )
    source = replace_once(
        source,
        '''  if (sig.toolClasses.includes("test_runner")) {''',
        '''  if (sig.toolClasses.includes("vcs")) {
    const profile = commandProfiles[0] ?? "git status --porcelain";
    title = profile.startsWith("git status")
      ? "Inspect Git Working Tree Status"
      : "Automate Repeated Git Operation";
    pattern = `vcs_${profile.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")}`;
    suggestedToolName = profile.startsWith("git status") ? "git_status_checker" : "git_operation_helper";
    description = `Executes the observed immutable command profile: ${profile}.`;
  } else if (sig.toolClasses.includes("test_runner")) {''',
        "classifier vcs branch",
    )
    source = replace_once(
        source,
        '    taskClass: "opportunity_detection",',
        "    taskClass: primaryClass,",
        "classifier deterministic task class",
    )
    source = replace_once(
        source,
        "    suggestedToolName,\n    candidateOutputSchema:",
        "    suggestedToolName,\n    commandProfiles,\n    candidateOutputSchema:",
        "classifier return profiles",
    )
    source = replace_once(
        source,
        "          suggestedToolName: fallback.suggestedToolName,\n          provenance:",
        "          suggestedToolName: fallback.suggestedToolName,\n          commandProfiles: fallback.commandProfiles,\n          provenance:",
        "inference preserves deterministic profiles",
    )
    return source


edit("apps/cloud/src/evolution/opportunity/classifier.ts", patch_classifier)


def patch_opportunity_service(source: str) -> str:
    old = '''      const classification = await this.classifier.classifyOpportunity(
        accountId,
        cluster,
        triggerResult.reason,
      );'''
    new = '''      const classification = await this.classifier.classifyOpportunity(
        accountId,
        cluster,
        triggerResult.reason,
      );
      // Command profiles are deterministic evidence, not model-authored capability requests.
      classification.commandProfiles = [...cluster.representativeSignature.commandPatterns];'''
    return replace_once(source, old, new, "deterministic command profile assignment")


edit("apps/cloud/src/evolution/opportunity/service.ts", patch_opportunity_service)


def patch_planner(source: str) -> str:
    marker = '''    if (
      opportunity.classification.taskClass === "multi_step" ||
      opportunity.classification.pattern.includes("->")
    ) {'''
    insertion = '''    if (opportunity.classification.commandProfiles?.length) {
      for (let index = variableInputs.length - 1; index >= 0; index--) {
        if (["command", "cmd", "args"].includes(variableInputs[index]!.name.toLowerCase())) {
          variableInputs.splice(index, 1);
        }
      }
    }

'''
    if insertion.strip() not in source:
        source = replace_once(source, marker, insertion + marker, "remove dynamic command inputs")

    old = '''      const defaultCmd =
        envelope?.command.allowedCommands[0] || envelope?.command.allowedBinaries[0] || "echo";
      inputs.command = inputs.command || defaultCmd;
      inputs.toolClass = "command";'''
    new = '''      const inferredDefault = opportunity.classification.inferredInputs?.find(
        (input) => ["command", "cmd"].includes(input.name.toLowerCase()),
      )?.default;
      const descriptiveText = `${opportunity.classification.title} ${opportunity.classification.description}`.toLowerCase();
      const commandProfile =
        opportunity.classification.commandProfiles?.[0] ||
        (typeof inferredDefault === "string" ? inferredDefault : undefined) ||
        envelope?.command.allowedCommands[0] ||
        envelope?.command.allowedBinaries[0] ||
        (descriptiveText.includes("git status") ? "git status --porcelain" : undefined);
      if (!commandProfile || commandProfile.startsWith("$")) {
        throw new Error(
          "Command candidates require an observed immutable command profile or an explicitly approved envelope command",
        );
      }
      const [executable, ...commandArgs] = commandProfile.trim().split(/\\s+/);
      if (!executable) throw new Error("Command profile has no executable");
      inputs.command = executable;
      inputs.args = commandArgs;
      inputs.commandProfile = commandProfile;
      inputs.toolClass = "command";'''
    source = replace_once(source, old, new, "fixed command profile planning")
    return source


edit("apps/cloud/src/evolution/generator/planner.ts", patch_planner)


def patch_capability_mapper(source: str) -> str:
    old = '''        const commandVal = step.inputs.command ?? step.inputs.cmd ?? step.inputs.binary;
        if (typeof commandVal === "string" && commandVal.trim().length > 0) {
          const fullCmd = commandVal.trim();
          const binary = fullCmd.split(/\\s+/)[0];
          if (binary && !cmdCap.allowedBinaries.includes(binary)) {
            cmdCap.allowedBinaries.push(binary);
          }
          if (fullCmd && !cmdCap.allowedCommands.includes(fullCmd)) {
            cmdCap.allowedCommands.push(fullCmd);
          }
          if (binary && !cmdCap.allowedCommands.includes(binary)) {
            cmdCap.allowedCommands.push(binary);
          }
        }'''
    new = '''        const commandVal = step.inputs.command ?? step.inputs.cmd ?? step.inputs.binary;
        if (typeof commandVal === "string" && commandVal.trim().length > 0) {
          if (commandVal.trim().startsWith("$")) {
            throw new Error("Dynamic command placeholders cannot be converted into capabilities");
          }
          const commandArgs = Array.isArray(step.inputs.args)
            ? step.inputs.args.filter((value): value is string => typeof value === "string")
            : [];
          const binary = commandVal.trim().split(/\\s+/)[0];
          const fullCmd = [commandVal.trim(), ...commandArgs].join(" ").trim();
          if (binary && !cmdCap.allowedBinaries.includes(binary)) {
            cmdCap.allowedBinaries.push(binary);
          }
          if (fullCmd && !cmdCap.allowedCommands.includes(fullCmd)) {
            cmdCap.allowedCommands.push(fullCmd);
          }
        }'''
    return replace_once(source, old, new, "capability command profile")


edit("apps/cloud/src/evolution/generator/capability-mapper.ts", patch_capability_mapper)


def patch_codegen(source: str) -> str:
    old_header = '''      const commandName =
        plan.capabilities.command.allowedCommands[0] ||
        (step?.inputs.command as string | undefined) ||
        "echo 'done'";

      const secretName = plan.capabilities.secrets.allowedSecretNames[0];'''
    new_header = '''      const commandName =
        (step?.inputs.command as string | undefined) ||
        plan.capabilities.command.allowedBinaries[0];
      const commandArgs = Array.isArray(step?.inputs.args)
        ? step.inputs.args.filter((value): value is string => typeof value === "string")
        : [];
      if (!commandName || commandName.startsWith("$")) {
        throw new Error("Command source generation requires a fixed executable identity");
      }

      const secretName = plan.capabilities.secrets.allowedSecretNames[0];'''
    source = replace_once(source, old_header, new_header, "codegen fixed command header")

    dynamic = '''      const command = (input as Record<string, unknown>).command as string ?? (input as Record<string, unknown>).cmd as string ?? ${JSON.stringify(commandName)};
      const args = ((input as Record<string, unknown>).args as string[]) ?? [];'''
    fixed = '''      const command = ${JSON.stringify(commandName)};
      const args = ${JSON.stringify(commandArgs)};'''
    count = source.count(dynamic)
    if count != 2:
        if source.count(fixed) != 2:
            raise SystemExit(f"expected two dynamic command blocks, found {count}")
    else:
        source = source.replace(dynamic, fixed)
    return source


edit("apps/cloud/src/evolution/generator/code-generator.ts", patch_codegen)


def patch_scenario_builder(source: str) -> str:
    pattern = re.compile(
        r"  private deriveAllowedBrokerOperations\(candidate: CandidateTarget\): AllowedBrokerOperation\[] \{.*?\n  \}\n\n  /\*\*\n   \* Formulates primary invariants",
        re.S,
    )
    replacement = '''  private deriveAllowedBrokerOperations(candidate: CandidateTarget): AllowedBrokerOperation[] {
    const allowed: AllowedBrokerOperation[] = [];
    const caps =
      "requiredCapabilities" in candidate && candidate.requiredCapabilities
        ? candidate.requiredCapabilities
        : undefined;
    if (!caps) return allowed;

    const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");

    const fsPaths = [...(caps.fs.readPaths ?? []), ...(caps.fs.writePaths ?? [])];
    if (fsPaths.length > 0 || caps.fs.allowWorkspaceRoot || caps.fs.allowTemp) {
      allowed.push({
        service: "fs",
        operation: "*",
        pathPattern:
          fsPaths.length > 0 ? fsPaths.map(escapeRegex).join("|") : caps.fs.allowWorkspaceRoot ? ".*" : "^/tmp(?:/|$)",
      });
    }

    if (caps.net.allowOutbound || caps.net.allowLocalhost) {
      const hosts = [...(caps.net.allowedHosts ?? []), ...(caps.net.allowedDomains ?? [])];
      allowed.push({
        service: "net",
        operation: "*",
        urlPattern: hosts.length > 0 ? hosts.map(escapeRegex).join("|") : "(?!)",
      });
    }

    const commandProfiles = (caps.command.allowedCommands ?? []).filter(
      (value) => value && !value.startsWith("$"),
    );
    const commandBinaries = (caps.command.allowedBinaries ?? []).filter(
      (value) => value && !value.startsWith("$"),
    );
    if (caps.command.allowShellExecution || commandProfiles.length > 0 || commandBinaries.length > 0) {
      const commandPattern = caps.command.allowShellExecution
        ? ".*"
        : `^(?:${[
            ...commandProfiles.map((value) => escapeRegex(value)),
            ...commandBinaries.map((value) => `${escapeRegex(value)}(?:\\\\s|$)`),
          ].join("|")})`;
      allowed.push({ service: "cmd", operation: "*", commandPattern });
    }

    if (
      (caps.secrets.allowedSecretNames?.length ?? 0) > 0 ||
      (caps.secrets.allowedPrefixes?.length ?? 0) > 0
    ) {
      allowed.push({ service: "secret", operation: "createReference" });
    }

    return allowed;
  }

  /**
   * Formulates primary invariants'''
    updated, count = pattern.subn(replacement, source, count=1)
    if count != 1:
        if "const commandProfiles = (caps.command.allowedCommands" not in source:
            raise SystemExit("deriveAllowedBrokerOperations method not found")
        return source
    return updated


edit("apps/cloud/src/evolution/replay/scenario-builder.ts", patch_scenario_builder)


def patch_comparator(source: str) -> str:
    old = '''        if (
          op.service === "cmd" &&
          a.commandPattern &&
          op.args[0] &&
          typeof op.args[0] === "string"
        ) {
          if (!new RegExp(a.commandPattern).test(op.args[0])) return false;
        }'''
    new = '''        if (
          op.service === "cmd" &&
          a.commandPattern &&
          op.args[0] &&
          typeof op.args[0] === "string"
        ) {
          const commandArgs = Array.isArray(op.args[1])
            ? op.args[1].filter((value): value is string => typeof value === "string")
            : [];
          const commandProfile = [op.args[0], ...commandArgs].join(" ").trim();
          if (!new RegExp(a.commandPattern).test(commandProfile)) return false;
        }'''
    source = replace_once(source, old, new, "comparator full command profile")
    source = replace_once(
        source,
        '''          details: {
            service: op.service,
            operation: op.operation,
            args: op.args,
          },''',
        '''          details: {
            service: op.service,
            operation: op.operation,
            args: op.args,
            allowedBrokerOperations: allowed,
          },''',
        "replay authorization diagnostics",
    )
    return source


edit("apps/cloud/src/evolution/replay/comparator.ts", patch_comparator)


def patch_signature_tests(source: str) -> str:
    source = replace_once(
        source,
        "  normalizePathAlias,\n} from",
        "  normalizeCommandProfile,\n  normalizePathAlias,\n} from",
        "signature test import",
    )
    source = replace_once(
        source,
        '    expect(classifyToolOrCommand("bash")).toBe("shell_exec");',
        '    expect(classifyToolOrCommand("bash")).toBe("shell_exec");\n    expect(classifyToolOrCommand("bash", "git status --porcelain")).toBe("vcs");\n    expect(normalizeCommandProfile("/usr/bin/git   status --porcelain")).toBe(\n      "git status --porcelain",\n    );',
        "signature command assertions",
    )
    return source


edit("apps/cloud/tests/evolution/opportunity/signature.test.ts", patch_signature_tests)


def patch_planner_tests(source: str) -> str:
    source = replace_once(
        source,
        '''        inferredInputs: [
          { name: "command", type: "string", description: "Git subcommand to execute" },
        ],''',
        '''        inferredInputs: [
          { name: "command", type: "string", description: "Git subcommand to execute" },
        ],
        commandProfiles: ["git status --porcelain"],''',
        "planner test command profile",
    )
    source = replace_once(
        source,
        '''    expect(plan.steps[0].toolClass).toBe("command");''',
        '''    expect(plan.steps[0].toolClass).toBe("command");
    expect(plan.steps[0].inputs.command).toBe("git");
    expect(plan.steps[0].inputs.args).toEqual(["status", "--porcelain"]);
    expect(plan.variableInputs.some((input) => input.name === "command")).toBe(false);''',
        "planner fixed command assertions",
    )
    return source


edit("apps/cloud/tests/evolution/generator/planner.test.ts", patch_planner_tests)

print("FIN-001 immutable command profiles and replay authorization ready")
