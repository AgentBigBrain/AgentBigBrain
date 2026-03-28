/**
 * @fileoverview Deterministic fallback actions for explicit governed runtime action requests.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { RequiredActionType } from "./executionStyleContracts";
import { buildDeterministicFrameworkBuildFallbackActions } from "./frameworkRuntimeActionFallback";

export { buildDeterministicFrameworkBuildFallbackActions } from "./frameworkRuntimeActionFallback";

const WINDOWS_PATH_START_PATTERN = /[A-Za-z]:\\/g;
const BLOCKED_PATHS_SECTION_PATTERNS = [
  /\b(?:remaining\s+)?blocked paths?:\s*([\s\S]+?)(?=(?:\.\s+(?:If|Do not|Then|Report|Explain|Retry|Stop)\b)|$)/i,
  /\bon\s+(?:the\s+)?(?:remaining\s+)?blocked paths?:\s*([\s\S]+?)(?=(?:\.\s+(?:If|Do not|Then|Report|Explain|Retry|Stop)\b)|$)/i
] as const;
const PATH_CLAUSE_DELIMITER_PATTERNS = [
  /\.\s+(?:If|Do not|Then|Report|Explain|Retry|Stop|Move)\b/i,
  /,\s*(?:If|Do not|Then|Report|Explain|Retry|Stop|Move)\b/i,
  /\s+now\b/i,
  /\s+then\b/i
] as const;
const TRACKED_BROWSER_SESSION_ID_PATTERN = /\bsessionId=([A-Za-z0-9:_-]+)/i;
const TRACKED_BROWSER_URL_PATTERN = /\burl=([^\s;]+)/i;
const PREVIEW_PROCESS_LEASES_LINE_PATTERN = /^-\s*Preview process leases:\s*(.+)$/im;
const LINKED_PREVIEW_LEASE_INLINE_PATTERN = /\blinkedPreviewLease=([A-Za-z0-9:_-]+)/i;
const LINKED_PREVIEW_PROCESS_LINE_PATTERN =
  /\bLinked preview process:\s*leaseId=([A-Za-z0-9:_-]+)/i;

/**
 * Normalizes one Windows path candidate into a trimmed stable form.
 *
 * @param pathValue - Raw path text.
 * @returns Normalized Windows path, or `null` when empty.
 */
function normalizeWindowsPath(pathValue: string): string | null {
  const normalized = pathValue.trim().replace(/[.,;:]+$/, "");
  return normalized.length > 0 ? normalized : null;
}

/**
 * Trims a candidate string at the earliest recovery-clause delimiter.
 *
 * @param value - Raw candidate text.
 * @param patterns - Delimiter patterns that bound the path clause.
 * @returns Candidate text before the first delimiter.
 */
function trimAtFirstDelimiter(
  value: string,
  patterns: readonly RegExp[]
): string {
  let endIndex = value.length;
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match && typeof match.index === "number") {
      endIndex = Math.min(endIndex, match.index);
    }
  }
  return value.slice(0, endIndex);
}

/**
 * Cleans one Windows path candidate pulled from free-form recovery text.
 *
 * @param candidate - Raw candidate substring.
 * @returns Normalized Windows path, or `null` when the candidate is not usable.
 */
