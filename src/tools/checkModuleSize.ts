/**
 * @fileoverview Enforces file-size limits for AI-first subsystems and thin compatibility entrypoints.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface ModuleSizeRule {
  label: string;
  maxLines: number;
  exactPath?: string;
  pathPrefix?: string;
}

export interface ModuleSizeViolation {
  path: string;
  lineCount: number;
  maxLines: number;
  ruleLabel: string;
}

export interface ModuleSizeDiagnostics {
  checkedFileCount: number;
  violations: ModuleSizeViolation[];
}

export const DEFAULT_MODULE_SIZE_RULES: readonly ModuleSizeRule[] = [
  { label: "agentLoop_entrypoint", exactPath: "src/core/agentLoop.ts", maxLines: 750 },
  { label: "autonomy_subsystem", pathPrefix: "src/core/autonomy/", maxLines: 650 },
  { label: "default_governor_entrypoint", exactPath: "src/governors/defaultGovernors.ts", maxLines: 100 },
  { label: "default_governor_subsystem", pathPrefix: "src/governors/defaultCouncil/", maxLines: 325 },
  { label: "planner_entrypoint", exactPath: "src/organs/planner.ts", maxLines: 750 },
  { label: "planner_policy_subsystem", pathPrefix: "src/organs/plannerPolicy/", maxLines: 400 },
  { label: "live_run_subsystem", pathPrefix: "src/organs/liveRun/", maxLines: 700 },
  { label: "user_facing_result_shim", exactPath: "src/interfaces/userFacingResult.ts", maxLines: 100 },
  { label: "user_facing_subsystem", pathPrefix: "src/interfaces/userFacing/", maxLines: 650 }
] as const;

/**
 * Computes module-size diagnostics from in-memory file records.
 *
 * **Why it exists:**
 * Tests need deterministic coverage without depending on the real repo tree, and the CLI entrypoint
 * needs one shared evaluation path.
 *
 * **What it talks to:**
 * - Uses local rule-matching helpers within this module.
 *
 * @param records - Relative path and line-count records to evaluate.
 * @param rules - Module-size rules applied in priority order.
 * @returns Diagnostics with checked-file count and any violations.
 */
export function computeModuleSizeDiagnosticsFromRecords(
  records: readonly { path: string; lineCount: number }[],
  rules: readonly ModuleSizeRule[] = DEFAULT_MODULE_SIZE_RULES
): ModuleSizeDiagnostics {
  const violations: ModuleSizeViolation[] = [];
  let checkedFileCount = 0;

  for (const record of records) {
    const matchedRule = rules.find((rule) => matchesRule(record.path, rule));
    if (!matchedRule) {
      continue;
    }

    checkedFileCount += 1;
    if (record.lineCount > matchedRule.maxLines) {
      violations.push({
        path: record.path,
        lineCount: record.lineCount,
        maxLines: matchedRule.maxLines,
        ruleLabel: matchedRule.label
      });
    }
  }

  return {
    checkedFileCount,
    violations
  };
}

/**
 * Computes module-size diagnostics for the repository rooted at `rootDir`.
 *
 * **Why it exists:**
 * Gives CI, tests, and local checks one deterministic module-size contract for the AI-first
 * surfaces instead of ad hoc line counting.
 *
 * **What it talks to:**
 * - Uses `readFileSync` from `node:fs`.
 * - Uses local directory traversal helpers within this module.
 *
 * @param rootDir - Repository root used to resolve TypeScript files under `src/`.
 * @param rules - Optional custom rules for tests or focused checks.
 * @returns Diagnostics describing any size regressions.
 */
export function computeModuleSizeDiagnostics(
  rootDir: string,
  rules: readonly ModuleSizeRule[] = DEFAULT_MODULE_SIZE_RULES
): ModuleSizeDiagnostics {
  const records = collectTypeScriptFileRecords(rootDir);
  return computeModuleSizeDiagnosticsFromRecords(records, rules);
}

/**
 * Fails closed when any targeted AI-first module exceeds its size budget.
 *
 * **Why it exists:**
 * The maintainability plan relies on extracted subsystems staying local and reviewable. This check
 * stops oversized drift before it becomes another giant catch-all file.
 *
 * **What it talks to:**
 * - Uses local diagnostics helpers within this module.
 *
 * @param rootDir - Repository root used to resolve TypeScript files under `src/`.
 * @param rules - Optional custom rules for tests or focused checks.
 */
