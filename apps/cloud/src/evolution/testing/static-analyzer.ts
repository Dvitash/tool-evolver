import type { CapabilityManifest, ToolManifest } from "@tool-evolver/contracts";
import ts from "typescript";
import { type StaticAnalysisFinding, StaticFindingCategory } from "./types.js";

const ALLOWED_IMPORT_SPECIFIERS: Record<string, true> = {
  "@tool-evolver/runtime": true,
  zod: true,
  "node:path": true,
  path: true,
  "node:crypto": true,
  crypto: true,
  "node:util": true,
  util: true,
  "node:buffer": true,
  buffer: true,
};

const FORBIDDEN_IMPORT_PATTERNS = [
  /^node:fs(\/.*)?$/,
  /^fs(\/.*)?$/,
  /^node:child_process$/,
  /^child_process$/,
  /^node:net$/,
  /^net$/,
  /^node:http$/,
  /^http$/,
  /^node:https$/,
  /^https$/,
  /^node:worker_threads$/,
  /^worker_threads$/,
  /^node:cluster$/,
  /^cluster$/,
  /^node:vm$/,
  /^vm$/,
  /^node:v8$/,
  /^v8$/,
  /^node:dgram$/,
  /^dgram$/,
  /^node:dns$/,
  /^dns$/,
  /^node:tls$/,
  /^tls$/,
];

// Patterns indicative of polynomial / exponential catastrophic backtracking in regex
const CATASTROPHIC_REGEX_PATTERNS = [
  /\((?:[^)]*\+[^)]*)\)\+/, // e.g. (a+)+
  /\((?:[^)]*\*[^)]*)\)\*/, // e.g. (a*)*
  /\((?:[^)]*\+[^)]*)\)\*/, // e.g. (a+)*
  /\((?:[^)]*\*[^)]*)\)\+/, // e.g. (a*)+
  /\((?:[^)|]+\|[^)]+)\)\+/, // e.g. (a|aa)+
  /\((?:[^)]+\{\d+,?\d*\}\s*)\)\+/, // e.g. (a{1,5})+
];

/**
 * Static AST Analyzer for Tool Evolver candidate source code.
 */
