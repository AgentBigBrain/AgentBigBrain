/**
 * @fileoverview Resolves deterministic shell postcondition failures for bounded scaffold/build workflows.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { getPathModuleForContext } from "./shellExecutionPathSupport";

const VITE_SCAFFOLD_COMMAND_PATTERN =
  /\b(?:npm|npx)(?:\.cmd)?\s+(?:create\s+vite(?:@latest)?|create-vite(?:@latest)?|init\s+vite(?:@latest)?)\b/i;
const NEXT_SCAFFOLD_COMMAND_PATTERN =
  /\b(?:npx(?:\.cmd)?\s+create-next-app(?:@latest)?|npm(?:\.cmd)?\s+create\s+next-app(?:@latest)?)\b/i;
const POWERSHELL_VARIABLE_ASSIGNMENT_PATTERN =
  /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
const POWERSHELL_SET_LOCATION_PATTERN =
  /\bSet-Location\b\s+(?:(?:"([^"]+)")|(?:'([^']+)')|(\$[A-Za-z_][A-Za-z0-9_]*))/gi;
const NPM_RUN_BUILD_COMMAND_PATTERN = /^\s*npm(?:\.cmd)?\s+run\s+build\b/i;
const PACKAGE_JSON_FILENAME = "package.json";
const VITE_DIST_INDEX_RELATIVE_PATH = path.join("dist", "index.html");
const NEXT_BUILD_ID_RELATIVE_PATH = path.join(".next", "BUILD_ID");

export interface ShellPostconditionFailure {
  message: string;
}

const PACKAGE_MANAGER_WORKSPACE_COMMAND_PATTERN =
  /^\s*(?:npm|npx|pnpm|yarn|bun)(?:\.cmd)?\s+(?:install|ci|run\s+(?:build|dev|preview|start))\b/i;
const VITE_NATIVE_WORKSPACE_COMMAND_PATTERN =
  /^\s*vite\b(?:\s+(?:build|dev|preview))\b/i;
const SHELL_ARGUMENT_SEPARATOR_TOKENS = new Set(["&&", "||", "|"]);
const SHELL_OPTIONS_WITH_VALUE = new Set(["-t", "--template", "--variant"]);
const SHELL_BOOLEAN_OPTIONS = new Set([
  "-i",
  "--immediate",
  "--interactive",
  "--no-interactive"
]);

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
  const pathModule = getPathModuleForContext(cwd, expression);
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
    return pathModule.resolve(cwd, assignedValue);
  }
  return pathModule.resolve(cwd, trimmed);
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
 * Tokenizes one bounded shell command suffix into quoted or whitespace-delimited arguments.
 *
 * @param value - Command suffix that appears after the scaffold executable name.
 * @returns Ordered argument tokens without surrounding quotes.
 */
function tokenizeShellSuffix(value: string): string[] {
  const tokens: string[] = [];
  for (const match of value.matchAll(/"([^"]+)"|'([^']+)'|([^\s;]+)/g)) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Extracts the first positional shell argument from one token stream while skipping bounded
 * scaffold flags and terminating when the command suffix moves into a later shell segment.
 *
 * @param tokens - Ordered command suffix tokens.
 * @returns First positional argument token, or `null` when none can be resolved safely.
 */
function extractFirstPositionalShellArgument(tokens: readonly string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (SHELL_ARGUMENT_SEPARATOR_TOKENS.has(token)) {
      break;
    }
    if (token === "--") {
      continue;
    }
    const normalizedToken = token.toLowerCase();
    if (
      normalizedToken.startsWith("--template=") ||
      normalizedToken.startsWith("--variant=")
    ) {
      continue;
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(normalizedToken)) {
      index += 1;
      continue;
    }
    if (SHELL_BOOLEAN_OPTIONS.has(normalizedToken)) {
      continue;
    }
    if (normalizedToken.startsWith("-")) {
      continue;
    }
    return token;
  }
  return null;
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
  const powerShellAssignments = extractPowerShellVariableAssignments(normalized);
  const explicitFinalRoot = powerShellAssignments.get("final");
  if (explicitFinalRoot) {
    return getPathModuleForContext(cwd, explicitFinalRoot).resolve(cwd, explicitFinalRoot);
  }
  const rawSuffix = normalized.slice(scaffoldMatch.index + scaffoldMatch[0].length).trim();
  const suffixTokens = tokenizeShellSuffix(rawSuffix);
  const rawTarget = extractFirstPositionalShellArgument(suffixTokens);
  if (!rawTarget) {
    return null;
  }
  const scaffoldCwd = resolvePowerShellWorkingDirectoryBeforeScaffold(
    normalized.slice(0, scaffoldMatch.index),
    cwd,
    powerShellAssignments
  );
  const pathModule = getPathModuleForContext(scaffoldCwd, rawTarget);
  const resolvedTarget = resolvePowerShellLocationExpression(
    rawTarget,
    scaffoldCwd,
    powerShellAssignments
  );
  return resolvedTarget ?? pathModule.resolve(scaffoldCwd, rawTarget);
}

