import type { CapabilityEnvelope } from "@tool-evolver/contracts";
import ts from "typescript";
import { CapabilityMapper } from "./capability-mapper.js";
import type { GeneratedArtifactSet, SelfReviewIssue, SelfReviewVerdict } from "./types.js";

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
  /^axios$/,
  /^node-fetch$/,
  /^undici$/,
];

/**
 * Deterministic self-reviewer that analyzes generated TypeScript tool artifacts
 * for syntax, imports, broker usage, capability subset alignment, schema consistency, and error handling.
 */
export class DeterministicSelfReviewer {
  private readonly capabilityMapper: CapabilityMapper;

  constructor(capabilityMapper: CapabilityMapper = new CapabilityMapper()) {
    this.capabilityMapper = capabilityMapper;
  }

  /**
   * Reviews generated artifacts against AST safety rules and capability envelope constraints.
   */
  review(artifacts: GeneratedArtifactSet, envelope?: CapabilityEnvelope): SelfReviewVerdict {
    const issues: SelfReviewIssue[] = [];
    const sourceCode = artifacts.sourceCode;

    // 1. TypeScript AST Parse and Syntax Analysis
    const sourceFile = ts.createSourceFile(
      "tool.ts",
      sourceCode,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );

    const syntaxErrors: ts.DiagnosticWithLocation[] = [];
    const walkDiagnostics = (node: ts.Node) => {
      // Basic syntax check
      if (node.flags & ts.NodeFlags.JavaScriptFile) {
        // ok
      }
    };
    walkDiagnostics(sourceFile);

    // Check for parse errors
    if ("parseDiagnostics" in sourceFile && Array.isArray(sourceFile.parseDiagnostics)) {
      for (const diag of sourceFile.parseDiagnostics as ts.DiagnosticWithLocation[]) {
        const message =
          typeof diag.messageText === "string" ? diag.messageText : diag.messageText.messageText;
        issues.push({
          severity: "error",
          category: "ast",
          message: `Syntax error: ${message}`,
          fixHint: "Fix TypeScript syntax error in generated tool code.",
        });
      }
    }

    let hasDefineTool = false;
    let hasTryCatch = false;
    let hasLoggerError = false;
    let hasLoggerInfo = false;
    const imports: string[] = [];
    const brokerCalls: Array<{ service: string; method: string; line: number }> = [];
    const accessedInputProperties: string[] = [];

    // AST Traversal
    const visit = (node: ts.Node) => {
      // Imports
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          imports.push(moduleSpecifier.text);
        }
      }

