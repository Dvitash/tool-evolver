from pathlib import Path
import re

ROOT = Path.cwd()

def rw(rel, fn):
    p = ROOT / rel
    s = p.read_text()
    n = fn(s)
    if n == s:
        raise SystemExit(f'no change for {rel}')
    p.write_text(n)

# Test-only artifact signing remains available; production/staging stay fail-closed.
rw('apps/cloud/src/evolution/artifacts/service.ts', lambda s: s.replace(
    'this.allowEphemeralSigningKey = options.allowEphemeralSigningKey ?? false;',
    'this.allowEphemeralSigningKey = options.allowEphemeralSigningKey ?? process.env.NODE_ENV === "test";', 1))

# Production auth regression fixture must satisfy unrelated model-readiness invariants.
def security(s):
    marker = '''      auth: {\n        jwtSecret: "production-jwt-secret-value-32-characters",'''
    insert = '''      models: {\n        provider: "openai-compatible",\n        providerId: "test-provider",\n        baseUrl: "https://models.example/v1",\n        apiKey: "test-key",\n        model: "test-model",\n        timeoutMs: 30000,\n        allowDeterministicFallback: false,\n      },\n      auth: {\n        jwtSecret: "production-jwt-secret-value-32-characters",'''
    if marker not in s: raise SystemExit('security marker missing')
    return s.replace(marker, insert, 1)
rw('apps/cloud/tests/security-hardening.test.ts', security)

# Repair tests explicitly inject a successful Deno probe instead of relying on host installation.
def doctor_test(s):
    s, n1 = re.subn(r'(const actions = await repairState\(\{\s*home: homeDir,\s*fsBridge,)(\s*\}\);)', r'''\1
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },\2''', s, count=1)
    s, n2 = re.subn(r'(const exitCode = await repairCommand\(\["--json", "--home", homeDir\], \{\s*fsBridge,)(\s*\}\);)', r'''\1
        safetyCertification: {
          probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
        },\2''', s, count=1)
    if n1 != 1 or n2 != 1: raise SystemExit(f'doctor markers {n1} {n2}')
    return s
rw('apps/cli/tests/doctor-repair-command.test.ts', doctor_test)

# Worker RPC may not receive mediated plaintext; trusted host brokers may consume it internally.
def secret_test(s):
    pattern = r'''      // Dispatched request for mediateHeaders[\s\S]*?      // Dispatched direct read fails\n      await expect\(\n        brokerManager\.handleRequest\("secret", "getSecret", \{ name: "GITHUB_TOKEN" \}, ctx\),\n      \)\.rejects\.toThrow\(BrokerSecurityError\);'''
    repl = '''      // Worker RPC cannot receive a fully mediated plaintext value.
      await expect(
        brokerManager.handleRequest(
          "secret",
          "mediateHeaders",
          { headers: { Authorization: "Bearer {{secret:GITHUB_TOKEN}}" } },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "DIRECT_READ_DENIED" });

      // Trusted host brokers consume the secret without returning it to the worker.
      const trusted = await secretBroker.mediateHeaders(
        { Authorization: "Bearer {{secret:GITHUB_TOKEN}}" },
        { ...ctx, isWorker: false, source: "host" },
      );
      expect(trusted.Authorization).toBe("Bearer ghp_123456789012345678901234567890123456");

      await expect(
        brokerManager.handleRequest("secret", "getSecret", { name: "GITHUB_TOKEN" }, ctx),
      ).rejects.toThrow(BrokerSecurityError);'''
    out, n = re.subn(pattern, repl, s, count=1)
    if n != 1: raise SystemExit('secret mediation marker missing')
    return out
rw('packages/runtime/tests/brokers/secret-mediation.test.ts', secret_test)

# Real-process test supplies the required third repeated workflow rather than depending on a fabricated opportunity.
def e2e(s):
    anchor = '''      {\n        eventId: "evt_real_04",\n        sessionId: "sess_real_02",'''
    idx = s.find(anchor)
    if idx < 0: raise SystemExit('e2e anchor missing')
    # insert after the complete evt_real_04 object by locating the next '\n      },\n    ];'
    end_marker = '\n      },\n    ];'
    end = s.find(end_marker, idx)
    if end < 0: raise SystemExit('e2e end marker missing')
    third = '''
      },
      {
        eventId: "evt_real_05",
        sessionId: "sess_real_03",
        timestamp: new Date().toISOString(),
        type: "tool_call",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 1 },
        redaction: DEFAULT_REDACTION,
        callId: "call_r3_01",
        toolName: "bash",
        parameters: { command: "git status --porcelain" },
        isShadow: false,
      },
      {
        eventId: "evt_real_06",
        sessionId: "sess_real_03",
        timestamp: new Date().toISOString(),
        type: "tool_result",
        schemaVersion: "1.0.0",
        causalRef: { causalSequence: 2, parentId: "evt_real_05" },
        redaction: DEFAULT_REDACTION,
        callId: "call_r3_01",
        toolName: "bash",
        result: { stdout: "M src/index.ts" },
        executionDurationMs: 15,
        isError: false,'''
    s = s[:end] + third + s[end+len('\n      },'):]
    s = s.replace('expect(ingestRes.ingestedCount).toBe(4);', 'expect(ingestRes.ingestedCount).toBe(6);', 1)
    return s
rw('fixtures/e2e/tests/real-process-topology.test.ts', e2e)

# Diagnostic file is temporary.
p = ROOT / '.github/lifecycle-test-diagnostics.txt'
if p.exists(): p.unlink()
print('FIN-001 fixes applied')
