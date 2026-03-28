/**
 * @fileoverview Framework-app specific action-shape heuristics for execution-style build-policy validation.
 */

import path from "node:path";

import { PlannedAction } from "../../core/types";
import { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import {
  isExecutionStyleBuildRequest,
  isLiveVerificationBuildRequest,
  requiresBrowserVerificationBuildRequest,
  requiresFrameworkAppScaffoldAction
} from "./liveVerificationPolicy";

const FRAMEWORK_APP_CREATE_COMMAND_PATTERN =
  /\b(?:create-vite(?:@latest)?|create\s+vite@latest|create-next-app(?:@latest)?|create\s+next-app(?:@latest)?|npm\s+create|npx\s+create-vite|npx\s+create-next-app|pnpm\s+create|yarn\s+create|bun\s+create)\b/i;
const FRAMEWORK_APP_BOOTSTRAP_PACKAGE_JSON_PATTERN =
  /(?:package\.json[\s\S]{0,160}\b(?:set-content|out-file|add-content|copy-item|move-item|rename-item|new-item)\b|\b(?:set-content|out-file|add-content|copy-item|move-item|rename-item|new-item)\b[\s\S]{0,160}package\.json)/i;
const FRAMEWORK_APP_TEMP_SCAFFOLD_MERGE_PATTERN =
  /agentbigbrain-framework-scaffold[\s\S]{0,240}\b(?:move-item|copy-item|rename-item|get-childitem)\b/i;
const FRAMEWORK_APP_DIRECTORY_GUARD_PATTERN =
  /\btest-path\b[\s\S]{0,80}\$(?:project|root|folder)\b|\btest-path\b[\s\S]{0,160}(?:AI Drone City|Desktop)|\[\s*-d\s+.+?\]/i;
const FRAMEWORK_APP_IN_PLACE_SCAFFOLD_PATTERN =
  /(?:create-vite(?:@latest)?|create\s+vite(?:@latest)?|create-next-app(?:@latest)?|create\s+next-app(?:@latest)?|npm(?:\.cmd)?\s+create|npx(?:\.cmd)?\s+create-vite|npx(?:\.cmd)?\s+create-next-app|pnpm(?:\.cmd)?\s+create|yarn(?:\.cmd)?\s+create|bun\s+create)\s+(?:"\."|'\.'|\.)(?:\s|$)/i;
const FRAMEWORK_APP_NATIVE_PREVIEW_COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|bun)\b[\s\S]{0,80}\b(?:run\s+)?(?:preview|dev|start)\b|\bvite\b[\s\S]{0,40}\b(?:preview|dev)\b/i;
const FRAMEWORK_APP_AD_HOC_PREVIEW_SERVER_PATTERN =
  /\b(?:npx|npm|pnpm|yarn)\b[\s\S]{0,40}\bserve\b|\bserve\b[\s\S]{0,40}\b-s\s+dist\b/i;
const REQUESTED_FOLDER_NAME_PATTERNS = [
  /\bcall\s+it\s+["']?([^"'\r\n]+?)["']?(?=\s+(?:on|in|inside|under|at|and|then|with)\b|[?.!,]|$)/i,
  /\bname\s+it\s+["']?([^"'\r\n]+?)["']?(?=\s+(?:on|in|inside|under|at|and|then|with)\b|[?.!,]|$)/i,
  /\bfolder\s+called\s+["']?([^"'\r\n]+?)["']?(?=\s+(?:on|in|inside|under|at|and|then|with)\b|[.,]|$)/i,
  /\bcalled\s+["']?([^"'\r\n]+?)["']?(?=\s+(?:on|in|inside|under|at|and|then|with)\b|[.,]|$)/i,
  /\bnamed\s+["']?([^"'\r\n]+?)["']?(?=\s+(?:on|in|inside|under|at|and|then|with)\b|[.,]|$)/i,
  /\bturn\s+that\s+["']?([^"'\r\n]+?)["']?\s+(?:workspace|project|app)\b/i,
  /\b(?:that|the)\s+["']?([^"'\r\n]+?)["']?\s+(?:workspace|project|app)\b/i
] as const;
const REQUESTED_FOLDER_PATH_PATTERNS = [
  /`([A-Za-z]:\\[^`\r\n]+)`/g,
  /"([A-Za-z]:\\[^"\r\n]+)"/g,
  /'([A-Za-z]:\\[^'\r\n]+)'/g
] as const;
const SAFE_NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const INVALID_REQUESTED_FOLDER_NAME_PATTERNS = [
  /\bfolder itself\b/i,
  /\bnested subfolder\b/i,
  /\bpackage\.json\b/i,
  /\bindex\.html\b/i,
  /\bscaffold scripts?\b/i,
  /\bvalid react single-page\b/i
] as const;

/**
 * Normalizes and validates one extracted human-facing framework folder label.
 */
function sanitizeRequestedFrameworkFolderName(candidate: string): string | null {
  const trimmed = candidate.replace(/["'`]+$/g, "").trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (INVALID_REQUESTED_FOLDER_NAME_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return null;
  }
  return trimmed;
}