      // defineTool call check
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isIdentifier(expr) && expr.text === "defineTool") {
          hasDefineTool = true;
        }

        // Direct raw secret access detection
        if (
          (ts.isIdentifier(expr) && expr.text === "getSecret") ||
          (ts.isPropertyAccessExpression(expr) &&
            (expr.name.text === "getSecret" || expr.name.text === "secretValue"))
        ) {
          issues.push({
            severity: "error",
            category: "broker",
            message:
              "Direct secret value access is forbidden. Tools must use context.secret.getSecretRef().",
            fixHint:
              "Use context.secret.getSecretRef(name, { mode }) to acquire an opaque secret reference.",
          });
        }

        // Detect broker calls
        if (ts.isPropertyAccessExpression(expr)) {
          const serviceExpr = expr.expression;
          const method = expr.name.text;

          // context.fs.readFile or broker.fs.readFile
          if (ts.isPropertyAccessExpression(serviceExpr)) {
            const rootExpr = serviceExpr.expression;
            const service = serviceExpr.name.text;
            if (
              ts.isIdentifier(rootExpr) &&
              (rootExpr.text === "broker" || rootExpr.text === "context") &&
              ["fs", "net", "cmd", "secret"].includes(service)
            ) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              brokerCalls.push({ service, method, line: line + 1 });
            }
          }
        }
      }

      // Raw secret property access (e.g. secret.value)
      if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === "value" && ts.isIdentifier(node.expression)) {
          const objName = node.expression.text.toLowerCase();
          if (objName.includes("secret") || objName.includes("token") || objName.includes("key")) {
            issues.push({
              severity: "error",
              category: "broker",
              message:
                "Accessing .value on secret reference is forbidden. Secrets are non-disclosing.",
              fixHint:
                "Pass the SecretReference directly to brokeredFetch or brokeredExec headers/env.",
            });
          }
        }
      }

      // try/catch check
      if (ts.isTryStatement(node)) {
        hasTryCatch = true;
      }

      // logger calls
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const pExpr = node.expression;
        const root = pExpr.expression;
        if (ts.isIdentifier(root) && root.text === "logger") {
          if (pExpr.name.text === "error") hasLoggerError = true;
          if (pExpr.name.text === "info" || pExpr.name.text === "debug") hasLoggerInfo = true;
        }
      }

      // input property accesses: params.foo or input.foo
      if (ts.isPropertyAccessExpression(node)) {
        const obj = node.expression;
        if (ts.isIdentifier(obj) && (obj.text === "params" || obj.text === "input")) {
          accessedInputProperties.push(node.name.text);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Broker command-result contract validation (generation-gate check)
    this.checkBrokerResultContract(sourceFile, issues);

    // Structure validation
    if (!hasDefineTool && artifacts.plan.targetType !== "workflow") {
      issues.push({
        severity: "error",
        category: "ast",
        message: "Handler must be wrapped in 'defineTool' from @tool-evolver/runtime",
        fixHint: "Wrap handler in defineTool<ToolInput, ToolOutput>(...).",
      });
    }

    // Import surface validation
    for (const imp of imports) {
      if (!ALLOWED_IMPORT_SPECIFIERS[imp]) {
        const isForbidden = FORBIDDEN_IMPORT_PATTERNS.some((pat) => pat.test(imp));
        issues.push({
          severity: "error",
          category: "imports",
          message: `Illegal import '${imp}'. Generated tools must only import from allowed SDK surface: ${Object.keys(ALLOWED_IMPORT_SPECIFIERS).join(", ")}.`,
          fixHint: isForbidden
            ? `Replace direct import '${imp}' with context.fs / context.net / context.cmd broker equivalents.`
            : `Remove unauthorized import '${imp}'.`,
        });
      }
    }

    // Broker Calls vs Capability Manifest Consistency
    const cap = artifacts.capabilities;

    for (const bCall of brokerCalls) {
      if (bCall.service === "fs") {
        const isRead = ["readFile", "exists", "listDir", "stat"].includes(bCall.method);
        const isWrite = ["writeFile", "removeFile", "mkdir", "delete"].includes(bCall.method);

        if (isRead && !cap.fs.allowWorkspaceRoot && cap.fs.readPaths.length === 0) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.fs.${bCall.method} called on line ${bCall.line}, but no read capability is granted in manifest`,
            fixHint: "Grant fs.allowWorkspaceRoot: true or add readPaths to manifest.",
          });
        }

        if (isWrite && cap.fs.writePaths.length === 0 && !cap.fs.allowWorkspaceRoot) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.fs.${bCall.method} called on line ${bCall.line}, but no write capability is granted in manifest`,
            fixHint: "Add explicit writePaths to manifest.",
          });
        }
      }

      if (bCall.service === "net") {
        if (!cap.net.allowOutbound) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.net.${bCall.method} called on line ${bCall.line}, but net.allowOutbound is false`,
            fixHint: "Enable net.allowOutbound: true in capability manifest.",
          });
        }
      }

      if (bCall.service === "cmd") {
        if (
          cap.command.allowedCommands.length === 0 &&
          cap.command.allowedBinaries.length === 0 &&
          !cap.command.allowShellExecution
        ) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.cmd.${bCall.method} called on line ${bCall.line}, but no command/binary capabilities are granted`,
            fixHint: "Grant specific allowedCommands in capability manifest.",
          });
        }
      }

      if (bCall.service === "secret") {
        if (
          cap.secrets.allowedSecretNames.length === 0 &&
          cap.secrets.allowedPrefixes.length === 0
        ) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `broker.secret.${bCall.method} called on line ${bCall.line}, but no secrets are granted in manifest`,
            fixHint: "Grant specific allowedSecretNames in capability manifest.",
          });
        }
      }
    }

    // Capability Envelope Subset Validation
    if (envelope) {
      const validation = this.capabilityMapper.validateSubset(artifacts.capabilities, envelope);
      if (!validation.valid) {
        for (const violation of validation.violations) {
          issues.push({
            severity: "error",
            category: "capabilities",
            message: `Capability envelope violation: ${violation}`,
            fixHint: "Minimize or constrain candidate capability manifest to workspace envelope.",
          });
        }
      }
    }

    // Schema & Source Alignment
    const declaredProps: Record<string, true> = {};
    for (const key of Object.keys(artifacts.plan.inputSchema.properties ?? {})) {
      declaredProps[key] = true;
    }
    for (const v of artifacts.plan.variableInputs) {
      declaredProps[v.name] = true;
    }

    for (const prop of accessedInputProperties) {
      if (["length", "toString", "valueOf", "constructor"].includes(prop)) continue;
      if (!declaredProps[prop]) {
        issues.push({
          severity: "error",
          category: "schema",
          message: `Source code accesses 'params.${prop}', but '${prop}' is not declared in inputSchema`,
          fixHint: `Add '${prop}' to inputSchema or variableInputs.`,
        });
      }
    }

    // Error handling & Logging
    if (!hasTryCatch) {
      issues.push({
        severity: "error",
        category: "error_handling",
        message: "Tool handler execution is not wrapped in a try/catch block",
        fixHint: "Wrap tool execution logic in try { ... } catch (error) { ... }.",
      });
    }

    if (!hasLoggerError && hasTryCatch) {
      issues.push({
        severity: "error",
        category: "error_handling",
        message: "Catch block does not log errors via logger.error",
        fixHint: "Call await logger.error(...) in catch block.",
      });
    }

    if (!hasLoggerInfo) {
      issues.push({
        severity: "warning",
        category: "general",
        message: "Tool handler does not log execution events via logger.info",
        fixHint: "Call await logger.info(...) during execution.",
      });
    }

    const hasErrors = issues.some((i) => i.severity === "error");

    return {
      passed: !hasErrors,
      issues,
      reviewedAt: new Date().toISOString(),
    };
  }

  /**
   * Flags command-broker contract violations that deterministic validation would
   * otherwise have to catch at test time:
   * - `broker.exec(...)` / `context.exec(...)` / `ctx.exec(...)`: the exec method
   *   exists only on the cmd family (`context.broker.cmd.exec`, `context.cmd.exec`).
   * - `<chain>.cmd.execute(...)`: CmdBrokerClient exposes `exec`, not `execute`.
   * - Reading `.output` / `.error` / `.exit_code` off a variable holding an exec
   *   result: cmd.exec resolves `{ exitCode, stdout, stderr }`.
   * - Never inspecting `.exitCode` on an exec result: non-zero exits resolve as
   *   data, they do not throw — unchecked results report failures as success.
   * - Shell operators (`&&`, `||`, `|`, `;`, `>`) inside exec args: no shell is
   *   invoked, so operators reach the process as literal argv entries.
   */
  private checkBrokerResultContract(sourceFile: ts.SourceFile, issues: SelfReviewIssue[]): void {
    const execResultVars = new Set<string>();
    const exitCodeReadVars = new Set<string>();
    const reported = new Set<string>();
    const hallucinatedResultFields = new Set(["output", "error", "exit_code"]);
    const shellOperators = new Set(["&&", "||", "|", ";", ">", ">>", "<", "2>", "2>&1"]);
    const brokerRoots = new Set(["broker", "context", "ctx"]);

    const isBrokerishChain = (expr: ts.Expression): boolean => {
      let cur: ts.Expression = expr;
      while (ts.isPropertyAccessExpression(cur)) {
        cur = cur.expression;
      }
      return ts.isIdentifier(cur) && brokerRoots.has(cur.text);
    };

    const push = (key: string, message: string, fixHint: string): void => {
      if (reported.has(key)) return;
      reported.add(key);
      issues.push({ severity: "error", category: "broker", message, fixHint });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const method = callee.name.text;
        const receiver = callee.expression;

        // Track variables holding broker exec results.
        // (Handled on the VariableDeclaration below; nothing to do here.)

        // exec/execute invoked without a broker family segment
        // (broker.exec(...), context.exec(...), context.broker.exec(...)).
        if (method === "exec" || method === "execute") {
          const segments: string[] = [];
          let cur: ts.Expression = receiver;
          while (ts.isPropertyAccessExpression(cur)) {
            segments.unshift(cur.name.text);
            cur = cur.expression;
          }
          const rootIsBroker = ts.isIdentifier(cur) && brokerRoots.has(cur.text);
          const hasFamily = segments.some((s) => ["fs", "net", "cmd", "secret"].includes(s));
          if (rootIsBroker && !hasFamily) {
            const rendered = [...(ts.isIdentifier(cur) ? [cur.text] : []), ...segments].join(".");
            push(
              `${rendered}.${method}`,
              `Broker contract violation: '${rendered}.${method}(...)' does not exist. The command broker is 'context.broker.cmd.exec(command, args?, options?)' (also exposed as 'context.cmd.exec').`,
              "Route command execution through the cmd family: await context.broker.cmd.exec('git', ['status', '--porcelain']).",
            );
          }
        }

        // <chain>.cmd.execute(...) — CmdBrokerClient has exec only.
        if (
          method === "execute" &&
          ts.isPropertyAccessExpression(receiver) &&
          receiver.name.text === "cmd" &&
          isBrokerishChain(receiver)
        ) {
          push(
            "cmd.execute",
            "Broker contract violation: 'cmd.execute(...)' does not exist. CmdBrokerClient exposes 'exec(command, args?, options?)'.",
            "Rename the call to exec: await context.broker.cmd.exec(command, args).",
          );
        }
      }

      // const x = await <brokerish chain>.exec|execute(...)
      if (ts.isVariableDeclaration(node) && node.initializer) {
        let init: ts.Expression = node.initializer;
        if (ts.isAwaitExpression(init)) {
          init = init.expression;
        }
        if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)) {
          const method = init.expression.name.text;
          if (
            (method === "exec" || method === "execute") &&
            isBrokerishChain(init.expression.expression)
          ) {
            if (ts.isIdentifier(node.name)) {
              execResultVars.add(node.name.text);
            } else if (ts.isObjectBindingPattern(node.name)) {
              // const { exitCode, stdout } = await ...exec(...)
              const bindsExitCode = node.name.elements.some((el) => {
                const named: ts.Node = el.propertyName ?? el.name;
                return (
                  (ts.isIdentifier(named) || ts.isStringLiteral(named)) &&
                  named.text === "exitCode"
                );
              });
              if (!bindsExitCode) {
                push(
                  "destructure-no-exitcode",
                  "Broker contract violation: destructured cmd.exec result does not bind 'exitCode'. Non-zero exits resolve as data; tools must inspect exitCode to report failure.",
                  "Bind and check exitCode: const { exitCode, stdout, stderr } = await context.broker.cmd.exec(...); if (exitCode !== 0) return { success: false, ... }. ",
                );
              }
            }

            // Shell operators in the args array reach the process literally.
            const argsArg = init.arguments[1];
            if (argsArg && ts.isArrayLiteralExpression(argsArg)) {
              for (const el of argsArg.elements) {
                if (ts.isStringLiteral(el) && shellOperators.has(el.text)) {
                  push(
                    `shell-op-${el.text}`,
                    `Broker contract violation: cmd.exec does not invoke a shell; '${el.text}' would be passed to the process as a literal argument.`,
                    "Split chained commands into separate cmd.exec calls and combine their outputs in code.",
                  );
                }
              }
            }
          }
        }
      }

      // await <brokerish>.exec(...) as a bare statement — result discarded.
      if (ts.isExpressionStatement(node)) {
        let expr: ts.Expression = node.expression;
        if (ts.isAwaitExpression(expr)) {
          expr = expr.expression;
        }
        if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
          const method = expr.expression.name.text;
          if (
            (method === "exec" || method === "execute") &&
            isBrokerishChain(expr.expression.expression)
          ) {
            push(
              "exec-result-discarded",
              "Broker contract violation: cmd.exec result discarded. Non-zero exit codes resolve as data (they do not throw); an unchecked result hides command failures.",
              "Assign the result and check exitCode: const r = await context.broker.cmd.exec(...); if (r.exitCode !== 0) return { success: false, error: r.stderr }. ",
            );
          }
        }
      }

      // <execVar>.exitCode read — marks the result as inspected.
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.name.text === "exitCode" &&
        execResultVars.has(node.expression.text)
      ) {
        exitCodeReadVars.add(node.expression.text);
      }

      // <execVar>.<hallucinated field>
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const varName = node.expression.text;
        const field = node.name.text;
        if (execResultVars.has(varName) && hallucinatedResultFields.has(field)) {
          push(
            `${varName}.${field}`,
            `Broker contract violation: '${varName}.${field}' does not exist. cmd.exec() resolves '{ exitCode, stdout, stderr }'.`,
            `Use '${varName}.exitCode', '${varName}.stdout', or '${varName}.stderr'.`,
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // exec results whose exitCode is never read report failures as success.
    for (const varName of execResultVars) {
      if (!exitCodeReadVars.has(varName)) {
        push(
          `${varName}.exitCode-unchecked`,
          `Broker contract violation: '${varName}' holds a cmd.exec result but its exitCode is never inspected. Non-zero exits resolve as data, so the tool cannot detect command failure.`,
          `Check the exit status: if (${varName}.exitCode !== 0) return { success: false, error: ${varName}.stderr }.`,
        );
      }
    }
  }
}
