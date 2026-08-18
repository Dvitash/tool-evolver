from pathlib import Path

# Align E2E invocation with the public-name contract and a valid optional input.
path = Path("fixtures/e2e/src/scenarios/happy-path.ts")
text = path.read_text()
text = text.replace(
    'const nativeOutcome = await env.invokeTool(toolName, {});',
    'const invocationParameters = { includeDiffSummary: true };\n  const nativeOutcome = await env.invokeTool(toolName, invocationParameters);',
)
text = text.replace(
    '''  const invokeOutcome = await env.invokeTool(SYSTEM_META_TOOL_NAMES.INVOKE_TOOL, {
    toolId: candidate.proposedTool.id,
    name: toolName,
    parameters: {},
  });''',
    '''  const invokeOutcome = await env.invokeTool(SYSTEM_META_TOOL_NAMES.INVOKE_TOOL, {
    name: toolName,
    parameters: invocationParameters,
  });''',
)
text = text.replace(
    '''        invokeSuccess: invokeOutcome.success,
      },''',
    '''        invokeSuccess: invokeOutcome.success,
        invokeOutcome: invokeOutcome.content,
      },''',
)
path.write_text(text)

# Make invoke_tool distinguish true identifier conflicts, preserve stale-ID fallback,
# and report disabled tools without exposing tools from another workspace.
path = Path("apps/gateway/src/meta/invoke-tool.ts")
text = path.read_text()
old = '''function isSameLogicalTool(left: RegistryTool, right: RegistryTool): boolean {
  return (
    left.toolId === right.toolId ||
    left.name === right.name ||
    left.exposedName === right.exposedName ||
    left.name === right.exposedName ||
    left.exposedName === right.name
  );
}'''
new = '''function isSameLogicalTool(left: RegistryTool, right: RegistryTool): boolean {
  if (left.toolId === right.toolId) {
    return true;
  }

  const leftManifestId = left.manifest?.id;
  const rightManifestId = right.manifest?.id;
  return Boolean(leftManifestId && rightManifestId && leftManifestId === rightManifestId);
}'''
if old not in text:
    raise SystemExit("invoke_tool logical identity block not found")
text = text.replace(old, new)
old = '''    const byId = toolId
      ? await registry.getTool(toolId, context.workspaceId, context.sessionId)
      : undefined;

    if (byName && byId && !isSameLogicalTool(byName, byId)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Conflicting tool identifiers: name '${publicName}' and toolId '${toolId}' resolve to different tools.`,
          },
        ],
      };
    }

    let resolvedTool = byName ?? byId;
    if (!resolvedTool) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${displayIdentifier}' not found or not accessible in workspace '${context.workspaceId}'.`,
          },
        ],
      };
    }
'''
new = '''    const byId = toolId
      ? await registry.getTool(toolId, context.workspaceId, context.sessionId)
      : undefined;

    const controls = await registry.controls.getControls(context.workspaceId);
    const findDisabledScopedTool = (identifier: string | undefined): RegistryTool | undefined => {
      if (!identifier) {
        return undefined;
      }
      return registry.getAllRegisteredTools().find(
        (tool) =>
          !tool.isSystem &&
          controls.disabledTools.includes(tool.toolId) &&
          isToolInScope(tool, context) &&
          (tool.toolId === identifier || tool.name === identifier || tool.exposedName === identifier),
      );
    };

    const disabledByName = byName ? undefined : findDisabledScopedTool(publicName);
    const disabledById = byId ? undefined : findDisabledScopedTool(toolId);
    const resolvedByName = byName ?? disabledByName;
    const resolvedById = byId ?? disabledById;

    if (resolvedByName && resolvedById && !isSameLogicalTool(resolvedByName, resolvedById)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Conflicting tool identifiers: name '${publicName}' and toolId '${toolId}' resolve to different tools.`,
          },
        ],
      };
    }

    let resolvedTool = byName ?? byId ?? disabledByName ?? disabledById;
    if (!resolvedTool) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${displayIdentifier}' not found or not accessible in workspace '${context.workspaceId}'.`,
          },
        ],
      };
    }
'''
if old not in text:
    raise SystemExit("invoke_tool resolution block not found")
text = text.replace(old, new)
text = text.replace(
    '    const controls = await registry.controls.getControls(context.workspaceId);\n    const isDisabled =',
    '    const isDisabled =',
)
path.write_text(text)

# Legacy pure-compute fixture used zero as a sentinel for no filesystem access,
# but CapabilityEnvelope requires a positive byte limit. Empty paths + disabled
# workspace/temp access already represent no filesystem capability.
path = Path("apps/cloud/tests/evolution/generator/helpers.ts")
text = path.read_text()
old = '''      maxFileSizeBytes:
        overrides.fs?.maxFileSizeBytes ?? legacy?.fs?.maxFileSizeBytes ?? 10_485_760,'''
new = '''      maxFileSizeBytes: Math.max(
        1,
        overrides.fs?.maxFileSizeBytes ?? legacy?.fs?.maxFileSizeBytes ?? 10_485_760,
      ),'''
if old not in text:
    raise SystemExit("legacy maxFileSizeBytes block not found")
text = text.replace(old, new)
path.write_text(text)

print("FIN-97 final corrections materialized")
