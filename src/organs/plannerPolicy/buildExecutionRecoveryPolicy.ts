/**
 * @fileoverview Shared recovery and destination guardrails for execution-style build policy.
 */

import path from "node:path";

import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import { containsWorkspaceRecoveryStopExactMarker } from "../../core/autonomy/workspaceRecoveryCommandBuilders";
import { PlannedAction } from "../../core/types";

const SHARED_PUBLIC_DESKTOP_PATTERN = /\busers[\\/]+public[\\/]+desktop\b/i;
const BROAD_PROCESS_NAME_SHUTDOWN_PATTERN =
  /\bstop-process\b[\s\S]{0,120}-name\b|\btaskkill\b[\s\S]{0,40}\/im\b|\bpkill\b|\bkillall\b/i;
const GET_PROCESS_PIPELINE_SHUTDOWN_PATTERN =
  /\bget-process\b[\s\S]{0,160}\bstop-process\b/i;
const NO_EXACT_TRACKED_WORKSPACE_HOLDER_PATTERN =
  /no exact tracked workspace holder is currently known for this request/i;
const ORGANIZATION_MOVE_COMMAND_PATTERN = /\b(?:move-item|mv|move)\b/i;
const DESTINATION_FOLDER_CALLED_PATTERN =
  /\bfolder called\s+["']?([A-Za-z0-9][A-Za-z0-9._ -]*?)(?=["']?(?:\s+(?:on|in|under)\b|[.?!,]|$))/i;
const DESTINATION_IMPLICIT_NAME_PATTERN =
  /\b(?:go|belongs?)\b[\s\S]{0,40}\b(?:in|into|under)\s+["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?(?=\s+(?:on|in|under)\b|[.?!,]|$)/i;
const POWERSHELL_NAME_LIKE_PATTERN = /\$_\.Name\s*-like\s*['"]([^'"]+)['"]/gi;
const POWERSHELL_NAME_MATCH_PATTERN =
  /\$_\.Name\s*-(?:c|i)?match\s*['"]([^'"]+)['"]/gi;
const POWERSHELL_NAME_STARTS_WITH_PATTERN =
  /\$_\.Name(?:\.ToLower\(\))?\.StartsWith\(\s*['"]([^'"]+)['"]/gi;
const POWERSHELL_STRING_ASSIGNMENT_PATTERN =
  /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g;

/**
 * Escapes literal text for safe insertion into a regular expression.
 *
 * @param value - Unescaped literal value.
 * @returns Escaped regex-safe string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalizes a destination folder name into one stable basename form.
 *
 * @param value - Raw destination text.
 * @returns Normalized folder basename, or `null` when absent.
 */
function normalizeDestinationFolderName(value: string): string | null {
  const normalized = value.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }
  return path.win32.basename(normalized).trim() || null;
}

/**
 * Extracts the destination folder name the user explicitly or implicitly requested.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns Destination folder basename, or `null` when none can be derived safely.
 */
function extractRequestedDestinationFolderName(
  currentUserRequest: string
): string | null {
  const activeRequest = extractActiveRequestSegment(currentUserRequest).trim();
  if (!activeRequest) {
    return null;
  }
  const explicitMatch = activeRequest.match(DESTINATION_FOLDER_CALLED_PATTERN);
  if (explicitMatch?.[1]) {
    return normalizeDestinationFolderName(explicitMatch[1]);
  }
  const implicitMatch = activeRequest.match(DESTINATION_IMPLICIT_NAME_PATTERN);
  if (implicitMatch?.[1]) {
    return normalizeDestinationFolderName(implicitMatch[1]);
  }
  return null;
}

/**
 * Evaluates one PowerShell wildcard selector against a concrete destination folder name.
 *
 * @param candidate - Concrete folder name to test.
 * @param wildcard - PowerShell wildcard pattern.
 * @returns `true` when the folder name matches the wildcard.
 */
function matchesPowerShellWildcard(candidate: string, wildcard: string): boolean {
  const escaped = escapeRegExp(wildcard)
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(candidate);
}

/**
 * Detects whether a move command selector would also select the destination folder by name.
 *
 * @param command - Planner-authored shell command.
 * @param destinationFolderName - Requested destination folder basename.
 * @returns `true` when the command would also match the destination folder itself.
 */
function commandSelectsDestinationByName(
  command: string,
  destinationFolderName: string
): boolean {
  for (const match of command.matchAll(POWERSHELL_NAME_LIKE_PATTERN)) {
    if (match[1] && matchesPowerShellWildcard(destinationFolderName, match[1])) {
      return true;
    }
  }
  for (const match of command.matchAll(POWERSHELL_NAME_MATCH_PATTERN)) {
    if (!match[1]) {
      continue;
    }
    try {
      if (new RegExp(match[1], "i").test(destinationFolderName)) {
        return true;
      }
    } catch {
      // Ignore invalid planner regex here; other policy layers will surface malformed commands.
    }
  }
  for (const match of command.matchAll(POWERSHELL_NAME_STARTS_WITH_PATTERN)) {
    if (match[1] && destinationFolderName.toLowerCase().startsWith(match[1].toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Detects whether a move command explicitly excludes the destination folder from its selector.
 *
 * @param command - Planner-authored shell command.
 * @param destinationFolderName - Requested destination folder basename.
 * @returns `true` when the command already excludes the destination folder.
 */
function commandExplicitlyExcludesDestination(
  command: string,
  destinationFolderName: string
): boolean {
  const escapedDestinationName = escapeRegExp(destinationFolderName);
  const literalExclusionPatterns = [
    new RegExp(
      `\\$_\\.(?:Name|FullName)\\s*-(?:ne|notlike|notmatch)\\s*['"][^'"]*${escapedDestinationName}[^'"]*['"]`,
      "i"
    ),
    new RegExp(
      `\\$_\\.Name\\s*-notin\\s*@\\([^\\)]*['"]${escapedDestinationName}['"]`,
      "i"
    ),
    new RegExp(`\\b-Exclude\\s+['"]${escapedDestinationName}['"]`, "i")
  ];
  if (literalExclusionPatterns.some((pattern) => pattern.test(command))) {
    return true;
  }

  for (const assignmentMatch of command.matchAll(POWERSHELL_STRING_ASSIGNMENT_PATTERN)) {
    const variableName = assignmentMatch[1]?.trim();
    const assignedValue = assignmentMatch[2]?.trim();
    if (!variableName || !assignedValue) {
      continue;
    }
    const assignedDestinationName = normalizeDestinationFolderName(assignedValue);
    if (
      !assignedDestinationName ||
      assignedDestinationName.localeCompare(destinationFolderName, undefined, {
        sensitivity: "accent"
      }) !== 0
    ) {
      continue;
    }
    const escapedVariableName = escapeRegExp(variableName);
    const variableExclusionPatterns = [
      new RegExp(
        `\\$_\\.(?:Name|FullName)\\s*-(?:ne|notlike|notmatch)\\s*\\$${escapedVariableName}\\b`,
        "i"
      ),
      new RegExp(`\\b-Exclude\\s+\\$${escapedVariableName}\\b`, "i")
    ];
    if (variableExclusionPatterns.some((pattern) => pattern.test(command))) {
      return true;
    }
  }

  return false;
}

/**
 * Reads planner-supplied filesystem-like paths that should honor user-owned destination wording.
 *
 * @param action - Planned action under inspection.
 * @returns Candidate path strings extracted from supported params.
 */
function collectActionPathCandidates(action: PlannedAction): string[] {
  const candidates: string[] = [];
  const maybePush = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      candidates.push(trimmed);
    }
  };

  maybePush(action.params.path);
  maybePush(action.params.cwd);
  maybePush(action.params.workdir);
  return candidates;
}

/**
 * Evaluates whether the plan routes a "my desktop" request into the shared Public Desktop.
 *
 * @param currentUserRequest - Active user wording.
 * @param actions - Planned actions produced by the model.
 * @returns `true` when the plan chose a shared Desktop path instead of the user's Desktop.
 */
export function usesSharedDesktopForUserOwnedRequest(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (!/\bon\s+my\s+desktop\b/i.test(currentUserRequest)) {
    return false;
  }
  return actions.some((action) =>
    collectActionPathCandidates(action).some((candidate) =>
      SHARED_PUBLIC_DESKTOP_PATTERN.test(candidate)
    )
  );
}

/**
 * Evaluates whether a plan tries to recover local workspace friction by stopping broad apps by
 * process name instead of using exact runtime-owned controls.
 *
 * @param actions - Planned actions produced by the model.
 * @returns `true` when any shell step attempts broad process-name shutdown.
 */
export function hasBroadProcessNameShutdownAction(
  actions: readonly PlannedAction[]
): boolean {
  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    if (!command) {
      return false;
    }
    return (
      BROAD_PROCESS_NAME_SHUTDOWN_PATTERN.test(command) ||
      GET_PROCESS_PIPELINE_SHUTDOWN_PATTERN.test(command)
    );
  });
}

/**
 * Evaluates whether candidate-only workspace recovery context is trying to jump straight to stop_process.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @param actions - Planned actions produced by the model.
 * @returns `true` when candidate-only holder hints are being treated as direct shutdown proof.
 */
export function hasCandidateOnlyHolderShutdownAction(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (containsWorkspaceRecoveryStopExactMarker(currentUserRequest)) {
    return false;
  }
  if (!NO_EXACT_TRACKED_WORKSPACE_HOLDER_PATTERN.test(currentUserRequest)) {
    return false;
  }
  return actions.some((action) => action.type === "stop_process");
}

/**
 * Evaluates whether a local organization move command would also select the named destination
 * folder itself without explicitly excluding it, which risks self-nesting like `sample-folder`
 * moving into `sample-folder`.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @param actions - Planned actions produced by the model.
 * @returns `true` when a move selector would also capture the destination folder itself.
 */
export function hasOrganizationDestinationSelfMatchAction(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  const destinationFolderName = extractRequestedDestinationFolderName(currentUserRequest);
  if (!destinationFolderName) {
    return false;
  }
  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    if (!command || !ORGANIZATION_MOVE_COMMAND_PATTERN.test(command)) {
      return false;
    }
    return (
      commandSelectsDestinationByName(command, destinationFolderName) &&
      !commandExplicitlyExcludesDestination(command, destinationFolderName)
    );
  });
}
