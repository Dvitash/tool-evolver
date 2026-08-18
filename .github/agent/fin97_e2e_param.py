from pathlib import Path
p = Path('fixtures/e2e/src/scenarios/happy-path.ts')
s = p.read_text()
old = 'const invocationParameters = { includeDiffSummary: true };'
new = 'const invocationParameters = { path: "." };'
if old not in s:
    raise SystemExit('expected invocation parameter fixture not found')
p.write_text(s.replace(old, new, 1))
