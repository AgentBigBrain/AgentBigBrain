/**
 * @fileoverview Framework-app-specific planner repair helpers kept separate from generic planner
 * action normalization support.
 */

import { existsSync } from "node:fs";
import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import type { PlannedAction } from "../../core/types";
import type { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import {
  extractRequestedFrameworkFolderName,
  isFrameworkPackageSafeFolderName,
  toFrameworkPackageSafeSlug
} from "./frameworkBuildActionHeuristics";
import {
  getPathModuleForPathValue,
  resolvePreferredNextRouteDirectory
} from "./frameworkPathSupport";

const FRAMEWORK_CREATE_INVOCATION_PATTERN =
  /\b((?:npm(?:\.cmd)?\s+create\s+(?:vite|next-app)(?:@latest)?|npx(?:\.cmd)?\s+(?:create-vite|create-next-app)(?:@latest)?|pnpm(?:\.cmd)?\s+create\s+(?:vite|next-app)(?:@latest)?|yarn(?:\.cmd)?\s+create\s+(?:vite|next-app)(?:@latest)?|bun\s+create\s+(?:vite|next-app)(?:@latest)?))\s+(?:"[^"]+"|'[^']+'|\S+)\s*([^;]*)/i;
const FRAMEWORK_IN_PLACE_TARGET_PATTERN =
  /\b(?:npm(?:\.cmd)?\s+create\s+(?:vite|next-app)(?:@latest)?|npx(?:\.cmd)?\s+(?:create-vite|create-next-app)(?:@latest)?|pnpm(?:\.cmd)?\s+create\s+(?:vite|next-app)(?:@latest)?|yarn(?:\.cmd)?\s+create\s+(?:vite|next-app)(?:@latest)?|bun\s+create\s+(?:vite|next-app)(?:@latest)?)\s+(?:"\."|'\.'|\.)(?:\s|$)/i;
const FRAMEWORK_TEMP_SCAFFOLD_FINALIZE_PATTERN =
  /agentbigbrain-framework-scaffold/i;

/**
 * Resolves the concrete user-owned root path for a named local framework-app request.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @param executionEnvironment - Planner execution environment context when available.
 * @returns Concrete root path for the named workspace, or `null` when it cannot be proven.
 */
function resolveRequestedFrameworkRootPath(
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): string | null {
  if (!executionEnvironment) {
    return null;
  }
  if (/\bdesktop\b/i.test(currentUserRequest)) {
    return executionEnvironment.desktopPath;
  }
  if (/\bdocuments\b/i.test(currentUserRequest)) {
    return executionEnvironment.documentsPath;
  }
  if (/\bdownloads\b/i.test(currentUserRequest)) {
    return executionEnvironment.downloadsPath;
  }
  return executionEnvironment.desktopPath;
}

/**
 * Resolves the concrete requested framework workspace path when the request names a local folder.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @param executionEnvironment - Planner execution environment context when available.
 * @returns Exact requested workspace path, or `null` when it cannot be proven.
 */
function resolveRequestedFrameworkWorkspacePath(
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): string | null {
  const requestedFolderName = extractRequestedFrameworkFolderName(currentUserRequest);
  const rootPath = resolveRequestedFrameworkRootPath(
    currentUserRequest,
    executionEnvironment
  );
  if (!requestedFolderName || !rootPath) {
    return null;
  }
  return getPathModuleForPathValue(rootPath).join(rootPath, requestedFolderName);
}

/**
 * Rebuilds one unsafe framework scaffold step into a bounded PowerShell temp-slug scaffold that
 * preserves the exact user-facing folder name for the final workspace.
 *
 * @param action - Planned shell-command action emitted by the model.
 * @param currentUserRequest - Active planner-facing request text.
 * @param executionEnvironment - Planner execution environment context when available.
 * @returns Rewritten scaffold action when deterministic rewrite is possible, otherwise the original action.
 */
function normalizeUnsafeFrameworkScaffoldAction(
  action: PlannedAction,
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): PlannedAction {
  if (
    action.type !== "shell_command" ||
    executionEnvironment?.platform !== "win32" ||
    executionEnvironment.shellKind !== "powershell"
  ) {
    return action;
  }
  const requestedFolderName = extractRequestedFrameworkFolderName(currentUserRequest);
  if (!requestedFolderName) {
    return action;
  }
  const rootPath = resolveRequestedFrameworkRootPath(
    currentUserRequest,
    executionEnvironment
  );
  if (!rootPath) {
    return action;
  }

  const command =
    typeof action.params.command === "string" ? action.params.command.trim() : "";
  if (command.length === 0) {
    return action;
  }

  const scaffoldMatch = command.match(FRAMEWORK_CREATE_INVOCATION_PATTERN);
  const lowerCommand = command.toLowerCase();
  const requestedFolderLower = requestedFolderName.toLowerCase();
  const packageSafeFolderName = isFrameworkPackageSafeFolderName(requestedFolderName);
  const usesInPlaceTarget = FRAMEWORK_IN_PLACE_TARGET_PATTERN.test(command);
  const alreadyMovesIntoExactFolder =
    /\bMove-Item\b/i.test(command) &&
    lowerCommand.includes(requestedFolderLower) &&
    /package\.json/i.test(command);
  const needsRewrite =
    !alreadyMovesIntoExactFolder &&
    (!usesInPlaceTarget || !packageSafeFolderName);
  if (
    !scaffoldMatch ||
    !needsRewrite
  ) {
    return action;
  }

  const invocationPrefix = scaffoldMatch[1]?.trim();
  const trailingArgs = scaffoldMatch[2]?.trim() ?? "";
  if (!invocationPrefix) {
    return action;
  }

  const safeSlug = toFrameworkPackageSafeSlug(requestedFolderName);
  const finalPath = `${rootPath}\\${requestedFolderName}`;
  const packageJsonGuard = "Test-Path (Join-Path $final 'package.json')";
  const installClause = /\bnpm(?:\.cmd)?\s+install\b/i.test(command)
    ? "Set-Location $final; npm install"
    : "Set-Location $final";
  const rewrittenCommand = packageSafeFolderName
    ? [
        `$final = '${finalPath.replace(/'/g, "''")}'`,
        `if (${packageJsonGuard}) {`,
        `  ${installClause}`,
        "} else {",
        "  if (!(Test-Path $final)) { New-Item -ItemType Directory -Path $final -Force | Out-Null }",
        "  Set-Location $final",
        `  ${invocationPrefix} '.'${trailingArgs ? ` ${trailingArgs}` : ""}`,
        `  ${installClause}`,
        "}"
      ].join("; ")
    : [
        `$final = '${finalPath.replace(/'/g, "''")}'`,
        `$temp = Join-Path (Join-Path $env:TEMP 'agentbigbrain-framework-scaffold') '${safeSlug}'`,
        "$tempRoot = Split-Path -Parent $temp",
        `if (${packageJsonGuard}) {`,
        `  ${installClause}`,
        "} else {",
        "  if (!(Test-Path $tempRoot)) { New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null }",
        "  if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }",
        "  Set-Location $tempRoot",
        `  ${invocationPrefix} '${safeSlug}'${trailingArgs ? ` ${trailingArgs}` : ""}`,
        "  if (!(Test-Path $final)) { New-Item -ItemType Directory -Path $final -Force | Out-Null }",
        "  Get-ChildItem -Force $temp | ForEach-Object { Move-Item $_.FullName -Destination $final -Force }",
        "  Remove-Item $temp -Recurse -Force",
        `  ${installClause}`,
        "}"
      ].join("; ");

  return {
    ...action,
    description:
      "Scaffold the framework app through a package-safe temp slug, then move it into the exact requested folder.",
    params: {
      ...action.params,
      command: rewrittenCommand,
      cwd: rootPath,
      workdir: rootPath
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: {
        ...action.params,
        command: rewrittenCommand,
        cwd: rootPath,
        workdir: rootPath
      }
    })
  };
}