function normalizeWindowsPathCandidate(candidate: string): string | null {
  let normalized = candidate.trim();
  const quoteIndex = normalized.search(/[`'"]/);
  if (quoteIndex >= 0) {
    normalized = normalized.slice(0, quoteIndex);
  }
  normalized = normalized.replace(/\s+(?:and|or)\s+\d+\)\s*$/i, "");
  normalized = normalized.replace(/\s+(?:and|or)\s*$/i, "");
  normalized = trimAtFirstDelimiter(normalized, PATH_CLAUSE_DELIMITER_PATTERNS);
  return normalizeWindowsPath(normalized);
}

/**
 * Extracts bounded Windows paths from one free-form text region.
 *
 * @param currentUserRequest - Text containing inline Windows path candidates.
 * @returns Unique normalized Windows paths in first-seen order.
 */
function extractWindowPathsFromText(currentUserRequest: string): readonly string[] {
  const startIndexes: number[] = [];
  for (const match of currentUserRequest.matchAll(WINDOWS_PATH_START_PATTERN)) {
    if (typeof match.index === "number") {
      startIndexes.push(match.index);
    }
  }
  if (startIndexes.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (let index = 0; index < startIndexes.length; index += 1) {
    const start = startIndexes[index];
    const end = startIndexes[index + 1] ?? currentUserRequest.length;
    const normalized = normalizeWindowsPathCandidate(currentUserRequest.slice(start, end));
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

/**
 * Extracts blocked Windows paths from the current explicit runtime-action request.
 *
 * @param currentUserRequest - Active explicit runtime-action request.
 * @returns Unique Windows paths recovered from the request text.
 */
function extractWindowsPaths(currentUserRequest: string): readonly string[] {
  for (const pattern of BLOCKED_PATHS_SECTION_PATTERNS) {
    const match = currentUserRequest.match(pattern);
    const section = typeof match?.[1] === "string" ? match[1].trim() : "";
    if (section.length === 0) {
      continue;
    }
    const paths = extractWindowPathsFromText(section);
    if (paths.length > 0) {
      return paths;
    }
  }
  return extractWindowPathsFromText(currentUserRequest);
}

/**
 * Builds a deterministic `inspect_path_holders` action for one extracted Windows path.
 *
 * @param targetPath - Exact path that still needs runtime holder inspection.
 * @returns Planned action with bounded inspection metadata.
 */
function buildInspectPathHoldersAction(targetPath: string): PlannedAction {
  return {
    id: makeId("action"),
    type: "inspect_path_holders",
    description: `Inspect runtime-owned holders for ${targetPath}.`,
    params: {
      path: targetPath
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "inspect_path_holders",
      params: {
        path: targetPath
      }
    })
  };
}

/**
 * Builds a deterministic `inspect_workspace_resources` action for one extracted workspace root.
 *
 * @param rootPath - Exact workspace root path to inspect.
 * @returns Planned action with bounded workspace inspection metadata.
 */
function buildInspectWorkspaceResourcesAction(rootPath: string): PlannedAction {
  return {
    id: makeId("action"),
    type: "inspect_workspace_resources",
    description: `Inspect runtime-owned workspace resources for ${rootPath}.`,
    params: {
      rootPath
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "inspect_workspace_resources",
      params: {
        rootPath
      }
    })
  };
}

/**
 * Extracts exact tracked preview-process lease ids from the conversation-aware execution input.
 *
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Exact preview-process lease ids, or an empty list when the current request context has none.
 */
function extractTrackedPreviewLeaseIds(fullExecutionInput: string): string[] {
  const previewLeaseListMatch = fullExecutionInput.match(PREVIEW_PROCESS_LEASES_LINE_PATTERN);
  const leaseIds = [
    ...(previewLeaseListMatch?.[1]
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => /^[A-Za-z0-9:_-]+$/.test(value)) ?? []),
    fullExecutionInput.match(LINKED_PREVIEW_LEASE_INLINE_PATTERN)?.[1] ?? null,
    fullExecutionInput.match(LINKED_PREVIEW_PROCESS_LINE_PATTERN)?.[1] ?? null
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(leaseIds)];
}

/**
 * Extracts the best tracked browser session id and URL for one close-browser follow-up fallback.
 *
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Exact tracked browser session id and URL when present.
 */
function extractTrackedBrowserCloseTarget(
  fullExecutionInput: string
): { sessionId: string | null; url: string | null } {
  return {
    sessionId: fullExecutionInput.match(TRACKED_BROWSER_SESSION_ID_PATTERN)?.[1]?.trim() ?? null,
    url: fullExecutionInput.match(TRACKED_BROWSER_URL_PATTERN)?.[1]?.trim() ?? null
  };
}

/**
 * Builds a deterministic close-browser fallback for tracked browser-session follow-ups.
 *
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Bounded close-browser and linked preview-stop actions, or an empty list when the tracked target is missing.
 */
function buildTrackedCloseBrowserFallbackActions(
  fullExecutionInput: string
): PlannedAction[] {
  const { sessionId, url } = extractTrackedBrowserCloseTarget(fullExecutionInput);
  if (!sessionId && !url) {
    return [];
  }
  const closeBrowserParams = sessionId ? { sessionId } : { url: url! };
  const actions: PlannedAction[] = [
    {
      id: makeId("action"),
      type: "close_browser",
      description: "Close the tracked browser window for the current local page.",
      params: closeBrowserParams,
      estimatedCostUsd: estimateActionCostUsd({
        type: "close_browser",
        params: closeBrowserParams
      })
    }
  ];
  for (const leaseId of extractTrackedPreviewLeaseIds(fullExecutionInput)) {
    actions.push({
      id: makeId("action"),
      type: "stop_process",
      description: "Stop the tracked local preview process linked to that browser page.",
      params: {
        leaseId
      },
      estimatedCostUsd: estimateActionCostUsd({
        type: "stop_process",
        params: {
          leaseId
        }
      })
    });
  }
  return actions;
}

/**
 * Builds bounded fallback actions when the user explicitly requested a governed runtime action by
 * name and the planner still failed to emit that action after repair.
 *
 * @param currentUserRequest - Active explicit runtime-action request.
 * @param requiredActionType - Deterministic required action type inferred from the request.
 * @returns Deterministic fallback actions, or an empty list when the request must still fail closed.
 */
export function buildDeterministicExplicitRuntimeActionFallbackActions(
  currentUserRequest: string,
  requiredActionType: RequiredActionType,
  fullExecutionInput = currentUserRequest
): PlannedAction[] {
  const extractedPaths = extractWindowsPaths(currentUserRequest);
  if (requiredActionType === "inspect_path_holders") {
    return extractedPaths.map(buildInspectPathHoldersAction);
  }
  if (requiredActionType === "inspect_workspace_resources") {
    return extractedPaths.length > 0
      ? [buildInspectWorkspaceResourcesAction(extractedPaths[0])]
      : [];
  }
  if (requiredActionType === "close_browser") {
    return buildTrackedCloseBrowserFallbackActions(fullExecutionInput);
  }
  return [];
}
