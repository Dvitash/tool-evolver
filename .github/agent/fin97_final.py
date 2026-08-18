from pathlib import Path
import re
R=Path.cwd()
def edit(p,fn):
 q=R/p;s=q.read_text();n=fn(s)
 if n==s: raise SystemExit('no change '+p)
 q.write_text(n)

# Version allocation follows latest immutable version while activation follows prior active.
def svc(s):
 old='''    const priorActiveVersion = await this.toolRegistryRepo.getLatestActiveVersion(\n      tenant,\n      candidate.proposedTool.id,\n    );\n    const diffReport = this.versioning.diffManifests(\n      candidate.proposedTool,\n      priorActiveVersion ? priorActiveVersion.manifest : undefined,\n    );'''
 new='''    const priorActiveVersion = await this.toolRegistryRepo.getLatestActiveVersion(\n      tenant,\n      candidate.proposedTool.id,\n    );\n    const existingVersions = await this.toolRegistryRepo.listToolVersions(\n      tenant,\n      candidate.proposedTool.id,\n    );\n    const priorVersion = existingVersions[0] ?? priorActiveVersion;\n    const diffReport = this.versioning.diffManifests(\n      candidate.proposedTool,\n      priorVersion ? priorVersion.manifest : undefined,\n    );'''
 if old not in s: raise SystemExit('svc marker')
 s=s.replace(old,new,1)
 s=s.replace('''          priorActiveVersion?.version,\n          options.targetVersionIncrement,''','''          priorVersion?.version,\n          options.targetVersionIncrement,''',1)
 s=s.replace('''        targetVersion = diffReport.newVersion;''','''        targetVersion = priorVersion\n          ? this.versioning.computeNextVersion(priorVersion.version, diffReport.increment, candidate.proposedTool.version)\n          : diffReport.newVersion;''',1)
 return s
edit('apps/cloud/src/evolution/artifacts/service.ts',svc)

# Doctor repair can receive deterministic probe injection for tests and explicit callers.
def doctor(s):
 s=s.replace('''    isRepair?: boolean;\n  } = {},''','''    isRepair?: boolean;\n    safetyCertification?: LocalSafetyCertificationOptions;\n  } = {},''',1)
 s=s.replace('''        customFetch: options.customFetch,\n      });''','''        customFetch: options.customFetch,\n        safetyCertification: options.safetyCertification,\n      });''',1)
 s=s.replace('''    customFetch?: typeof fetch;\n  } = {},\n): Promise<number> {\n  return doctorCommand(args, { ...options, isRepair: true });''','''    customFetch?: typeof fetch;\n    safetyCertification?: LocalSafetyCertificationOptions;\n  } = {},\n): Promise<number> {\n  return doctorCommand(args, { ...options, isRepair: true });''',1)
 return s
edit('apps/cli/src/commands/doctor.ts',doctor)

# Publication tests: draft/latest only until promotion; drafts are not rollback targets.
def art_test(s):
 s=s.replace('expect(publishedVersion.status).toBe("active");','expect(publishedVersion.status).toBe("draft");',1)
 s=s.replace('expect(tool?.activeVersion).toBe("1.0.0");','expect(tool?.activeVersion).toBeUndefined();',1)
 s=s.replace('expect(rollbackTargets.length).toBe(2);\n    expect(rollbackTargets.map((r) => r.version)).toContain("1.1.0");\n    expect(rollbackTargets.map((r) => r.version)).toContain("1.0.0");','expect(rollbackTargets).toEqual([]);',1)
 return s
edit('apps/cloud/tests/evolution/artifacts/service.test.ts',art_test)

for p in [
 'apps/cloud/tests/evolution/lifecycle/brokered-and-workflow-lifecycle.test.ts',
 'apps/cloud/tests/evolution/lifecycle/orchestrator-e2e.test.ts',
 'apps/cloud/tests/evolution/lifecycle/signed-publication.test.ts']:
 def cat(s):
  s=s.replace('expect(catalogTool).not.toBeNull();','expect(catalogTool).toBeNull();')
  s=re.sub(r'\n\s*expect\(catalogTool\?\.name\)\.toBe\([^\n]+\);','',s)
  return s
 edit(p,cat)

# Add a third structurally identical completed session to real process E2E.
def e2e(s):
 needle='''      {\n        eventId: "evt_real_04",\n        sessionId: "sess_real_02",\n        timestamp: new Date().toISOString(),\n        type: "tool_result",\n        schemaVersion: "1.0.0",\n        causalRef: { causalSequence: 2, parentId: "evt_real_03" },\n        redaction: DEFAULT_REDACTION,\n        callId: "call_r2_01",\n        toolName: "bash",\n        result: { stdout: "M src/index.ts" },\n        executionDurationMs: 15,\n        isError: false,\n      },'''
 add=needle+'''\n      {\n        eventId: "evt_real_05", sessionId: "sess_real_03", timestamp: new Date().toISOString(), type: "tool_call", schemaVersion: "1.0.0", causalRef: { causalSequence: 1 }, redaction: DEFAULT_REDACTION, callId: "call_r3_01", toolName: "bash", parameters: { command: "git status --porcelain" }, isShadow: false,\n      },\n      {\n        eventId: "evt_real_06", sessionId: "sess_real_03", timestamp: new Date().toISOString(), type: "tool_result", schemaVersion: "1.0.0", causalRef: { causalSequence: 2, parentId: "evt_real_05" }, redaction: DEFAULT_REDACTION, callId: "call_r3_01", toolName: "bash", result: { stdout: "M src/index.ts" }, executionDurationMs: 15, isError: false,\n      },'''
 if needle not in s: raise SystemExit('e2e marker')
 return s.replace(needle,add,1).replace('expect(ingestRes.ingestedCount).toBe(4);','expect(ingestRes.ingestedCount).toBe(6);',1)
edit('fixtures/e2e/tests/real-process-topology.test.ts',e2e)
print('FIN97 final applied')