/**
 * Determines whether the current working directory is already a Vite workspace.
 *
 * @param cwd - Effective working directory used for the shell command.
 * @returns `true` when the workspace contains Vite scripts or dependencies.
 */
async function isViteWorkspace(cwd: string): Promise<boolean> {
  const pathModule = getPathModuleForContext(cwd);
  const packageJsonPath = pathModule.join(cwd, PACKAGE_JSON_FILENAME);
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
 * Determines whether the current working directory is already a Next.js workspace.
 *
 * @param cwd - Effective working directory used for the shell command.
 * @returns `true` when the workspace contains Next.js scripts or dependencies.
 */
async function isNextWorkspace(cwd: string): Promise<boolean> {
  const pathModule = getPathModuleForContext(cwd);
  const packageJsonPath = pathModule.join(cwd, PACKAGE_JSON_FILENAME);
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
    if (buildScript && /\bnext\s+build\b/i.test(buildScript)) {
      return true;
    }
    return (
      Object.prototype.hasOwnProperty.call(packageJson.dependencies ?? {}, "next") ||
      Object.prototype.hasOwnProperty.call(packageJson.devDependencies ?? {}, "next")
    );
  } catch {
    return false;
  }
}

/**
 * Determines whether the current working directory is a recognized local frontend workspace.
 *
 * @param cwd - Effective working directory used for the shell command.
 * @returns `true` when the workspace is recognized as Vite or Next.js.
 */
async function isRecognizedFrontendWorkspace(cwd: string): Promise<boolean> {
  if (await isViteWorkspace(cwd)) {
    return true;
  }
  return isNextWorkspace(cwd);
}

/**
 * Extracts the final Desktop project directory for a Next.js scaffold shell command.
 *
 * Generated framework scaffold commands often bootstrap in a temp slug and then move the finished
 * project into an exact human-facing Desktop folder tracked by `$final`. When that bounded final
 * destination is present, continuity should anchor there rather than to the temp slug.
 *
 * @param command - Raw shell command requested by the planner/runtime.
 * @param cwd - Effective cwd used for the shell execution.
 * @returns Absolute project root, or `null` when the command is not a recognized Next scaffold.
 */
function extractNextScaffoldTargetRoot(command: string, cwd: string): string | null {
  const normalized = command.trim();
  const scaffoldMatch = NEXT_SCAFFOLD_COMMAND_PATTERN.exec(normalized);
  if (!scaffoldMatch) {
    return null;
  }
  const powerShellAssignments = extractPowerShellVariableAssignments(normalized);
  const explicitFinalRoot = powerShellAssignments.get("final");
  if (explicitFinalRoot) {
    return getPathModuleForContext(cwd, explicitFinalRoot).resolve(cwd, explicitFinalRoot);
  }
  const scaffoldCwd = resolvePowerShellWorkingDirectoryBeforeScaffold(
    normalized.slice(0, scaffoldMatch.index),
    cwd,
    powerShellAssignments
  );
  const targetMatch = normalized.match(
    /(?:create-next-app|next-app)(?:@latest)?\s+(?:"([^"]+)"|'([^']+)'|(\$[A-Za-z_][A-Za-z0-9_]*)|([^\s;]+))/i
  );
  const rawTarget =
    targetMatch?.[1] ?? targetMatch?.[2] ?? targetMatch?.[3] ?? targetMatch?.[4] ?? null;
  if (!rawTarget) {
    return null;
  }
  const pathModule = getPathModuleForContext(scaffoldCwd, rawTarget);
  const resolvedTarget = resolvePowerShellLocationExpression(
    rawTarget,
    scaffoldCwd,
    powerShellAssignments
  );
  return resolvedTarget ?? pathModule.resolve(scaffoldCwd, rawTarget);
}

