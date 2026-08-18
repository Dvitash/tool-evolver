from pathlib import Path
import re

# Command plans now require an immutable observed or explicitly approved profile.
planner_path = Path("apps/cloud/tests/evolution/generator/planner.test.ts")
planner = planner_path.read_text()

# Add a fixed profile to any command/shell-exec test classification that still lacks one.
classification_pattern = re.compile(r"classification:\s*\{(?P<body>[\s\S]*?)\n\s*\},", re.M)

def align_classification(match: re.Match[str]) -> str:
    body = match.group("body")
    if not re.search(r'taskClass:\s*"(?:command|shell_exec|vcs)"', body):
        return match.group(0)
    if "commandProfiles:" in body:
        return match.group(0)
    inferred = re.search(r"\n(?P<indent>\s*)inferredInputs:", body)
    if inferred:
        insert_at = inferred.start()
        indent = inferred.group("indent")
        body = body[:insert_at] + f'\n{indent}commandProfiles: ["git status --porcelain"],' + body[insert_at:]
    else:
        last_indent = re.search(r"\n(\s*)[^\n]+$", body)
        indent = last_indent.group(1) if last_indent else "        "
        body += f'\n{indent}commandProfiles: ["git status --porcelain"],'
    return "classification: {" + body + "\n      },"

planner = classification_pattern.sub(align_classification, planner)

# Assert the secure fixed profile where a legacy atomic command test only checked class/action.
anchor = '    expect(plan.steps[0].toolClass).toBe("command");'
secure_assertions = '''    expect(plan.steps[0].toolClass).toBe("command");
    expect(plan.steps[0].inputs.command).toBe("git");
    expect(plan.steps[0].inputs.args).toEqual(["status", "--porcelain"]);
    expect(plan.variableInputs.some((input) => input.name === "command")).toBe(false);'''
if secure_assertions not in planner and anchor in planner:
    planner = planner.replace(anchor, secure_assertions, 1)
planner_path.write_text(planner)

# Model schema inference may enrich only observed variables. Empty observations therefore
# produce an empty strict input schema, not AI-invented authority-bearing fields.
schema_path = Path("apps/cloud/tests/evolution/generator/schema-generator.test.ts")
schema = schema_path.read_text()

empty_test = re.compile(
    r'(it\(["\'](?:should )?handle(?:s)? empty variable inputs gracefully["\'][\s\S]*?\{)([\s\S]*?)(\n\s*\}\);)',
    re.I,
)
match = empty_test.search(schema)
if match:
    body = match.group(2)
    body = re.sub(
        r'\n\s*expect\([^\n]*inputSchema\.properties[^\n]*\)\.toBeDefined\(\);',
        '',
        body,
    )
    body = re.sub(
        r'\n\s*expect\([^\n]*inputSchema\.properties\.[^\n]*\)[^;]*;',
        '',
        body,
    )
    body = re.sub(
        r'\n\s*expect\([^\n]*inputSchema\.required[^\n]*\)[^;]*;',
        '',
        body,
    )
    insertion = '''
    expect(result.inputSchema.properties).toEqual({});
    expect(result.inputSchema.required).toEqual([]);'''
    # Preserve the setup and deriveSchemasAsync call; append hardened expectations at the end.
    body = body.rstrip() + insertion
    schema = schema[: match.start(2)] + body + schema[match.end(2) :]

schema_path.write_text(schema)
print("FIN-001 legacy generator fixtures aligned")
