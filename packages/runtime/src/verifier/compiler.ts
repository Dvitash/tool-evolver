import ts from "typescript";
import type { CompilerOptions, TypeCheckDiagnostic, TypeCheckResult } from "./types.js";

/**
 * Pinned ambient type definitions for SDK and standard contracts.
 */
export const PINNED_SDK_DECLARATIONS = `
declare module "@tool-evolver/runtime" {
  export interface ToolContext<TInput = Record<string, unknown>> {
    input: TInput;
    sessionId?: string;
    invocationId?: string;
    workspaceRoot?: string;
    scratchDir?: string;
    signal?: AbortSignal;
    brokers?: ToolBrokerClient;
    log?: (message: string, details?: Record<string, unknown>) => void;
    progress?: (progress: number, message?: string) => void;
  }

  export interface ToolBrokerClient {
    fs?: FsBrokerClient;
    cmd?: CmdBrokerClient;
    net?: NetBrokerClient;
    secrets?: SecretBrokerClient;
  }

  export interface FsBrokerClient {
    readFile(path: string): Promise<Uint8Array>;
    readTextFile(path: string): Promise<string>;
    writeFile(path: string, content: Uint8Array | string): Promise<void>;
    listDirectory(path: string): Promise<string[]>;
    stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean }>;
    exists(path: string): Promise<boolean>;
    deleteFile(path: string): Promise<void>;
  }

  export interface CommandExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
  }

  export interface CmdBrokerClient {
    exec(command: string, args: string[], options?: { timeoutMs?: number; env?: Record<string, string>; cwd?: string }): Promise<CommandExecutionResult>;
  }

  export interface HttpResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    json<T = unknown>(): Promise<T>;
  }

  export interface NetBrokerClient {
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<HttpResponse>;
  }

  export type SecretMediationMode = "opaque_reference" | "injected_header" | "redacted_body";

  export interface SecretReference {
    readonly __secretRef: true;
    readonly referenceId: string;
    readonly key: string;
    readonly mode: SecretMediationMode;
    readonly template?: string;
    readonly headerName?: string;
  }

  export interface SecretBrokerClient {
    resolveReference(key: string, mode?: SecretMediationMode): Promise<SecretReference>;
    bearerToken(key: string): Promise<SecretReference>;
    formatTemplate(template: string, replacements: Record<string, string>): Promise<SecretReference>;
  }

  export interface ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
    execute: (context: ToolContext<TInput>) => Promise<TOutput> | TOutput;
  }

  export function defineTool<TInput = Record<string, unknown>, TOutput = unknown>(
    handler: ((context: ToolContext<TInput>) => Promise<TOutput> | TOutput) | ToolDefinition<TInput, TOutput>
  ): ToolDefinition<TInput, TOutput>;

  export function bearerToken(key: string): Promise<SecretReference>;
  export function formatSecretTemplate(template: string, replacements: Record<string, string>): Promise<SecretReference>;
  export function createSecretReference(key: string, mode?: SecretMediationMode, template?: string, headerName?: string): SecretReference;
}

declare module "zod" {
  export interface ZodType<T = unknown> {
    parse(data: unknown): T;
    safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
    optional(): ZodType<T | undefined>;
    nullable(): ZodType<T | null>;
    default(value: T): ZodType<T>;
    describe(description: string): ZodType<T>;
    _output: T;
    _input: unknown;
  }

  export interface ZodObject<T extends Record<string, ZodType<unknown>>> extends ZodType<{ [K in keyof T]: T[K] extends ZodType<infer U> ? U : never }> {
    extend<U extends Record<string, ZodType<unknown>>>(shape: U): ZodObject<T & U>;
    shape: T;
  }

  export interface ZodString extends ZodType<string> {
    min(length: number, message?: string): ZodString;
    max(length: number, message?: string): ZodString;
    email(message?: string): ZodString;
    url(message?: string): ZodString;
    uuid(message?: string): ZodString;
    regex(pattern: RegExp, message?: string): ZodString;
  }

  export interface ZodNumber extends ZodType<number> {
    min(value: number, message?: string): ZodNumber;
    max(value: number, message?: string): ZodNumber;
    int(message?: string): ZodNumber;
    positive(message?: string): ZodNumber;
    nonnegative(message?: string): ZodNumber;
  }

  export interface ZodBoolean extends ZodType<boolean> {}
  export interface ZodArray<T extends ZodType<unknown>> extends ZodType<Array<T extends ZodType<infer U> ? U : unknown>> {
    min(length: number): ZodArray<T>;
    max(length: number): ZodArray<T>;
  }
  export interface ZodRecord<V extends ZodType<unknown>> extends ZodType<Record<string, V extends ZodType<infer U> ? U : unknown>> {}
  export interface ZodEnum<T extends [string, ...string[]]> extends ZodType<T[number]> {}
  export interface ZodUnion<T extends readonly [ZodType<unknown>, ...ZodType<unknown>[]]> extends ZodType<T[number] extends ZodType<infer U> ? U : unknown> {}
  export interface ZodAny extends ZodType<unknown> {}
  export interface ZodUnknown extends ZodType<unknown> {}

  export namespace z {
    export type infer<T extends ZodType<unknown>> = T extends ZodType<infer U> ? U : unknown;
  }

  export const z: {
    object<T extends Record<string, ZodType<unknown>>>(shape: T): ZodObject<T>;
    string(): ZodString;
    number(): ZodNumber;
    boolean(): ZodBoolean;
    array<T extends ZodType<unknown>>(schema: T): ZodArray<T>;
    record<V extends ZodType<unknown>>(valueType: V): ZodRecord<V>;
    enum<T extends [string, ...string[]]>(values: T): ZodEnum<T>;
    union<T extends readonly [ZodType<unknown>, ...ZodType<unknown>[]]>(schemas: T): ZodUnion<T>;
    any(): ZodAny;
    unknown(): ZodUnknown;
    infer<T extends ZodType<unknown>>: T extends ZodType<infer U> ? U : never;
  };
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
}
declare module "path" {
  export * from "node:path";
}

declare module "node:crypto" {
  export function randomUUID(): string;
  export function randomBytes(size: number): Uint8Array;
  export function createHash(algorithm: string): { update(data: unknown): { digest(encoding?: string): string } };
}
declare module "crypto" {
  export * from "node:crypto";
}

declare module "node:util" {
  export function format(format?: unknown, ...param: unknown[]): string;
  export function inspect(object: unknown, options?: unknown): string;
}
declare module "util" {
  export * from "node:util";
}

declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(data: unknown, encoding?: string): Buffer;
    static alloc(size: number): Buffer;
    toString(encoding?: string): string;
  }
}
declare module "buffer" {
  export * from "node:buffer";
}
`;

