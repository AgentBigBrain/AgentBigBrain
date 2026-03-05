/**
 * @fileoverview Enforces function-level JSDoc coverage for source modules, including tests.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

interface Violation {
  file: string;
  line: number;
  column: number;
  name: string;
  kind: string;
}

/**
 * Implements collect source files behavior used by `checkFunctionDocs`.
 *
 * **Why it exists:**
 * Keeps `collect source files` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `readdirSync` (import `readdirSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param dir - Filesystem location used by this operation.
 * @returns Ordered collection produced by this step.
 */
function collectSourceFiles(dir: string): string[] {
  let files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectSourceFiles(fullPath));
      continue;
    }

    if (fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Evaluates js doc and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the js doc policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ts` (import `default`) from `typescript`.
 *
 * @param node - Value for node.
 * @returns `true` when this check passes.
 */
function hasJsDoc(node: ts.Node): boolean {
  const withDocs = node as ts.Node & { jsDoc?: ts.JSDoc[] };
  return Array.isArray(withDocs.jsDoc) && withDocs.jsDoc.length > 0;
}

/**
 * Evaluates function target and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the function target policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ts` (import `default`) from `typescript`.
 *
 * @param node - Value for node.
 * @returns Computed `node is ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration` result.
 */
function isFunctionTarget(node: ts.Node): node is ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Resolves node name from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of node name by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `ts` (import `default`) from `typescript`.
 *
 * @param node - Value for node.
 * @returns Resulting string value.
 */
function resolveNodeName(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration): string {
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }

  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  if (node.name && ts.isStringLiteral(node.name)) {
    return node.name.text;
  }

  return "anonymousFunction";
}

/**
 * Reads violations for file needed for this execution step.
 *
 * **Why it exists:**
 * Separates violations for file read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `readFileSync` (import `readFileSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 * - Uses `ts` (import `default`) from `typescript`.
 *
 * @param filePath - Filesystem location used by this operation.
 * @returns Ordered collection produced by this step.
 */
function getViolationsForFile(filePath: string): Violation[] {
  const text = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  /**
   * Implements visit behavior used by `checkFunctionDocs`.
   *
   * **Why it exists:**
   * Keeps `visit` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `path` (import `default`) from `node:path`.
   * - Uses `ts` (import `default`) from `typescript`.
   *
   * @param node - Value for node.
   */
  function visit(node: ts.Node): void {
    if (isFunctionTarget(node) && !hasJsDoc(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        file: path.relative(process.cwd(), filePath),
        line: position.line + 1,
        column: position.character + 1,
        name: resolveNodeName(node),
        kind: ts.SyntaxKind[node.kind]
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * Transforms violation into a stable output representation.
 *
 * **Why it exists:**
 * Keeps `format violation` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param violation - Value for violation.
 * @returns Resulting string value.
 */
function formatViolation(violation: Violation): string {
  return `${violation.file}:${violation.line}:${violation.column} missing JSDoc on ${violation.kind} \`${violation.name}\``;
}

/**
 * Runs the `checkFunctionDocs` entrypoint workflow.
 *
 * **Why it exists:**
 * Coordinates imported collaborators behind the `main` function boundary.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 */
function main(): void {
  const sourceRoot = path.join(process.cwd(), "src");
  const files = collectSourceFiles(sourceRoot);
  const violations = files.flatMap((filePath) => getViolationsForFile(filePath));

  if (violations.length === 0) {
    console.log("Function documentation check passed.");
    return;
  }

  console.error("Function documentation check failed:");
  for (const violation of violations) {
    console.error(`- ${formatViolation(violation)}`);
  }
  process.exitCode = 1;
}

main();