/**
 * Resolves the strongest workspace root that a successful shell command just acted on.
 *
 * @param command - Raw shell command requested by the planner/runtime.
 * @param cwd - Effective cwd used for the shell command.
 * @returns Workspace root path, or `null` when no bounded workspace anchor applies.
 */
export async function resolveShellSuccessWorkspaceRoot(
  command: string,
  cwd: string
): Promise<string | null> {
  const nextScaffoldRoot = extractNextScaffoldTargetRoot(command, cwd);
  if (nextScaffoldRoot) {
    return nextScaffoldRoot;
  }

  const viteScaffoldRoot = extractViteScaffoldTargetRoot(command, cwd);
  if (viteScaffoldRoot) {
    return viteScaffoldRoot;
  }

  if (
    (PACKAGE_MANAGER_WORKSPACE_COMMAND_PATTERN.test(command) ||
      VITE_NATIVE_WORKSPACE_COMMAND_PATTERN.test(command)) &&
    (await isRecognizedFrontendWorkspace(cwd))
  ) {
    return cwd;
  }

  return null;
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
  const nextScaffoldRoot = extractNextScaffoldTargetRoot(command, cwd);
  if (nextScaffoldRoot) {
    const packageJsonPath = getPathModuleForContext(nextScaffoldRoot).join(
      nextScaffoldRoot,
      PACKAGE_JSON_FILENAME
    );
    if (!(await pathExists(packageJsonPath))) {
      return {
        message:
          `Shell failed: Next.js scaffold did not create the expected ${PACKAGE_JSON_FILENAME} at ${packageJsonPath}.`
      };
    }
    return null;
  }

  const viteScaffoldRoot = extractViteScaffoldTargetRoot(command, cwd);
  if (viteScaffoldRoot) {
    const packageJsonPath = getPathModuleForContext(viteScaffoldRoot).join(
      viteScaffoldRoot,
      PACKAGE_JSON_FILENAME
    );
    if (!(await pathExists(packageJsonPath))) {
      return {
        message:
          `Shell failed: Vite scaffold did not create the expected ${PACKAGE_JSON_FILENAME} at ${packageJsonPath}.`
      };
    }
    return null;
  }

  if (NPM_RUN_BUILD_COMMAND_PATTERN.test(command) && (await isViteWorkspace(cwd))) {
    const distIndexPath = getPathModuleForContext(cwd).join(cwd, VITE_DIST_INDEX_RELATIVE_PATH);
    if (!(await pathExists(distIndexPath))) {
      return {
        message:
          `Shell failed: Vite build did not produce the expected ${VITE_DIST_INDEX_RELATIVE_PATH} at ${distIndexPath}.`
      };
    }
    return null;
  }

  if (NPM_RUN_BUILD_COMMAND_PATTERN.test(command) && (await isNextWorkspace(cwd))) {
    const buildIdPath = getPathModuleForContext(cwd).join(cwd, NEXT_BUILD_ID_RELATIVE_PATH);
    if (!(await pathExists(buildIdPath))) {
      return {
        message:
          `Shell failed: Next.js build did not produce the expected ${NEXT_BUILD_ID_RELATIVE_PATH} at ${buildIdPath}.`
      };
    }
  }

  return null;
}
