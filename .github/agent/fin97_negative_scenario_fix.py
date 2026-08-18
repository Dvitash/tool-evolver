from pathlib import Path

path = Path("apps/cloud/src/evolution/replay/scenario-builder.ts")
source = path.read_text()

old = '''    if (targetFile || hasFiles) {'''
new = '''    if (hasFsCapability && (targetFile || hasFiles)) {'''
if old in source:
    source = source.replace(old, new, 1)
elif new not in source:
    raise SystemExit("filesystem negative-scenario condition not found")

old = '''    if (hasNetRoutes || hasUrlInput || hasNetCapability) {'''
new = '''    if (hasNetCapability && (hasNetRoutes || hasUrlInput || hasNetCapability)) {'''
if old in source:
    source = source.replace(old, new, 1)
elif new not in source:
    raise SystemExit("network negative-scenario condition not found")

# Declared capabilities are the authority boundary. Incidental strings in input or
# virtual fixture state must not manufacture broker-specific failure requirements.
path.write_text(source)
print("FIN-001 replay negatives scoped to declared capabilities")
