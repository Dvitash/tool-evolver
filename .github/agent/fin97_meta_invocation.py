from pathlib import Path

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
print("FIN-97 public-name meta invocation aligned")
