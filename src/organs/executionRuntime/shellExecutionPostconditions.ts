/**
 * @fileoverview Resolves deterministic shell postcondition failures for bounded scaffold/build workflows.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";

const VITE_SCAFFOLD_COMMAND_PATTERN =
  /\b(?:npm|npx)(?:\.cmd)?\s+(?:create\s+vite(?:@latest)?|create-vite(?:@latest)?|init\s+vite(?:@latest)?)\b/i;
const POWERSHELL_VARIABLE_ASSIGNMENT_PATTERN =
  /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
const POWERSHELL_SET_LOCATION_PATTERN =
  /\bSet-Location\b\s+(?:(?:"([^"]+)")|(?:'([^']+)')|(\$[A-Za-z_][A-Za-z0-9_]*))/gi;
const NPM_RUN_BUILD_COMMAND_PATTERN = /^\s*npm(?:\.cmd)?\s+run\s+build\b/i;
const PACKAGE_JSON_FILENAME = "package.json";
const VITE_DIST_INDEX_RELATIVE_PATH = path.join("dist", "index.html");

export interface ShellPostconditionFailure {
  message: string;
}

/**
 * Checks whether a local filesystem path currently exists.
 *
 * @param targetPath - Absolute or cwd-resolved filesystem path to probe.
 * @returns `true` when the path exists and is accessible to the current process.
 */
async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads simple PowerShell string-variable assignments from a shell command so later path
 * expressions can be resolved deterministically.
 *
 * @param command - Raw shell command requested by the planner/runtime.
 * @returns Lowercased variable-name map to assigned string literal values.
 */
function extractPowerShellVariableAssignments(command: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const match of command.matchAll(POWERSHELL_VARIABLE_ASSIGNMENT_PATTERN)) {
    const variableName = match[1]?.trim().toLowerCase();
    const assignedValue = match[2] ?? match[3] ?? "";
    if (variableName && assignedValue.trim().length > 0) {
      assignments.set(variableName, assignedValue.trim());
    }
  }
  return assignments;
}

/**
 * Resolves one PowerShell location expression into an absolute path when it is a bounded literal
 * or a simple variable reference.
 *
 * @param expression - Raw location or target expression.
 * @param cwd - Effective cwd used for shell execution.
 * @param assignments - Previously extracted PowerShell variable assignments.
 * @returns Absolute path, or `null` when the expression cannot be resolved safely.
 */
function resolvePowerShellLocationExpression(
  expression: string,
  cwd: string,
  assignments: ReadonlyMap<string, string>
): string | null {
  const trimmed = expression.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "." || trimmed === ".\\" || trimmed === "./") {
    return cwd;
  }
  if (trimmed.startsWith("$")) {
    const variableName = trimmed.slice(1).trim().toLowerCase();
    const assignedValue = assignments.get(variableName);
    if (!assignedValue) {
      return null;
    }
    return path.resolve(cwd, assignedValue);
  }
  return path.resolve(cwd, trimmed);
}

/**
 * Resolves the effective PowerShell working directory immediately before the scaffold command when
 * the script changes location with `Set-Location`.
 *
 * @param commandPrefix - Command text that appears before the scaffold invocation.
 * @param cwd - Effective cwd used for shell execution.
 * @param assignments - Previously extracted PowerShell variable assignments.
 * @returns Effective working directory before the scaffold step.
 */
function resolvePowerShellWorkingDirectoryBeforeScaffold(
  commandPrefix: string,
  cwd: string,
  assignments: ReadonlyMap<string, string>
): string {
  let resolvedCwd = cwd;
  for (const match of commandPrefix.matchAll(POWERSHELL_SET_LOCATION_PATTERN)) {
    const expression = match[1] ?? match[2] ?? match[3] ?? "";
    const candidate = resolvePowerShellLocationExpression(expression, cwd, assignments);
    if (candidate) {
      resolvedCwd = candidate;
    }
  }
  return resolvedCwd;
}

