from pathlib import Path


def insert_channel_fields(path: str, marker: str) -> None:
    p = Path(path)
    text = p.read_text()
    if "rollbackReferences:" in text and "revokedVersions: []" in text:
        return
    replacement = marker.replace(
        "    };",
        '      rollbackReferences: {\n        targetVersion: "0.1.0",\n        minSafeVersion: "0.1.0",\n      },\n      revokedVersions: [],\n    };',
    )
    if marker not in text:
        raise SystemExit(f"missing channel payload close in {path}")
    p.write_text(text.replace(marker, replacement, 1))


insert_channel_fields(
    "apps/cli/tests/installer/production-release-transaction.test.ts",
    "      },\n    };\n    channel = {",
)
insert_channel_fields(
    "apps/cli/tests/installer/packaged-cli-production-http.test.ts",
    "      },\n    };\n    const channel = {",
)

p = Path("apps/cli/tests/installer/packaged-cli-production-http.test.ts")
text = p.read_text()
old = "          env: {\n            ...process.env,\n            TOOL_EVOLVER_RELEASE_CHANNEL_URL:"
new = "          env: {\n            ...process.env,\n            NODE_ENV: undefined,\n            TOOL_EVOLVER_RELEASE_CHANNEL_URL:"
if old in text:
    text = text.replace(old, new, 1)
elif "NODE_ENV: undefined" not in text:
    raise SystemExit("missing packed CLI NODE_ENV fixture target")
p.write_text(text)

print("FIN-003 remaining acceptance fixtures corrected")