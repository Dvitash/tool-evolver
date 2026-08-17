#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * @typedef {Object} PackageInfo
 * @property {string} dir - Relative directory path (e.g., "packages/contracts")
 * @property {string} fullDir - Absolute directory path
 * @property {string} name - Package name from package.json
 * @property {Record<string, string>} dependencies
 * @property {Record<string, string>} devDependencies
 * @property {Record<string, any>} exports
 */

/**
 * @typedef {Object} BoundaryViolation
 * @property {string} file - Relative path to the offending file
 * @property {number} line - 1-based line number
 * @property {string} importPath - The imported specifier
 * @property {string} rule - Rule violated
 * @property {string} message - Description of the violation
 */

const WORKSPACE_PATTERNS = ["apps", "packages", "adapters", "fixtures"];

/**
 * Discover all workspace packages.
 * @param {string} rootDir
 * @returns {Map<string, PackageInfo>} Map from package name to PackageInfo
 */
export function discoverPackages(rootDir) {
  const packages = new Map();

  for (const group of WORKSPACE_PATTERNS) {
    const groupDir = path.join(rootDir, group);
    if (!fs.existsSync(groupDir)) continue;

    const entries = fs.readdirSync(groupDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgDir = path.join(groupDir, entry.name);
      const pkgJsonPath = path.join(pkgDir, "package.json");

      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          packages.set(pkgJson.name, {
            dir: path.relative(rootDir, pkgDir),
            fullDir: pkgDir,
            name: pkgJson.name,
            dependencies: pkgJson.dependencies || {},
            devDependencies: pkgJson.devDependencies || {},
            exports: pkgJson.exports || {},
          });
        } catch (err) {
          console.warn(`Warning: Could not parse ${pkgJsonPath}:`, err);
        }
      }
    }
  }

  return packages;
}

/**
 * Extract imports from source file.
 * Handles `import ... from "..."`, `import("...")`, `export ... from "..."`, `require("...")`
 * @param {string} content
 * @returns {Array<{ importPath: string, line: number }>}
 */
export function extractImports(content) {
  const imports = [];
  const lines = content.split("\n");

  // Regex patterns for ES imports, dynamic imports, export re-exports, and require
  const staticImportRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip single line comments
    if (line.trim().startsWith("//")) continue;

    for (const match of line.matchAll(staticImportRegex)) {
      imports.push({ importPath: match[1], line: i + 1 });
    }

    for (const match of line.matchAll(dynamicImportRegex)) {
      imports.push({ importPath: match[1], line: i + 1 });
    }

    for (const match of line.matchAll(requireRegex)) {
      imports.push({ importPath: match[1], line: i + 1 });
    }
  }

  return imports;
}

/**
 * Check if an import specifier matches a valid declared export of a package.
 * @param {string} importPath
 * @param {string} pkgName
 * @param {Record<string, any>} exports
 * @returns {boolean}
 */
export function isValidExportMatch(importPath, pkgName, exports) {
  if (importPath === pkgName) {
    return "." in exports || typeof exports === "string";
  }

  if (importPath.startsWith(`${pkgName}/`)) {
    const subpath = `.${importPath.slice(pkgName.length)}`;
    if (subpath in exports) {
      return true;
    }
    // Pattern matching e.g. "./*": "./dist/*"
    for (const key of Object.keys(exports)) {
      if (key.endsWith("/*")) {
        const prefix = key.slice(0, -1);
        if (subpath.startsWith(prefix)) {
          return true;
        }
      }
    }
    return false;
  }

  return false;
}

/**
 * Scan a single package for boundary violations.
 * @param {PackageInfo} pkg
 * @param {Map<string, PackageInfo>} allPackages
 * @param {string} rootDir
 * @returns {BoundaryViolation[]}
 */
export function checkPackageBoundaries(pkg, allPackages, rootDir) {
  const violations = [];
  const srcAndTestDirs = [path.join(pkg.fullDir, "src"), path.join(pkg.fullDir, "tests")];

  const files = [];
  function collectFiles(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFiles(fullPath);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  for (const d of srcAndTestDirs) {
    collectFiles(d);
  }

  const allowedDeps = new Set([
    ...Object.keys(pkg.dependencies),
    ...Object.keys(pkg.devDependencies),
  ]);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf-8");
    const imports = extractImports(content);
    const relFile = path.relative(rootDir, filePath);
    const isTestFile = filePath.includes(`${path.sep}tests${path.sep}`);

    for (const { importPath, line } of imports) {
      // 1. Check relative imports crossing package boundary
      if (importPath.startsWith(".")) {
        const resolvedTarget = path.resolve(path.dirname(filePath), importPath);
        const relToPkg = path.relative(pkg.fullDir, resolvedTarget);

        // If relative import leaves the package root
        if (relToPkg.startsWith("..") || path.isAbsolute(relToPkg)) {
          violations.push({
            file: relFile,
            line,
            importPath,
            rule: "no-relative-cross-package",
            message: `Illegal relative import "${importPath}" crosses package boundary into "${relToPkg}". Use workspace package specifier instead.`,
          });
        }
        continue;
      }

      // 2. Check workspace package imports
      for (const [targetPkgName, targetPkg] of allPackages) {
        if (importPath === targetPkgName || importPath.startsWith(`${targetPkgName}/`)) {
          // Self-import is allowed if configured, but relative is preferred in src
          if (targetPkgName === pkg.name) {
            continue;
          }

          // Rule: Must be declared in dependencies / devDependencies
          if (!allowedDeps.has(targetPkgName)) {
            violations.push({
              file: relFile,
              line,
              importPath,
              rule: "undeclared-workspace-dependency",
              message: `Package "${pkg.name}" imports "${targetPkgName}" but it is not listed in package.json dependencies.`,
            });
          }

          // Rule: Cannot import internal paths directly (e.g. /src/...)
          if (importPath.includes("/src/") || importPath.includes("/dist/")) {
            violations.push({
              file: relFile,
              line,
              importPath,
              rule: "no-deep-internal-import",
              message: `Deep import into internal path "${importPath}" is forbidden. Import from declared package exports.`,
            });
          } else if (!isValidExportMatch(importPath, targetPkgName, targetPkg.exports)) {
            violations.push({
              file: relFile,
              line,
              importPath,
              rule: "unexported-subpath-import",
              message: `Import "${importPath}" does not match any declared export in "${targetPkgName}".`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Main boundary check function.
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ violations: BoundaryViolation[], packageCount: number }}
 */
export function checkBoundaries(rootDir = process.cwd()) {
  const allPackages = discoverPackages(rootDir);
  const allViolations = [];

  for (const pkg of allPackages.values()) {
    const pkgViolations = checkPackageBoundaries(pkg, allPackages, rootDir);
    allViolations.push(...pkgViolations);
  }

  return {
    violations: allViolations,
    packageCount: allPackages.size,
  };
}

// If run directly from CLI
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  console.log("🔍 Checking monorepo package boundaries...\n");
  const { violations, packageCount } = checkBoundaries();

  console.log(`Discovered ${packageCount} workspace packages.`);

  if (violations.length === 0) {
    console.log("✅ All package import boundaries are strictly respected! 0 violations found.\n");
    process.exit(0);
  } else {
    console.error(`❌ Found ${violations.length} boundary violation(s):\n`);
    for (const v of violations) {
      console.error(`  [${v.rule}] ${v.file}:${v.line}`);
      console.error(`    ${v.message}\n`);
    }
    process.exit(1);
  }
}
