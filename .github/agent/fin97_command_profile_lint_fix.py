from pathlib import Path
import re

path = Path("apps/cloud/src/evolution/replay/scenario-builder.ts")
source = path.read_text()
replacement = '''    const regexSpecials = new Set(["\\\\", ".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]"]);
    const escapeRegex = (value: string): string =>
      Array.from(value, (character) => (regexSpecials.has(character) ? `\\\\${character}` : character)).join("");
'''
source, count = re.subn(
    r"    const escapeRegex = .*?;\n",
    replacement,
    source,
    count=1,
)
if count != 1 and "const regexSpecials = new Set" not in source:
    raise SystemExit("escapeRegex helper not found")
path.write_text(source)
print("FIN-001 replay regex escaping fixed")
