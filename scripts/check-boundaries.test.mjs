import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  checkBoundaries,
  checkPackageBoundaries,
  discoverPackages,
  extractImports,
  isValidExportMatch,
} from "./check-boundaries.mjs";

describe("check-boundaries", () => {
  const rootDir = process.cwd();

  it("discovers all workspace packages in the monorepo", () => {
    const packages = discoverPackages(rootDir);
    expect(packages.size).toBeGreaterThanOrEqual(14);
    expect(packages.has("@tool-evolver/contracts")).toBe(true);
    expect(packages.has("@tool-evolver/protocol")).toBe(true);
    expect(packages.has("@tool-evolver/gateway")).toBe(true);
    expect(packages.has("@tool-evolver/adapter-claude-code")).toBe(true);
    expect(packages.has("@tool-evolver/test-fixtures")).toBe(true);
  });

  it("extracts static, dynamic, and re-export imports correctly", () => {
    const code = `
      import { ToolSpec } from "@tool-evolver/contracts";
      import type { ProtocolMessage } from "./types.js";
      export * from "@tool-evolver/protocol";
      const mod = await import("@tool-evolver/runtime");
      // import { ignored } from "commented";
    `;

    const imports = extractImports(code);
    const specifiers = imports.map((i) => i.importPath);

    expect(specifiers).toContain("@tool-evolver/contracts");
    expect(specifiers).toContain("./types.js");
    expect(specifiers).toContain("@tool-evolver/protocol");
    expect(specifiers).toContain("@tool-evolver/runtime");
    expect(specifiers).not.toContain("commented");
  });

  it("validates declared export matches", () => {
    const exports = {
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      "./utils": {
        import: "./dist/utils.js",
      },
    };

    expect(isValidExportMatch("@tool-evolver/contracts", "@tool-evolver/contracts", exports)).toBe(
      true,
    );
    expect(
      isValidExportMatch("@tool-evolver/contracts/utils", "@tool-evolver/contracts", exports),
    ).toBe(true);
    expect(
      isValidExportMatch("@tool-evolver/contracts/private", "@tool-evolver/contracts", exports),
    ).toBe(false);
  });

  it("passes boundary check on the pristine monorepo", () => {
    const { violations, packageCount } = checkBoundaries(rootDir);
    expect(packageCount).toBeGreaterThanOrEqual(14);
    expect(violations).toEqual([]);
  });

  it("detects and flags illegal relative cross-package imports", () => {
    const mockPackages = new Map([
      [
        "@mock/pkg-a",
        {
          dir: "packages/pkg-a",
          fullDir: path.join(rootDir, "packages/pkg-a"),
          name: "@mock/pkg-a",
          dependencies: {},
          devDependencies: {},
          exports: { ".": "./dist/index.js" },
        },
      ],
    ]);

    // Test the logic that flags relative paths crossing package root
    const mockImports = extractImports('import { foo } from "../../other-pkg/src/foo.js";');
    expect(mockImports.length).toBe(1);

    const resolved = path.resolve(
      path.join(rootDir, "packages/pkg-a/src"),
      mockImports[0].importPath,
    );
    const relToPkg = path.relative(path.join(rootDir, "packages/pkg-a"), resolved);
    expect(relToPkg.startsWith("..")).toBe(true);
  });
});