/**
 * Extracts the final folder name from an explicit Windows path literal when a repair turn names
 * the exact workspace path directly.
 */
function extractRequestedFrameworkFolderNameFromPath(
  currentUserRequest: string
): string | null {
  for (const pattern of REQUESTED_FOLDER_PATH_PATTERNS) {
    for (const match of currentUserRequest.matchAll(pattern)) {
      const literalPath = match[1]?.trim();
      if (!literalPath) {
        continue;
      }
      const folderName = path.win32.basename(literalPath.replace(/[\\\/]+$/, ""));
      const sanitizedFolderName = sanitizeRequestedFrameworkFolderName(folderName);
      if (sanitizedFolderName) {
        return sanitizedFolderName;
      }
    }
  }
  return null;
}

/**
 * Extracts an explicitly named framework-app folder from the active request when present.
 */
export function extractRequestedFrameworkFolderName(
  currentUserRequest: string
): string | null {
  const explicitPathFolderName = extractRequestedFrameworkFolderNameFromPath(currentUserRequest);
  if (explicitPathFolderName) {
    return explicitPathFolderName;
  }
  for (const pattern of REQUESTED_FOLDER_NAME_PATTERNS) {
    const candidate = currentUserRequest.match(pattern)?.[1]?.trim();
    if (candidate) {
      const sanitizedCandidate = sanitizeRequestedFrameworkFolderName(candidate);
      if (sanitizedCandidate) {
        return sanitizedCandidate;
      }
    }
  }
  return null;
}

/**
 * Normalizes a human-facing folder name into a lowercase package-safe slug.
 */
export function toFrameworkPackageSafeSlug(folderName: string): string {
  const normalized = folderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "app";
}

/**
 * Evaluates whether a requested folder name is already safe as an npm package name.
 */
export function isFrameworkPackageSafeFolderName(folderName: string): boolean {
  return SAFE_NPM_PACKAGE_NAME_PATTERN.test(folderName.trim());
}

/**
 * Evaluates whether any `open_browser` action targets a non-http URL.
 */
export function hasUnsupportedOpenBrowserTarget(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  const liveVerificationRequired =
    isLiveVerificationBuildRequest(currentUserRequest) ||
    requiresBrowserVerificationBuildRequest(currentUserRequest);
  return actions.some((action) => {
    if (action.type !== "open_browser") {
      return false;
    }
    const targetUrl = typeof action.params.url === "string" ? action.params.url.trim() : "";
    if (targetUrl.length === 0) {
      return false;
    }
    if (/^https?:\/\//i.test(targetUrl)) {
      return false;
    }
    if (/^file:\/\//i.test(targetUrl)) {
      return liveVerificationRequired;
    }
    return true;
  });
}

/**
 * Evaluates whether a fresh framework-app request includes at least one real scaffold/bootstrap
 * action that can materialize the workspace, rather than only lifecycle commands against an empty
 * folder.
 */
export function hasFrameworkAppScaffoldAction(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (!requiresFrameworkAppScaffoldAction(currentUserRequest)) {
    return false;
  }

  return actions.some((action) => {
    switch (action.type) {
      case "shell_command": {
        const command =
          typeof action.params.command === "string" ? action.params.command.trim() : "";
        return (
          command.length > 0 &&
          (
            FRAMEWORK_APP_CREATE_COMMAND_PATTERN.test(command) ||
            FRAMEWORK_APP_TEMP_SCAFFOLD_MERGE_PATTERN.test(command) ||
            FRAMEWORK_APP_BOOTSTRAP_PACKAGE_JSON_PATTERN.test(command)
          )
        );
      }
      case "write_file": {
        const targetPath =
          typeof action.params.path === "string" ? action.params.path.trim().toLowerCase() : "";
        return targetPath.endsWith("package.json");
      }
      default:
        return false;
    }
  });
}

/**
 * Evaluates whether a framework-app scaffold command incorrectly treats directory existence alone
 * as proof the app is already present, instead of checking for real scaffold artifacts like
 * package.json.
 */
