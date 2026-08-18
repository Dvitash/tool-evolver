from pathlib import Path

path = Path("apps/cloud/src/evolution/replay/scenario-builder.ts")
source = path.read_text()
start = source.find("    const regexSpecials =")
if start < 0:
    start = source.find("    const escapeRegex =")
end = source.find("\n\n    const fsPaths", start)
if start < 0 or end < 0:
    raise SystemExit("escapeRegex helper region not found")
replacement = '''    const regexEscape = String.fromCharCode(92);
    const regexSpecials = new Set([
      regexEscape,
      ".",
      "*",
      "+",
      "?",
      "^",
      "$",
      "{",
      "}",
      "(",
      ")",
      "|",
      "[",
      "]",
    ]);
    const escapeRegex = (value: string): string =>
      Array.from(value, (character) =>
        regexSpecials.has(character) ? `${regexEscape}${character}` : character,
      ).join("");'''
source = source[:start] + replacement + source[end:]
path.write_text(source)
print("FIN-001 replay regex escaping fixed")