export class StaticAnalyzer {
  /**
   * Analyzes candidate source code against security rules, broker-manifest parity,
   * static flaws, and structure requirements.
   */
  analyze(
    sourceCode: string,
    manifest?: Partial<ToolManifest>,
    capabilities?: Partial<CapabilityManifest>,
  ): StaticAnalysisFinding[] {
    const findings: StaticAnalysisFinding[] = [];
    const sourceFile = ts.createSourceFile(
      "candidate.ts",
      sourceCode,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );

    // Check syntactic parser errors
    const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      for (const diag of parseDiagnostics) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(diag.start ?? 0);
        findings.push({
          severity: "error",
          category: "syntax_error",
          message: `TypeScript syntax error: ${ts.flattenDiagnosticMessageText(diag.messageText, "\n")}`,
          location: { line: line + 1, column: character + 1 },
          nodeContext: `Line ${line + 1}`,
        });
      }
    }

    const effectiveCaps = capabilities ?? manifest?.capabilities;

    // 1. Structure & Imports & Calls tracking
    let hasExportDefault = false;
    let hasDefineTool = false;
    let hasInputSchema = false;
    let hasOutputSchema = false;

    const brokerCalls: Array<{
      service: string;
      method: string;
      line: number;
      column: number;
      args: string[];
    }> = [];

    const topLevelMutableVars: Array<{ name: string; line: number; column: number }> = [];

    const visit = (node: ts.Node) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const pos = { line: line + 1, column: character + 1 };

      // Top-level mutable collections
      if (node.parent === sourceFile && ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (decl.initializer) {
            const initText = decl.initializer.getText(sourceFile);
            if (
              initText.startsWith("[]") ||
              initText.startsWith("new Array") ||
              initText.startsWith("new Map") ||
              initText.startsWith("new Set") ||
              initText.startsWith("{}") ||
              initText.startsWith("new Object")
            ) {
              const varName = decl.name.getText(sourceFile);
              topLevelMutableVars.push({ name: varName, line: pos.line, column: pos.column });
            }
          }
        }
      }

      // Check imports
      if (ts.isImportDeclaration(node)) {
        const specifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, "");

        // Remote imports
        if (specifier.startsWith("http://") || specifier.startsWith("https://")) {
          findings.push({
            severity: "error",
            category: "forbidden_import",
            message: `Remote URL imports are strictly forbidden: '${specifier}'`,
            location: pos,
            fixHint: "Import from standard allowed packages or use brokered network fetch.",
          });
        }
        // Native addons
        else if (specifier.endsWith(".node")) {
          findings.push({
            severity: "error",
            category: "forbidden_import",
            message: `Native binary addon imports (.node) are strictly forbidden: '${specifier}'`,
            location: pos,
            fixHint: "Use pure TypeScript/JavaScript or brokered host capabilities.",
          });
        }
        // Forbidden modules
        else if (!ALLOWED_IMPORT_SPECIFIERS[specifier]) {
          const isForbidden = FORBIDDEN_IMPORT_PATTERNS.some((pat) => pat.test(specifier));
          if (isForbidden) {
            findings.push({
              severity: "error",
              category: "forbidden_import",
              message: `Illegal direct system module import: '${specifier}'. Use broker capability clients instead.`,
              location: pos,
              fixHint: `Remove 'import ... from "${specifier}"' and use 'context.broker' APIs.`,
            });
          } else {
            findings.push({
              severity: "error",
              category: "forbidden_import",
              message: `Unrecognized third-party import: '${specifier}'. Only @tool-evolver/runtime, zod, and safe builtins are allowed.`,
              location: pos,
              fixHint: "Remove unauthorized third-party import.",
            });
          }
        }
      }

      // Check dynamic imports: import(...)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        findings.push({
          severity: "error",
          category: "forbidden_import",
          message: "Dynamic import() expressions are forbidden in candidate tool code.",
          location: pos,
          fixHint: "Use static imports from allowed modules at the top of the file.",
        });
      }

      // Check forbidden globals: eval, Function, process.exit, process.kill
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const calleeText = node.expression.getText(sourceFile);
        if (calleeText === "eval") {
          findings.push({
            severity: "error",
            category: "forbidden_api",
            message: "Direct use of 'eval()' is strictly prohibited for security reasons.",
            location: pos,
            fixHint: "Remove eval() and use deterministic structured logic.",
          });
        } else if (calleeText === "Function") {
          findings.push({
            severity: "error",
            category: "forbidden_api",
            message: "Dynamic code compilation with 'Function()' is strictly prohibited.",
            location: pos,
            fixHint: "Avoid dynamic function synthesis.",
          });
        } else if (calleeText === "process.exit" || calleeText === "process.kill") {
          findings.push({
            severity: "error",
            category: "forbidden_api",
            message: `Process termination via '${calleeText}()' is prohibited inside tools.`,
            location: pos,
            fixHint: "Throw an error or return an error status instead of killing process.",
          });
        }
      }

      // Track schema exports
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          const varName = decl.name.getText(sourceFile);
          if (varName === "InputSchema") hasInputSchema = true;
          if (varName === "OutputSchema") hasOutputSchema = true;
        }
      }

      // Check export default defineTool
      if (ts.isExportAssignment(node)) {
        hasExportDefault = true;
        const exprText = node.expression.getText(sourceFile);
        if (exprText.includes("defineTool")) {
          hasDefineTool = true;
        }
      }

      // Detect broker calls
      if (ts.isCallExpression(node)) {
        this.inspectPotentialBrokerCall(node, sourceFile, brokerCalls);
      }

      // Static Flaw: Infinite Loops without break/progress/return/cancellation
      if (ts.isWhileStatement(node) || ts.isForStatement(node) || ts.isDoStatement(node)) {
        this.inspectLoopForFlaws(node, sourceFile, pos, findings);
      }

      // Static Flaw: Swallowed Errors in Catch Clauses
      if (ts.isCatchClause(node)) {
        this.inspectCatchClauseForFlaws(node, sourceFile, pos, findings);
      }

      // Static Flaw: Unsafe Catastrophic Backtracking Regular Expressions
      if (ts.isRegularExpressionLiteral(node)) {
        const regexText = node.getText(sourceFile);
        this.inspectRegexForFlaws(regexText, pos, findings);
      } else if (
        ts.isNewExpression(node) &&
        node.expression.getText(sourceFile) === "RegExp" &&
        node.arguments &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]!)
      ) {
        const regexText = node.arguments[0]!.text;
        this.inspectRegexForFlaws(regexText, pos, findings);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // 2. Structural checks
    if (!hasExportDefault) {
      findings.push({
        severity: "error",
        category: "syntax_error",
        message: "Tool implementation must contain a default export wrapped with 'defineTool'.",
        fixHint:
          "Add 'export default defineTool<ToolInput, ToolOutput>(async (context) => { ... });'",
      });
    } else if (!hasDefineTool) {
      findings.push({
        severity: "error",
        category: "syntax_error",
        message: "Default export is not wrapped with 'defineTool' from @tool-evolver/runtime.",
        fixHint: "Wrap handler in defineTool<ToolInput, ToolOutput>(...).",
      });
    }

    if (!hasInputSchema) {
      findings.push({
        severity: "warning",
        category: "schema_mismatch",
        message:
          "Tool code does not export 'InputSchema'. Defining and exporting InputSchema is recommended.",
        fixHint: "Export const InputSchema = z.object({ ... });",
      });
    }

    if (!hasOutputSchema) {
      findings.push({
        severity: "warning",
        category: "schema_mismatch",
        message:
          "Tool code does not export 'OutputSchema'. Defining and exporting OutputSchema is recommended.",
        fixHint: "Export const OutputSchema = z.object({ ... });",
      });
    }

    // 3. Broker-Manifest Parity Validation
    this.validateBrokerManifestParity(brokerCalls, effectiveCaps, findings);

    // 4. Memory leak check: Top-level mutable collections
    if (topLevelMutableVars.length > 0) {
      for (const v of topLevelMutableVars) {
        // Check if variable is mutated in source code
        if (
          sourceCode.includes(`${v.name}.push`) ||
          sourceCode.includes(`${v.name}.set`) ||
          sourceCode.includes(`${v.name}.add`) ||
          sourceCode.includes(`${v.name}[`)
        ) {
          findings.push({
            severity: "warning",
            category: "static_flaw",
            message: `Top-level mutable collection '${v.name}' retains state across invocations causing memory leaks.`,
            location: { line: v.line, column: v.column },
            fixHint: `Move '${v.name}' inside the tool handler body or manage per-invocation lifecycle.`,
          });
        }
      }
    }

    return findings;
  }

  /**
   * Inspects AST CallExpressions for broker client interactions.
   */
  private inspectPotentialBrokerCall(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    brokerCalls: Array<{
      service: string;
      method: string;
      line: number;
      column: number;
      args: string[];
    }>,
  ): void {
    const exprText = node.expression.getText(sourceFile);
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const args = node.arguments.map((a) => a.getText(sourceFile).replace(/['"]/g, ""));

    // broker.fs.*, broker.net.*, broker.cmd.*, broker.secret.*
    const match = exprText.match(/(?:context\.)?broker\.(fs|net|cmd|secret)\.([a-zA-Z0-9_]+)/);
    if (match) {
      brokerCalls.push({
        service: match[1]!,
        method: match[2]!,
        line: line + 1,
        column: character + 1,
        args,
      });
      return;
    }

    // broker.request("fs"|"net"|"cmd"|"secret", action, ...)
    const requestMatch = exprText.match(/(?:context\.)?broker\.request/);
    if (requestMatch && node.arguments.length >= 2) {
      const serviceArg = node.arguments[0]!.getText(sourceFile).replace(/['"]/g, "");
      const actionArg = node.arguments[1]!.getText(sourceFile).replace(/['"]/g, "");
      if (["fs", "net", "cmd", "secret"].includes(serviceArg)) {
        brokerCalls.push({
          service: serviceArg,
          method: actionArg,
          line: line + 1,
          column: character + 1,
          args: args.slice(2),
        });
      }
    }
  }

  /**
   * Validates that all detected broker calls have corresponding capability grants in manifest.
   */
  private validateBrokerManifestParity(
    brokerCalls: Array<{
      service: string;
      method: string;
      line: number;
      column: number;
      args: string[];
    }>,
    capabilities: Partial<CapabilityManifest> | undefined,
    findings: StaticAnalysisFinding[],
  ): void {
    const caps = capabilities ?? {};

    for (const call of brokerCalls) {
      const pos = { line: call.line, column: call.column };

      if (call.service === "fs") {
        const fsCap = caps.fs;
        const isWrite = ["writeFile", "removeFile", "mkdir", "rm"].includes(call.method);

        if (!fsCap) {
          findings.push({
            severity: "error",
            category: "undeclared_capability",
            message: `Tool invokes filesystem broker method 'broker.fs.${call.method}' but no filesystem capability is declared in manifest.`,
            location: pos,
            fixHint: "Add 'fs' capability with readPaths/writePaths in requiredCapabilities.",
          });
          continue;
        }

        if (isWrite) {
          const hasWritePermission =
            fsCap.allowWorkspaceRoot === true ||
            fsCap.allowTemp === true ||
            (Array.isArray(fsCap.writePaths) && fsCap.writePaths.length > 0);

          if (!hasWritePermission) {
            findings.push({
              severity: "error",
              category: "undeclared_capability",
              message: `Tool invokes filesystem write method 'broker.fs.${call.method}' but manifest does not grant write permissions.`,
              location: pos,
              fixHint:
                "Enable 'fs.allowWorkspaceRoot: true', 'fs.allowTemp: true', or add paths to 'fs.writePaths'.",
            });
          }
        } else {
          const hasReadPermission =
            fsCap.allowWorkspaceRoot === true ||
            fsCap.allowTemp === true ||
            (Array.isArray(fsCap.readPaths) && fsCap.readPaths.length > 0) ||
            (Array.isArray(fsCap.writePaths) && fsCap.writePaths.length > 0);

          if (!hasReadPermission) {
            findings.push({
              severity: "error",
              category: "undeclared_capability",
              message: `Tool invokes filesystem read method 'broker.fs.${call.method}' but manifest does not grant read permissions.`,
              location: pos,
              fixHint:
                "Enable 'fs.allowWorkspaceRoot: true', 'fs.allowTemp: true', or add paths to 'fs.readPaths'.",
            });
          }
        }
      } else if (call.service === "net") {
        const netCap = caps.net;
        if (!netCap || netCap.allowOutbound !== true) {
          findings.push({
            severity: "error",
            category: "undeclared_capability",
            message: `Tool invokes network broker method 'broker.net.${call.method}' but 'net.allowOutbound' is false or missing in manifest.`,
            location: pos,
            fixHint: "Set 'net.allowOutbound: true' in requiredCapabilities manifest.",
          });
        }
      } else if (call.service === "cmd") {
        const cmdCap = caps.command;
        if (
          !cmdCap ||
          (cmdCap.allowShellExecution !== true &&
            (!cmdCap.allowedCommands || cmdCap.allowedCommands.length === 0) &&
            (!cmdCap.allowedBinaries || cmdCap.allowedBinaries.length === 0))
        ) {
          findings.push({
            severity: "error",
            category: "undeclared_capability",
            message: `Tool invokes command broker method 'broker.cmd.${call.method}' but command execution capability is not granted in manifest.`,
            location: pos,
            fixHint:
              "Set 'command.allowShellExecution: true' or configure 'allowedCommands' in requiredCapabilities.",
          });
        }
      } else if (call.service === "secret") {
        const secretCap = caps.secrets;
        if (
          [
            "getSecret",
            "read",
            "resolve",
            "raw",
            "getRawSecret",
            "getValue",
            "getSecretValue",
            "add",
            "addSecret",
            "rotate",
            "rotateSecret",
            "delete",
            "deleteSecret",
            "purge",
          ].includes(call.method)
        ) {
          findings.push({
            severity: "error",
            category: "forbidden_api",
            message: `Direct secret read or administrative secret operation 'broker.secret.${call.method}' is strictly prohibited. Use opaque secret references ('broker.secret.createReference' or 'bearerToken').`,
            location: pos,
            fixHint:
              "Replace direct secret reads with opaque references and trusted broker mediation.",
          });
        }

        if (
          !secretCap ||
          ((!secretCap.allowedSecretNames || secretCap.allowedSecretNames.length === 0) &&
            (!secretCap.allowedPrefixes || secretCap.allowedPrefixes.length === 0))
        ) {
          findings.push({
            severity: "error",
            category: "undeclared_capability",
            message: `Tool invokes secret broker method 'broker.secret.${call.method}' but no secret permissions are declared in manifest.`,
            location: pos,
            fixHint: "Add requested secret names to 'secrets.allowedSecretNames' in manifest.",
          });
        }
      }
    }
  }

  /**
   * Checks loops for infinite execution hazards.
   */
  private inspectLoopForFlaws(
    node: ts.WhileStatement | ts.ForStatement | ts.DoStatement,
    sourceFile: ts.SourceFile,
    pos: { line: number; column: number },
    findings: StaticAnalysisFinding[],
  ): void {
    let isInfiniteCondition = false;

    if (ts.isWhileStatement(node)) {
      const condText = node.expression.getText(sourceFile).trim();
      if (condText === "true" || condText === "1" || condText === "!0") {
        isInfiniteCondition = true;
      }
    } else if (ts.isForStatement(node)) {
      if (!node.condition && !node.initializer && !node.incrementor) {
        isInfiniteCondition = true; // for (;;)
      }
    }

    if (isInfiniteCondition) {
      let hasExitMechanism = false;
      const checkExit = (child: ts.Node) => {
        if (
          ts.isBreakStatement(child) ||
          ts.isReturnStatement(child) ||
          ts.isThrowStatement(child)
        ) {
          hasExitMechanism = true;
        }
        const text = child.getText(sourceFile);
        if (
          text.includes("signal.aborted") ||
          text.includes("signal?.aborted") ||
          text.includes("progress(")
        ) {
          hasExitMechanism = true;
        }
        if (!hasExitMechanism) {
          ts.forEachChild(child, checkExit);
        }
      };

      checkExit(node.statement);

      if (!hasExitMechanism) {
        findings.push({
          severity: "error",
          category: "static_flaw",
          message:
            "Potential infinite loop detected: loop has constant true condition without break, return, throw, or cancellation check.",
          location: pos,
          fixHint:
            "Add termination condition, break statement, or check 'context.signal?.aborted'.",
        });
      }
    }
  }

  /**
   * Checks catch clauses for swallowed errors.
   */
  private inspectCatchClauseForFlaws(
    node: ts.CatchClause,
    sourceFile: ts.SourceFile,
    pos: { line: number; column: number },
    findings: StaticAnalysisFinding[],
  ): void {
    const block = node.block;
    if (block.statements.length === 0) {
      findings.push({
        severity: "warning",
        category: "static_flaw",
        message:
          "Swallowed error detected: empty catch block without logging or error propagation.",
        location: pos,
        fixHint: "Log error with 'await logger.error(...)' or rethrow/handle gracefully.",
      });
      return;
    }

    const blockText = block.getText(sourceFile);
    const hasLog = blockText.includes("logger.") || blockText.includes("console.");
    const hasThrow = blockText.includes("throw ");
    const hasReturn = blockText.includes("return ");

    if (!hasLog && !hasThrow && !hasReturn) {
      findings.push({
        severity: "warning",
        category: "static_flaw",
        message: "Catch block does not log, rethrow, or return an error status.",
        location: pos,
        fixHint: "Ensure caught errors are logged via 'logger.error' or rethrown.",
      });
    }
  }

  /**
   * Inspects regex patterns for catastrophic backtracking (ReDoS).
   */
  private inspectRegexForFlaws(
    regexPattern: string,
    pos: { line: number; column: number },
    findings: StaticAnalysisFinding[],
  ): void {
    for (const pattern of CATASTROPHIC_REGEX_PATTERNS) {
      if (pattern.test(regexPattern)) {
        findings.push({
          severity: "error",
          category: "static_flaw",
          message: `Potentially catastrophic backtracking regex detected: '${regexPattern}'. Risk of ReDoS.`,
          location: pos,
          fixHint:
            "Rewrite regular expression with atomic grouping or non-overlapping repeated tokens.",
        });
        break;
      }
    }
  }
}
