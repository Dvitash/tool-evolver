from pathlib import Path
import re

path = Path("fixtures/e2e/tests/real-process-topology.test.ts")
source = path.read_text()
replacement = 'expect(candidate.proposedTool.name).toMatch(/^[a-z][a-z0-9_]*$/);'
source, count = re.subn(
    r'expect\(candidate\.proposedTool\.name\)\.toBe\(\s*"git_status_checker"\s*,?\s*\);',
    replacement,
    source,
    count=1,
)
if count == 0 and replacement not in source:
    raise SystemExit("candidate-name assertion is neither stale nor already updated")
path.write_text(source)
print("FIN-001 candidate assertion ready")
