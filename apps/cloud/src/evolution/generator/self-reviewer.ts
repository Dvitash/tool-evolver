import { CapabilityEnvelope } from "@tool-evolver/contracts";
import ts from "typescript";
import { GeneratedArtifactSet, SelfReviewIssue, SelfReviewVerdict } from "./types.js";

const ALLOWED_IMPORT_SPECIFIERS: Record<string, true> = {
  "@tool-evolver/runtime": true,
  zod: true,
  "node:path": true,
  "node:crypto": true,
  "node:util": true,
};

const FORBIDDEN_IMPORT_PATTERNS = [
  /^node:fs/,
  /^fs$/,
  /^node:child_process/,
  /^child_process$/,
  /^node:net/,
  /^net$/,
  /^node:http/,
  /^http$/,
  /^node:https/,
  /^https$/,
  /^node:process/,
  /^process$/,
];

/**
 * Deterministic self-reviewer validating AST syntax, SDK import boundaries,
 * broker-call and capability manifest consistency, and error handling.
 */
export class DeterministicSelfReviewer {
  /**
   * Reviews a generated candidate artifact set.
   */
  review(
    artifacts: GeneratedArtifactSet,
    envelope?: CapabilityEnvelope
  ): SelfReviewVerdict {
    const issues: SelfReviewIssue[] = [];
    const sourceCode = artifacts.sourceCode;

    // 1. AST & TypeScript Syntax check
    const sourceFile = ts.createSourceFile(
      "candidate.ts",
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const parseDiagnostics = "parseDiagnostics" in sourceFile && Array.isArray(sourceFile.parseDiagnostics)
      ? (sourceFile.parseDiagnostics as ts.Diagnostic[])
      : [];

    for (const diag of parseDiagnostics) {
      issues.push({
        severity: "error",
        category: "ast",
        message: `TypeScript syntax error: ${ts.flattenDiagnosticMessageText(diag.messageText, "\n")}`,
        nodeContext: `Line ${sourceFile.getLineAndCharacterOfPosition(diag.start ?? 0).line + 1}`,
      });
    }

    // Check for export default defineTool
    let hasExportDefault = false;
    let hasDefineTool = false;
    const imports: string[] = [];
    const brokerCalls: Array<{ service: string; method: string; line: number }> = [];
    let hasTryCatch = false;
    let hasProgressCall = false;
    let hasLoggerCall = false;
    const accessedInputProperties: string[] = [];

    const visit = (node: ts.Node) => {
      // Check imports
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push(node.moduleSpecifier.text);
        }
      }

      // Check default export
      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        hasExportDefault = true;
      }

      // Check try-catch
      if (ts.isTryStatement(node)) {
        hasTryCatch = true;
      }

      // Check call expressions
      if (ts.isCallExpression(node)) {
        const callText = node.expression.getText(sourceFile);
        if (callText === "defineTool" || callText.endsWith(".defineTool")) {
          hasDefineTool = true;
        }
        if (callText === "progress" || callText.endsWith(".progress")) {
          hasProgressCall = true;
        }
        if (
          callText.startsWith("logger.") ||
          callText.startsWith("context.logger.") ||
          callText.includes(".logger.")
        ) {
          hasLoggerCall = true;
        }

        // Detect broker calls: broker.fs.readFile, context.broker.cmd.exec, etc.
        const brokerMatch = callText.match(/(?:context\.)?broker\.([a-zA-Z]+)\.([a-zA-Z]+)/);
        if (brokerMatch) {
          const service = brokerMatch[1];
          const method = brokerMatch[2];
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          brokerCalls.push({ service, method, line });
        }
      }

