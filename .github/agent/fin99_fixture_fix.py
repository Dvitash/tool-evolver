from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing fixture target: {label}")
    p.write_text(text.replace(old, new, 1))

replace_once(
    "apps/cli/tests/assets.test.ts",
    '''  it("finds Deno executable from custom path or environment variables", async () => {\n    const bridge = new InMemoryConfigFsBridge();\n    await bridge.writeFile("/home/developer/.deno/bin/deno", "binary");\n\n    const found = await findDenoExecutable(undefined, { HOME: "/home/developer" }, bridge);\n\n    expect(found).not.toBeNull();\n    expect(found?.path).toBe("/home/developer/.deno/bin/deno");\n  });''',
    '''  it("does not treat a merely existing path as a working Deno executable", async () => {\n    const bridge = new InMemoryConfigFsBridge();\n    await bridge.writeFile("/home/developer/.deno/bin/deno", "not-an-executable-deno");\n\n    const found = await findDenoExecutable(undefined, { HOME: "/home/developer" }, bridge);\n\n    expect(found).toBeNull();\n  });''',
    "Deno fake-path test",
)

for path in [
    "apps/cli/tests/installer/production-release-transaction.test.ts",
    "apps/cli/tests/installer/packaged-cli-production-http.test.ts",
]:
    replace_once(
        path,
        '''      channels: {\n        stable: {\n          version: "1.0.0",\n          releaseDate: "2026-08-18T00:00:00.000Z",''',
        '''      channels: {\n        stable: {\n          version: "1.0.0",\n          releaseDate: "2026-08-18T00:00:00.000Z",''',
        "channel anchor",
    )
    p = Path(path)
    text = p.read_text()
    marker = '''      },\n    };\n    const channel = {'''
    replacement = '''      },\n      rollbackReferences: {\n        targetVersion: "0.1.0",\n        minSafeVersion: "0.1.0",\n      },\n      revokedVersions: [],\n    };\n    const channel = {'''
    if marker not in text:
        raise SystemExit(f"missing channel payload close in {path}")
    p.write_text(text.replace(marker, replacement, 1))

# A real npm/npx invocation does not inherit Vitest's NODE_ENV=test; remove it from
# the child process so the compiled CLI's production entrypoint executes.
replace_once(
    "apps/cli/tests/installer/packaged-cli-production-http.test.ts",
    '''          env: {\n            ...process.env,\n            TOOL_EVOLVER_RELEASE_CHANNEL_URL:''',
    '''          env: {\n            ...process.env,\n            NODE_ENV: undefined,\n            TOOL_EVOLVER_RELEASE_CHANNEL_URL:''',
    "packed CLI NODE_ENV",
)

print("FIN-003 acceptance fixtures corrected")