export function assertModuleSize(
  rootDir: string,
  rules: readonly ModuleSizeRule[] = DEFAULT_MODULE_SIZE_RULES
): void {
  const diagnostics = computeModuleSizeDiagnostics(rootDir, rules);
  if (diagnostics.violations.length === 0) {
    return;
  }

  const lines = [
    "Module-size regression detected:",
    ...diagnostics.violations.map(
      (violation) =>
        `- ${violation.path}: ${violation.lineCount} lines (max ${violation.maxLines}, rule ${violation.ruleLabel})`
    )
  ];
  throw new Error(lines.join("\n"));
}

/**
 * Runs the module-size check entrypoint.
 *
 * **Why it exists:**
 * Makes the size contract runnable from package scripts and CI without duplicating assertion logic.
 *
 * **What it talks to:**
 * - Uses `assertModuleSize` from this module.
 *
 * @returns Nothing. Success or failure is reported through process output and exit code.
 */
function main(): void {
  try {
    assertModuleSize(process.cwd());
    console.log("Module-size check passed.");
  } catch (error) {
    console.error("Module-size check failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Collects relative TypeScript file records from the repo `src/` tree.
 *
 * **Why it exists:**
 * Keeps directory traversal and line counting in one helper so diagnostics stay deterministic.
 *
 * **What it talks to:**
 * - Uses local filesystem helpers within this module.
 *
 * @param rootDir - Repository root used to resolve the `src/` directory.
 * @returns Relative file records with normalized paths and line counts.
 */
function collectTypeScriptFileRecords(rootDir: string): Array<{ path: string; lineCount: number }> {
  const srcRoot = path.join(rootDir, "src");
  return walkDirectory(srcRoot).map((absolutePath) => ({
    path: normalizeRelativePath(path.relative(rootDir, absolutePath)),
    lineCount: countFileLines(absolutePath)
  }));
}

/**
 * Recursively walks a directory and returns all `.ts` file paths.
 *
 * **Why it exists:**
 * Centralizes filesystem traversal so module-size diagnostics and tests share one discovery path.
 *
 * **What it talks to:**
 * - Uses `readdirSync` and `statSync` from `node:fs`.
 *
 * @param directoryPath - Absolute directory path to walk.
 * @returns Absolute `.ts` file paths discovered under the directory.
 */
function walkDirectory(directoryPath: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directoryPath)) {
    const absolutePath = path.join(directoryPath, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      collected.push(...walkDirectory(absolutePath));
      continue;
    }
    if (absolutePath.endsWith(".ts")) {
      collected.push(absolutePath);
    }
  }
  return collected;
}

/**
 * Counts lines in a UTF-8 source file.
 *
 * **Why it exists:**
 * Keeps line-count semantics consistent across all module-size checks.
 *
 * **What it talks to:**
 * - Uses `readFileSync` from `node:fs`.
 *
 * @param filePath - Absolute file path to count.
 * @returns Line count using normalized newline splitting.
 */
function countFileLines(filePath: string): number {
  const contents = readFileSync(filePath, "utf8");
  return contents.length === 0 ? 0 : contents.split(/\r?\n/).length;
}

/**
 * Normalizes relative paths to forward-slash form.
 *
 * **Why it exists:**
 * Prevents Windows path separators from creating rule-matching drift.
 *
 * **What it talks to:**
 * - Uses local string normalization only.
 *
 * @param relativePath - Relative path derived from the filesystem.
 * @returns Forward-slash normalized relative path.
 */
function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

/**
 * Returns `true` when a relative path matches a module-size rule.
 *
 * **Why it exists:**
 * Rule matching needs one deterministic path so exact and prefix checks behave consistently.
 *
 * **What it talks to:**
 * - Uses local rule fields only.
 *
 * @param relativePath - Relative source path under evaluation.
 * @param rule - Module-size rule applied to the path.
 * @returns `true` when the path is covered by the rule.
 */
function matchesRule(relativePath: string, rule: ModuleSizeRule): boolean {
  if (rule.exactPath) {
    return relativePath === rule.exactPath;
  }
  if (rule.pathPrefix) {
    return relativePath.startsWith(rule.pathPrefix);
  }
  return false;
}

if (require.main === module) {
  main();
}