/**
 * Builds the canonical bounded finalize command for a scaffolded framework workspace that already
 * exists in the temp scaffold root and now needs to land in the exact requested folder.
 *
 * @param requestedFolderName - Human-facing folder name requested by the user.
 * @param rootPath - Concrete requested root path.
 * @returns Deterministic PowerShell finalize command.
 */
function buildSafeFrameworkFinalizeCommand(
  requestedFolderName: string,
  rootPath: string
): string {
  const safeSlug = toFrameworkPackageSafeSlug(requestedFolderName);
  const finalPath = `${rootPath}\\${requestedFolderName}`;
  return [
    `$final = '${finalPath.replace(/'/g, "''")}'`,
    `$tempRoot = Join-Path $env:TEMP 'agentbigbrain-framework-scaffold'`,
    `$temp = Join-Path $tempRoot '${safeSlug.replace(/'/g, "''")}'`,
    "if (Test-Path (Join-Path $final 'package.json')) { Set-Location $final; exit 0 }",
    "if (!(Test-Path $temp)) { throw ('Framework scaffold temp workspace missing: ' + $temp) }",
    "if (!(Test-Path $final)) { New-Item -ItemType Directory -Path $final -Force | Out-Null }",
    "Get-ChildItem -Force $temp | ForEach-Object { Move-Item $_.FullName -Destination $final -Force }",
    "Remove-Item $temp -Recurse -Force",
    "Set-Location $final"
  ].join("; ");
}

/**
 * Rewrites model-emitted temp-scaffold finalize steps into the canonical bounded merge command so
 * finish-the-project follow-ups do not delete the destination tree before moving scaffold files.
 *
 * @param action - Planned shell-command action emitted by the model.
 * @param currentUserRequest - Active planner-facing request text.
 * @param executionEnvironment - Planner execution environment context when available.
 * @returns Rewritten finalize action when deterministic rewrite is possible, otherwise the original action.
 */