/**
 * Standard compiler options for candidate verification.
 */
export const STRICT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noUnusedLocals: false,
  strictNullChecks: true,
  strictFunctionTypes: true,
  strictBindCallApply: true,
  strictPropertyInitialization: true,
  noImplicitThis: true,
  alwaysStrict: true,
  noUnusedParameters: false,
  skipLibCheck: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  isolatedModules: true,
  noEmitOnError: false,
};

/**
 * Compiles and strictly type-checks generated tool TypeScript against the pinned SDK.
 */
export function compileAndTypeCheck(
  sourceCode: string,
  options: CompilerOptions = {},
): TypeCheckResult {
  const fileName = options.fileName ?? "candidate.ts";
  const sdkFileName = "tool-evolver-sdk.d.ts";

  const virtualFiles = new Map<string, string>();
  virtualFiles.set(fileName, sourceCode);
  virtualFiles.set(sdkFileName, PINNED_SDK_DECLARATIONS);

  if (options.extraDeclarations) {
    for (const [declName, content] of Object.entries(options.extraDeclarations)) {
      virtualFiles.set(declName, content);
    }
  }

  const compilerOptions: ts.CompilerOptions = {
    ...STRICT_COMPILER_OPTIONS,
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(options.module !== undefined ? { module: options.module } : {}),
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
  };

  const outputs = new Map<string, string>();

  const defaultHost = ts.createCompilerHost(compilerOptions);

  // Custom in-memory compiler host delegating to defaultHost for libs
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (name, languageVersion) => {
      const content = virtualFiles.get(name);
      if (content !== undefined) {
        return ts.createSourceFile(name, content, languageVersion, true);
      }
      return defaultHost.getSourceFile(name, languageVersion);
    },
    writeFile: (name, text) => {
      outputs.set(name, text);
    },
    fileExists: (name) => virtualFiles.has(name) || defaultHost.fileExists(name),
    readFile: (name) => virtualFiles.get(name) ?? defaultHost.readFile(name),
  };

  const program = ts.createProgram([fileName, sdkFileName], compilerOptions, host);
  const emitResult = program.emit();

  const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

  const errors: string[] = [];
  const diagnostics: TypeCheckDiagnostic[] = [];

  for (const diag of allDiagnostics) {
    // Only capture diagnostics from our target file, not ambient defs
    if (diag.file && diag.file.fileName !== fileName) {
      continue;
    }

    const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    let line: number | undefined;
    let character: number | undefined;

    if (diag.file && diag.start !== undefined) {
      const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
      line = pos.line + 1;
      character = pos.character + 1;
    }

    const categoryStr: TypeCheckDiagnostic["category"] =
      diag.category === ts.DiagnosticCategory.Error
        ? "error"
        : diag.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : diag.category === ts.DiagnosticCategory.Suggestion
            ? "suggestion"
            : "message";

    diagnostics.push({
      category: categoryStr,
      code: diag.code,
      message,
      line,
      character,
      file: diag.file?.fileName,
    });

    if (diag.category === ts.DiagnosticCategory.Error) {
      const locStr = line ? ` (line ${line}, col ${character})` : "";
      errors.push(`TS${diag.code}${locStr}: ${message}`);
    }
  }

  // Validate entrypoint export structure
  const sourceFile = program.getSourceFile(fileName);
  if (sourceFile) {
    let hasExport = false;
    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement)) {
        hasExport = true;
        break;
      }
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        hasExport = true;
        break;
      }
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        hasExport = true;
        break;
      }
    }

    if (!hasExport) {
      errors.push(
        "Candidate source must export a default tool handler, defineTool call, or named execute function.",
      );
      diagnostics.push({
        category: "error",
        code: 9901,
        message: "Missing export in tool entrypoint",
        file: fileName,
      });
    }
  }

  const outJsName = fileName.replace(/\.ts$/, ".js");
  const jsCode =
    outputs.get(outJsName) ??
    outputs.get(`/${outJsName}`) ??
    Array.from(outputs.values())[0] ??
    ts.transpileModule(sourceCode, { compilerOptions }).outputText;

  return {
    passed: errors.length === 0,
    errors,
    diagnostics,
    jsCode,
  };
}

/**
 * Pinned TypeScript compiler and schema consistency validator instance.
 */
export class CandidateCompiler {
  constructor(private readonly defaultOptions: CompilerOptions = {}) {}

  compile(sourceCode: string, options?: CompilerOptions): TypeCheckResult {
    return compileAndTypeCheck(sourceCode, { ...this.defaultOptions, ...options });
  }
}
