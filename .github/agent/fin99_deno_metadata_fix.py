from pathlib import Path

p = Path("apps/cli/src/installer/asset-downloader.ts")
s = p.read_text()
old = """        ) as { provenance?: ReleaseProvenance; deno?: { version?: string; sha256?: string } };"""
new = """        ) as {\n          provenance?: ReleaseProvenance;\n          denoRuntime?: { version?: string; sha256?: string };\n        };"""
if old not in s:
    raise SystemExit("missing version metadata cast")
s = s.replace(old, new, 1)
s = s.replace("versionMetadata.deno?.version", "versionMetadata.denoRuntime?.version")
s = s.replace("versionMetadata.deno?.sha256", "versionMetadata.denoRuntime?.sha256")
p.write_text(s)

p = Path("apps/cli/tests/installer/packaged-cli-production-http.test.ts")
s = p.read_text()
old = 'expect(versionMetadata.deno.version).toBe("2.9.5");'
new = 'expect(versionMetadata.denoRuntime.version).toBe("2.9.5");'
if old not in s:
    raise SystemExit("missing packaged Deno metadata assertion")
p.write_text(s.replace(old, new, 1))

print("FIN-003 Deno metadata field aligned")