      // Check property access on input: input.foo or (input as ...).foo
      if (ts.isPropertyAccessExpression(node)) {
        const exprText = node.expression.getText(sourceFile);
        if (
          exprText === "input" ||
          exprText.includes("input as") ||
          exprText.endsWith(".input")
        ) {
          accessedInputProperties.push(node.name.text);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (!hasExportDefault) {
      issues.push({
        severity: "error",
        category: "ast",
        message: "Missing default export for tool handler (export default defineTool(...))",
        fixHint: "Add 'export default defineTool(...)' as the default export.",
      });
    }

    if (!hasDefineTool) {
      issues.push({
        severity: "error",
        category: "ast",
        message: "Handler must be wrapped in 'defineTool' from @tool-evolver/runtime",
        fixHint: "Wrap handler in defineTool<ToolInput, ToolOutput>(...).",
      });
    }

    // 2. Import surface validation
    for (const imp of imports) {
      if (!ALLOWED_IMPORT_SPECIFIERS[imp]) {
        const isForbidden = FORBIDDEN_IMPORT_PATTERNS.some((pat) => pat.test(imp));
        issues.push({
          severity: "error",
          category: "imports",
          message: `Illegal import '${imp}'. Generated tools must only import from allowed SDK surface: ${Object.keys(ALLOWED_IMPORT_SPECIFIERS).join(", ")}.`,
          fixHint: isForbidden
            ? `Replace direct import '${imp}' with context.broker equivalents.`
            : `Remove unauthorized import '${imp}'.`,
        });
      }
    }

    // 3. Broker Calls vs Capability Manifest Consistency
    const cap = artifacts.capabilities;

    for (const bCall of brokerCalls) {
      if (bCall.service === "fs") {
        const isRead = ["readFile", "exists", "listDir", "stat"].includes(bCall.method);
        const isWrite = ["writeFile", "removeFile"].includes(bCall.method);

        if (isRead && !cap.fs.allowWorkspaceRoot && cap.fs.readPaths.length === 0) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.fs.${bCall.method} called on line ${bCall.line}, but no read capability is granted in manifest`,
            fixHint: "Grant fs.allowWorkspaceRoot or add paths to fs.readPaths in capability manifest.",
          });
        }

        if (isWrite && !cap.fs.allowWorkspaceRoot && cap.fs.writePaths.length === 0) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.fs.${bCall.method} called on line ${bCall.line}, but no write capability is granted in manifest`,
            fixHint: "Grant fs.allowWorkspaceRoot or add paths to fs.writePaths in capability manifest.",
          });
        }
      } else if (bCall.service === "cmd") {
        const hasCmds =
          cap.command.allowedCommands.length > 0 ||
          cap.command.allowedBinaries.length > 0 ||
          cap.command.allowShellExecution;
        if (!hasCmds) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.cmd.${bCall.method} called on line ${bCall.line}, but command capabilities are empty in manifest`,
            fixHint: "Declare allowedBinaries or allowedCommands in capability manifest.",
          });
        }
      } else if (bCall.service === "net") {
        if (!cap.net.allowOutbound) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.net.${bCall.method} called on line ${bCall.line}, but net.allowOutbound is false in manifest`,
            fixHint: "Set net.allowOutbound to true and specify allowedDomains in capability manifest.",
          });
        }
      } else if (bCall.service === "secret") {
        const hasSecrets =
          cap.secrets.allowedSecretNames.length > 0 ||
          cap.secrets.allowedPrefixes.length > 0;
        if (!hasSecrets) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.secret.${bCall.method} called on line ${bCall.line}, but no secret permissions are declared in manifest`,
            fixHint: "Add secret names to secrets.allowedSecretNames in capability manifest.",
          });
        }
      }
    }

    // Check envelope violations if envelope provided
    if (envelope) {
      if (!envelope.command.allowShellExecution && cap.command.allowShellExecution) {
        issues.push({
          severity: "error",
          category: "capabilities",
          message: "Candidate requests allowShellExecution but envelope strictly forbids shell execution",
          fixHint: "Set allowShellExecution to false and specify explicit allowedBinaries.",
        });
      }
      if (!envelope.net.allowOutbound && cap.net.allowOutbound) {
        issues.push({
          severity: "error",
          category: "capabilities",
          message: "Candidate requests outbound network access but envelope strictly forbids outbound network",
          fixHint: "Disable net.allowOutbound in capability manifest.",
        });
      }
    }

    // 4. Schema & Source Alignment
    const declaredProps: Record<string, true> = {};
    for (const key of Object.keys(artifacts.plan.inputSchema.properties ?? {})) {
      declaredProps[key] = true;
    }
    for (const v of artifacts.plan.variableInputs) {
      declaredProps[v.name] = true;
    }

    for (const prop of accessedInputProperties) {
      if (["length", "toString", "valueOf"].includes(prop)) continue;
      if (Object.keys(declaredProps).length > 0 && !declaredProps[prop]) {
        issues.push({
          severity: "warning",
          category: "schema",
          message: `Source code accesses input property '${prop}', which is not declared in inputSchema`,
          fixHint: `Add '${prop}' to inputSchema properties.`,
        });
      }
    }

    // 5. Error handling
    if (!hasTryCatch) {
      issues.push({
        severity: "error",
        category: "error_handling",
        message: "Tool handler is missing top-level try/catch error handling block",
        fixHint: "Wrap tool execution logic in a try/catch block with logger.error and re-throw.",
      });
    }

    // 6. Progress and Logging
    if (!hasProgressCall) {
      issues.push({
        severity: "warning",
        category: "cancellation",
        message: "Tool handler does not report progress via context.progress",
        fixHint: "Call context.progress(percentage, message) during lifecycle stages.",
      });
    }

    if (!hasLoggerCall) {
      issues.push({
        severity: "warning",
        category: "general",
        message: "Tool handler does not log execution events via context.logger",
        fixHint: "Call context.logger.info / debug / error during execution.",
      });
    }

    const hasErrors = issues.some((i) => i.severity === "error");

    return {
      passed: !hasErrors,
      issues,
      reviewedAt: new Date().toISOString(),
    };
  }
}
