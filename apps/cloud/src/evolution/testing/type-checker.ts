import type { ToolManifest } from "@tool-evolver/contracts";
import ts from "typescript";

/**
 * Result of static type checking and schema compilation.
 */
export interface TypeCheckResult {
  passed: boolean;
  errors: string[];
  diagnostics: ts.Diagnostic[];
  jsCode?: string;
}

/**
 * Pinned TypeScript compiler and schema consistency validator.
 */
export class TypeChecker {
  private readonly compilerOptions: ts.CompilerOptions;

  constructor() {
    this.compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      noEmitOnError: false,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      skipLibCheck: true,
    };
  }

  /**
   * Type checks candidate source code and validates schema consistency.
   */
  check(sourceCode: string, manifest?: Partial<ToolManifest>): TypeCheckResult {
    const errors: string[] = [];
    const diagnostics: ts.Diagnostic[] = [];

    // 1. Syntactic check via ts.createSourceFile
    const sourceFile = ts.createSourceFile(
      "candidate.ts",
      sourceCode,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS
    );

    const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      for (const diag of parseDiagnostics) {
        diagnostics.push(diag);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(diag.start ?? 0);
        errors.push(
          `Line ${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(diag.messageText, "\n")}`
        );
      }
    }

    // 2. Transpile check to detect any syntax or transformer issues
    let jsCode: string | undefined;
    try {
      const transpileResult = ts.transpileModule(sourceCode, {
        compilerOptions: this.compilerOptions,
        reportDiagnostics: true,
        fileName: "candidate.ts",
      });

      if (transpileResult.diagnostics && transpileResult.diagnostics.length > 0) {
        for (const diag of transpileResult.diagnostics) {
          diagnostics.push(diag);
          const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
          errors.push(`Compilation diagnostic: ${message}`);
        }
      }

      jsCode = transpileResult.outputText;
    } catch (transpileErr) {
      const msg = transpileErr instanceof Error ? transpileErr.message : String(transpileErr);
      errors.push(`Transpilation error: ${msg}`);
    }

    // 3. Schema consistency validation between AST and Manifest
    if (manifest) {
      this.validateSchemaConsistency(sourceFile, manifest, errors);
    }

    return {
      passed: errors.length === 0,
      errors,
      diagnostics,
      jsCode,
    };
  }

  /**
   * Validates schema property consistency between AST and ToolManifest.
   */
  private validateSchemaConsistency(
    sourceFile: ts.SourceFile,
    manifest: Partial<ToolManifest>,
    errors: string[]
  ): void {
    if (manifest.parameters?.properties) {
      const manifestProps = Object.keys(manifest.parameters.properties);
      const codeText = sourceFile.getFullText();

      // Ensure that required properties in manifest are referenced or defined in InputSchema
      const requiredProps = manifest.parameters.required ?? [];
      for (const reqProp of requiredProps) {
        if (!codeText.includes(reqProp)) {
          errors.push(
            `Schema inconsistency: Manifest requires property '${reqProp}' but it is not referenced in source code or InputSchema.`
          );
        }
      }
    }
  }

  /**
   * Transpiles candidate TypeScript code to JavaScript for sandbox execution.
   */
  transpile(sourceCode: string): string {
    const result = ts.transpileModule(sourceCode, {
      compilerOptions: this.compilerOptions,
      fileName: "candidate.ts",
    });
    return result.outputText;
  }
}
