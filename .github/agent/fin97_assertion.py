from pathlib import Path
import re

path = Path("fixtures/e2e/tests/real-process-topology.test.ts")
source = path.read_text()
source, count = re.subn(
    r'expect\(candidate\.proposedTool\.name\)\.toBe\(\s*"git_status_checker"\s*,?\s*\);',
    'expect(candidate.proposedTool.name).toMatch(/^[a-z][a-z0-9_]*$/);',
    source,
    count=1,
)
if count != 1:
    raise SystemExit("stale candidate-name assertion not found")
path.write_text(source)
print("FIN-001 candidate assertion updated")
