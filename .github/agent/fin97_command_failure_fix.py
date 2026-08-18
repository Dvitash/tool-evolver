from pathlib import Path


def replace_once(path: str, old: str, new: str, marker: str) -> None:
    file_path = Path(path)
    source = file_path.read_text()
    if old in source:
        source = source.replace(old, new, 1)
    elif marker not in source:
        raise SystemExit(f"patch target not found in {path}")
    file_path.write_text(source)


replace_once(
    "apps/cloud/src/evolution/generator/code-generator.ts",
    '''      const res = await broker.cmd.exec(command, args);
      resultData = {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
      };`;''',
    '''      const res = await broker.cmd.exec(command, args);
      if (res.exitCode !== 0) {
        throw new Error(\\`Command '\\${command}' failed with exit code \\${res.exitCode}: \\${res.stderr}\\`);
      }
      resultData = {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
      };`;''',
    "if (res.exitCode !== 0)",
)

replace_once(
    "apps/cloud/tests/evolution/generator/code-generator.test.ts",
    '''    expect(source).toContain("await broker.cmd.exec(command, args);");
  });''',
    '''    expect(source).toContain("await broker.cmd.exec(command, args);");
    expect(source).toContain("if (res.exitCode !== 0)");
    expect(source).toContain("failed with exit code");
  });''',
    'expect(source).toContain("if (res.exitCode !== 0)")',
)

print("FIN-001 generated command tools now fail closed on nonzero exit codes")