function normalizeFrameworkScaffoldFinalizeAction(
  action: PlannedAction,
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): PlannedAction {
  if (
    action.type !== "shell_command" ||
    executionEnvironment?.platform !== "win32" ||
    executionEnvironment.shellKind !== "powershell"
  ) {
    return action;
  }

  const requestedFolderName = extractRequestedFrameworkFolderName(currentUserRequest);
  if (!requestedFolderName) {
    return action;
  }
  const rootPath = resolveRequestedFrameworkRootPath(
    currentUserRequest,
    executionEnvironment
  );
  if (!rootPath) {
    return action;
  }

  const command =
    typeof action.params.command === "string" ? action.params.command.trim() : "";
  if (
    command.length === 0 ||
    !FRAMEWORK_TEMP_SCAFFOLD_FINALIZE_PATTERN.test(command) ||
    FRAMEWORK_CREATE_INVOCATION_PATTERN.test(command) ||
    !/\b(?:move-item|copy-item|get-childitem)\b/i.test(command)
  ) {
    return action;
  }

  const rewrittenCommand = buildSafeFrameworkFinalizeCommand(requestedFolderName, rootPath);
  return {
    ...action,
    description:
      "Finalize the scaffolded framework app into the exact requested folder without deleting the destination tree first.",
    params: {
      ...action.params,
      command: rewrittenCommand,
      cwd: rootPath,
      workdir: rootPath
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: {
        ...action.params,
        command: rewrittenCommand,
        cwd: rootPath,
        workdir: rootPath
      }
    })
  };
}

/**
 * Rewrites unsafe framework scaffold steps into a deterministic temp-slug scaffold on supported
 * Windows PowerShell runtimes so exact human-facing folder names still work.
 *
 * @param actions - Normalized planner actions.
 * @param currentUserRequest - Active planner-facing request text.
 * @param executionEnvironment - Planner execution environment context when available.
 * @returns Actions with unsafe framework scaffold steps normalized when supported.
 */
export function normalizeUnsafeFrameworkScaffoldActions(
  actions: PlannedAction[],
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): PlannedAction[] {
  return actions.map((action) =>
    normalizeFrameworkScaffoldFinalizeAction(
      normalizeUnsafeFrameworkScaffoldAction(
        action,
        currentUserRequest,
        executionEnvironment
      ),
      currentUserRequest,
      executionEnvironment
    )
  );
}

/**
 * Rewrites model-emitted Next.js route writes into the active route root so a workspace cannot end
 * up with split `app/...` and `src/app/...` trees that drift out of sync.
 *
 * @param actions - Normalized planner actions.
 * @param currentUserRequest - Active planner-facing request text.
 * @param executionEnvironment - Planner execution environment context when available.
 * @returns Actions with Next.js route writes normalized to one active route root.
 */
export function normalizeNextJsRouteWriteActions(
  actions: PlannedAction[],
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): PlannedAction[] {
  if (!/\bnext\.?js\b|\bnextjs\b/i.test(currentUserRequest)) {
    return actions;
  }
  const workspacePath = resolveRequestedFrameworkWorkspacePath(
    currentUserRequest,
    executionEnvironment
  );
  if (!workspacePath) {
    return actions;
  }
  const pathModule = getPathModuleForPathValue(workspacePath);
  const rootAppDirectoryPath = pathModule.join(workspacePath, "app");
  const srcAppDirectoryPath = pathModule.join(workspacePath, "src", "app");
  const preferredRouteDirectoryPath = resolvePreferredNextRouteDirectory(
    workspacePath,
    existsSync
  );
  const rewritableBasenames = new Set([
    "page.tsx",
    "page.js",
    "layout.tsx",
    "layout.js",
    "globals.css"
  ]);

  return actions.map((action) => {
    if (action.type !== "write_file" || typeof action.params.path !== "string") {
      return action;
    }
    const actionPath = pathModule.normalize(action.params.path);
    const currentDirectoryPath = pathModule.dirname(actionPath);
    const basename = pathModule.basename(actionPath);
    const targetsKnownNextRouteDirectory =
      currentDirectoryPath === rootAppDirectoryPath || currentDirectoryPath === srcAppDirectoryPath;
    if (!targetsKnownNextRouteDirectory || !rewritableBasenames.has(basename)) {
      return action;
    }
    const normalizedPath = pathModule.join(preferredRouteDirectoryPath, basename);
    if (normalizedPath === actionPath) {
      return action;
    }
    const params = {
      ...action.params,
      path: normalizedPath
    };
    return {
      ...action,
      params,
      estimatedCostUsd: estimateActionCostUsd({
        type: "write_file",
        params
      })
    };
  });
}
