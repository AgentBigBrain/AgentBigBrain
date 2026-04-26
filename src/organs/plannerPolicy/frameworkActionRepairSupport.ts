/**
 * @fileoverview Framework-app-specific action normalization kept separate from generic planner
 * action repair support.
 */

import { existsSync } from "node:fs";
import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import type { PlannedAction } from "../../core/types";
import type { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import { extractRequestedFrameworkFolderName } from "./frameworkBuildActionHeuristics";
import {
  getPathModuleForPathValue,
  resolvePreferredNextRouteDirectory
} from "./frameworkPathSupport";

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
