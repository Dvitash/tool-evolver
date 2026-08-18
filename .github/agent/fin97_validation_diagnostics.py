from pathlib import Path

path = Path("apps/cloud/src/evolution/lifecycle/orchestrator.ts")
source = path.read_text()
old = '''      throw new Error(`Candidate validation failed with state '${valRecord.currentState}'`);'''
new = '''      const validationDiagnostics =
        valRecord.terminalReason?.details ?? valRecord.validationResult ?? {};
      throw new Error(
        `Candidate validation failed with state '${valRecord.currentState}': ${JSON.stringify(validationDiagnostics)}`,
      );'''
if old in source:
    source = source.replace(old, new, 1)
elif "const validationDiagnostics =" not in source:
    raise SystemExit("driveToCompletion validation failure block not found")
path.write_text(source)
print("FIN-001 validation diagnostics ready")