/**
 * Extracts the target project directory for a Vite scaffold shell command when the command names
 * one explicitly.
 *
 * @param command - Raw shell command requested by the planner/runtime.
 * @param cwd - Effective cwd used for shell execution.
 * @returns Absolute project root, or `null` when the command is not a recognized Vite scaffold.
 */
function extractViteScaffoldTargetRoot(command: string, cwd: string): string | null {
  const normalized = command.trim();
  const scaffoldMatch = VITE_SCAFFOLD_COMMAND_PATTERN.exec(normalized);
  if (!scaffoldMatch) {
    return null;
  }
  const targetMatch = normalized.match(
    /(?:create\s+vite(?:@latest)?|create-vite(?:@latest)?|init\s+vite(?:@latest)?)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i
  );
  const rawTarget = targetMatch?.[1] ?? targetMatch?.[2] ?? targetMatch?.[3] ?? null;
  if (!rawTarget) {
    return null;
  }
  const powerShellAssignments = extractPowerShellVariableAssignments(normalized);
  const scaffoldCwd = resolvePowerShellWorkingDirectoryBeforeScaffold(
    normalized.slice(0, scaffoldMatch.index),
    cwd,
    powerShellAssignments
  );
  const resolvedTarget = resolvePowerShellLocationExpression(
    rawTarget,
    scaffoldCwd,
    powerShellAssignments
  );
  return resolvedTarget ? path.resolve(resolvedTarget) : path.resolve(scaffoldCwd, rawTarget);
}

/**
 * Determines whether the current working directory is already a Vite workspace.
 *
 * @param cwd - Effective working directory used for the shell command.
 * @returns `true` when the workspace contains Vite scripts or dependencies.
 */
async function isViteWorkspace(cwd: string): Promise<boolean> {
  const packageJsonPath = path.join(cwd, PACKAGE_JSON_FILENAME);
  if (!(await pathExists(packageJsonPath))) {
    return false;
  }
  try {
    const packageJsonText = await readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(packageJsonText) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const buildScript =
      typeof packageJson.scripts?.build === "string" ? packageJson.scripts.build : null;
    if (buildScript && /\bvite(?:\s|$)/i.test(buildScript)) {
      return true;
    }
    return (
      Object.prototype.hasOwnProperty.call(packageJson.dependencies ?? {}, "vite") ||
      Object.prototype.hasOwnProperty.call(packageJson.devDependencies ?? {}, "vite")
    );
  } catch {
    return false;
  }
}

/**
 * Resolves deterministic shell postcondition failures for scaffold/build commands that must leave
 * behind concrete local artifacts before downstream steps may proceed.
 *
 * @param command - Raw shell command requested by the planner/runtime.
 * @param cwd - Effective cwd used for shell execution.
 * @returns Failure descriptor, or `null` when no deterministic postcondition failed.
 */
export async function resolveShellPostconditionFailure(
  command: string,
  cwd: string
): Promise<ShellPostconditionFailure | null> {
  const viteScaffoldRoot = extractViteScaffoldTargetRoot(command, cwd);
  if (viteScaffoldRoot) {
    const packageJsonPath = path.join(viteScaffoldRoot, PACKAGE_JSON_FILENAME);
    if (!(await pathExists(packageJsonPath))) {
      return {
        message:
          `Shell failed: Vite scaffold did not create the expected ${PACKAGE_JSON_FILENAME} at ${packageJsonPath}.`
      };
    }
    return null;
  }

  if (NPM_RUN_BUILD_COMMAND_PATTERN.test(command) && (await isViteWorkspace(cwd))) {
    const distIndexPath = path.join(cwd, VITE_DIST_INDEX_RELATIVE_PATH);
    if (!(await pathExists(distIndexPath))) {
      return {
        message:
          `Shell failed: Vite build did not produce the expected ${VITE_DIST_INDEX_RELATIVE_PATH} at ${distIndexPath}.`
      };
    }
  }

  return null;
}
