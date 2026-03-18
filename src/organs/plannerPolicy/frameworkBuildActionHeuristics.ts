/**
 * @fileoverview Framework-app specific action-shape heuristics for execution-style build-policy validation.
 */

import { PlannedAction } from "../../core/types";
import { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import {
  isExecutionStyleBuildRequest,
  isLiveVerificationBuildRequest,
  requiresBrowserVerificationBuildRequest,
  requiresFrameworkAppScaffoldAction
} from "./liveVerificationPolicy";

const FRAMEWORK_APP_TOOLCHAIN_PATTERN =
  /\b(?:npm|npx|pnpm|yarn|bun|vite|next)\b/i;
const FRAMEWORK_APP_LIFECYCLE_COMMAND_PATTERN =
  /\b(?:create|install|build|dev|start|serve|preview)\b/i;
const FRAMEWORK_APP_CREATE_COMMAND_PATTERN =
  /\b(?:create-vite(?:@latest)?|create\s+vite@latest|npm\s+create|npx\s+create-vite|pnpm\s+create|yarn\s+create|bun\s+create)\b/i;
const FRAMEWORK_APP_DIRECTORY_GUARD_PATTERN =
  /\btest-path\b[\s\S]{0,80}\$(?:project|root|folder)\b|\btest-path\b[\s\S]{0,160}(?:AI Drone City|Desktop)|\[\s*-d\s+.+?\]/i;
const FRAMEWORK_APP_IN_PLACE_SCAFFOLD_PATTERN =
  /(?:create-vite(?:@latest)?|create\s+vite(?:@latest)?|npm(?:\.cmd)?\s+create|npx(?:\.cmd)?\s+create-vite|pnpm(?:\.cmd)?\s+create|yarn(?:\.cmd)?\s+create|bun\s+create)\s+(?:"\."|'\.'|\.)(?:\s|$)/i;
const FRAMEWORK_APP_NATIVE_PREVIEW_COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|bun)\b[\s\S]{0,80}\b(?:run\s+)?(?:preview|dev|start)\b|\bvite\b[\s\S]{0,40}\b(?:preview|dev)\b/i;
const FRAMEWORK_APP_AD_HOC_PREVIEW_SERVER_PATTERN =
  /\b(?:npx|npm|pnpm|yarn)\b[\s\S]{0,40}\bserve\b|\bserve\b[\s\S]{0,40}\b-s\s+dist\b/i;

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
 * Evaluates whether a fresh framework-app request includes at least one real toolchain action
 * capable of scaffolding, installing, building, previewing, or running that app.
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
          FRAMEWORK_APP_TOOLCHAIN_PATTERN.test(command) &&
          FRAMEWORK_APP_LIFECYCLE_COMMAND_PATTERN.test(command)
        );
      }
      case "start_process": {
        const command =
          typeof action.params.command === "string" ? action.params.command.trim() : "";
        return (
          command.length > 0 &&
          FRAMEWORK_APP_TOOLCHAIN_PATTERN.test(command)
        );
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
    return !FRAMEWORK_APP_IN_PLACE_SCAFFOLD_PATTERN.test(command);
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
  if (!requiresFrameworkAppScaffoldAction(currentUserRequest)) {
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
