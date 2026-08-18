from pathlib import Path

path = Path("fixtures/e2e/src/topology.ts")
source = path.read_text()
old = '''    if (!res.ok) {
      this.recordProtocolEvent("http", "POST /v1/evolution/candidates/publish", "error");
      throw new Error(`Publish failed with status ${res.status}`);
    }'''
new = '''    if (!res.ok) {
      this.recordProtocolEvent("http", "POST /v1/evolution/candidates/publish", "error");
      const responseBody = await res.text();
      throw new Error(`Publish failed with status ${res.status}: ${responseBody}`);
    }'''
if old in source:
    source = source.replace(old, new, 1)
elif "Publish failed with status ${res.status}: ${responseBody}" not in source:
    raise SystemExit("publish failure block not found")
path.write_text(source)
print("FIN-001 publish diagnostics ready")