export function hasFrameworkAppDirectoryOnlyReuseGuard(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (!requiresFrameworkAppScaffoldAction(currentUserRequest)) {
    return false;
  }

  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    if (
      command.length === 0 ||
      !FRAMEWORK_APP_CREATE_COMMAND_PATTERN.test(command) ||
      !FRAMEWORK_APP_DIRECTORY_GUARD_PATTERN.test(command)
    ) {
      return false;
    }
    return !/package\.json/i.test(command);
  });
}

/**
 * Evaluates whether a framework-app scaffold plan checks for package.json but still tries to
 * scaffold by recreating the named folder from its parent instead of repairing/scaffolding inside
 * the exact requested workspace.
 */
export function hasFrameworkAppNonInPlaceScaffoldRepair(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (!requiresFrameworkAppScaffoldAction(currentUserRequest)) {
    return false;
  }

  const requestedFolderName = extractRequestedFrameworkFolderName(currentUserRequest);
  const safeSlug = requestedFolderName
    ? toFrameworkPackageSafeSlug(requestedFolderName)
    : null;
  const requestedFolderLower = requestedFolderName?.toLowerCase() ?? null;

  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    if (
      command.length === 0 ||
      !FRAMEWORK_APP_CREATE_COMMAND_PATTERN.test(command) ||
      !/package\.json/i.test(command)
    ) {
      return false;
    }
    if (FRAMEWORK_APP_IN_PLACE_SCAFFOLD_PATTERN.test(command)) {
      return false;
    }

    const lowerCommand = command.toLowerCase();
    const hasBoundedExactFolderMerge =
      safeSlug !== null &&
      requestedFolderLower !== null &&
      lowerCommand.includes(safeSlug) &&
      lowerCommand.includes(requestedFolderLower) &&
      /\b(?:move-item|copy-item|rename-item|mv|cp)\b/i.test(command);
    return !hasBoundedExactFolderMerge;
  });
}

/**
 * Evaluates whether a create-style framework scaffold is still trying to use an unsafe exact
 * human-facing folder name as the package/scaffold target.
 */
export function hasFrameworkAppUnsafePackageNameScaffold(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (!requiresFrameworkAppScaffoldAction(currentUserRequest)) {
    return false;
  }

  const requestedFolderName = extractRequestedFrameworkFolderName(currentUserRequest);
  if (!requestedFolderName || isFrameworkPackageSafeFolderName(requestedFolderName)) {
    return false;
  }
  const safeSlug = toFrameworkPackageSafeSlug(requestedFolderName);

  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    if (
      command.length === 0 ||
      !FRAMEWORK_APP_CREATE_COMMAND_PATTERN.test(command)
    ) {
      return false;
    }

    const normalizedCommand = command.toLowerCase();
    return (
      (normalizedCommand.includes(requestedFolderName.toLowerCase()) ||
        FRAMEWORK_APP_IN_PLACE_SCAFFOLD_PATTERN.test(command)) &&
      !normalizedCommand.includes(safeSlug)
    );
  });
}

/**
 * Evaluates whether a framework-app live-run plan uses an ad-hoc preview server instead of the
 * workspace-native preview/runtime command provided by the app toolchain.
 */
export function hasFrameworkAppAdHocPreviewServer(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (
    !isExecutionStyleBuildRequest(currentUserRequest) ||
    !/\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i.test(currentUserRequest)
  ) {
    return false;
  }

  if (!actions.some((action) => action.type === "start_process")) {
    return false;
  }

  return actions.some((action) => {
    if (action.type !== "start_process") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    if (command.length === 0) {
      return false;
    }
    return (
      FRAMEWORK_APP_AD_HOC_PREVIEW_SERVER_PATTERN.test(command) &&
      !FRAMEWORK_APP_NATIVE_PREVIEW_COMMAND_PATTERN.test(command)
    );
  });
}

/**
 * Evaluates whether any shell-like planner action exceeds the configured shell command budget for
 * the current execution environment.
 */
export function hasShellCommandExceedingMaxChars(
  actions: readonly PlannedAction[],
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): boolean {
  const maxChars = executionEnvironment?.commandMaxChars ?? 0;
  if (maxChars <= 0) {
    return false;
  }

  return actions.some((action) => {
    if (action.type !== "shell_command" && action.type !== "start_process") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    return command.length > maxChars;
  });
}

/**
 * Evaluates whether the request remains execution-shaped local framework build work.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when framework-build heuristics should apply.
 */
export function isFrameworkBuildHeuristicRequest(currentUserRequest: string): boolean {
  return (
    requiresFrameworkAppScaffoldAction(currentUserRequest) ||
    isExecutionStyleBuildRequest(currentUserRequest)
  );
}
