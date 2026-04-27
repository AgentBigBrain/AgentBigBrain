/**
 * @fileoverview Deterministic bounded fallback actions for Desktop folder runtime-process sweeps.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import { isRuntimeProcessManagementRequest } from "./liveVerificationPolicy";
import {
  hasPlannerResolvedRouteMetadata,
  hasResolvedRuntimeControlIntent
} from "./liveVerificationSemanticRouteSupport";

const DESKTOP_LOCATION_PATTERN = /\b(?:my|the)\s+desktop\b/i;
const DOCUMENTS_LOCATION_PATTERN = /\b(?:my|the)\s+documents\b/i;
const DOWNLOADS_LOCATION_PATTERN = /\b(?:my|the)\s+downloads\b/i;
const FOLDER_TARGET_PATTERN = /\b(?:folder|folders|directory|directories|project|projects|workspace|workspaces)\b/i;
const STOP_SERVER_PATTERN = /\b(?:stop|shut\s+down|turn\s+off|kill)\b[\s\S]{0,80}\b(?:server|servers|preview|dev\s+server|localhost|process(?:es)?)\b/i;
const STARTS_WITH_SELECTOR_PATTERN = /\bstarts?\s+with\s+["'`]?([A-Za-z0-9][A-Za-z0-9._-]{1,80})["'`]?(?=\s*(?:,|and\b|or\b|$))/i;
const CONTAINS_SELECTOR_PATTERN = /\bcontains?\s+(?:the\s+word\s+)?["'`]?([A-Za-z0-9][A-Za-z0-9._-]{1,80})["'`]?(?=\s*(?:,|and\b|or\b|$))/i;

interface RuntimeSweepSelector { mode: "starts_with" | "contains"; term: string; }

/**
 * Normalizes the root path named by the current runtime-sweep request.
 *
 * **Why it exists:**
 * The fallback is intentionally limited to explicit user-owned roots like Desktop, Documents, or
 * Downloads so broad runtime sweeps cannot silently expand outside the named location.
 *
 * **What it talks to:**
 * - Uses `PlannerExecutionEnvironmentContext` (import `PlannerExecutionEnvironmentContext`) from
 *   `./executionStyleContracts`.
 * - Uses local constants/helpers within this module.
 *
 * @param activeRequest - Active user request segment.
 * @param executionEnvironment - Planner execution environment context.
 * @returns Concrete user-owned root path, or `null` when the request is not explicit enough.
 */
function resolveRequestedRuntimeSweepRootPath(
  activeRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext
): string | null {
  if (DESKTOP_LOCATION_PATTERN.test(activeRequest) && executionEnvironment.desktopPath) {
    return executionEnvironment.desktopPath;
  }
  if (DOCUMENTS_LOCATION_PATTERN.test(activeRequest) && executionEnvironment.documentsPath) {
    return executionEnvironment.documentsPath;
  }
  if (DOWNLOADS_LOCATION_PATTERN.test(activeRequest) && executionEnvironment.downloadsPath) {
    return executionEnvironment.downloadsPath;
  }
  return null;
}

/**
 * Extracts the bounded folder selector for one runtime-sweep request.
 *
 * **Why it exists:**
 * The user can ask for a family of folders like `starts with sample`, and the fallback needs that
 * selector in typed form so later PowerShell generation stays deterministic instead of reparsing
 * free text multiple times.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param activeRequest - Active user request segment.
 * @returns Exact selector term and mode, or `null` when absent.
 */
function extractRuntimeSweepSelector(activeRequest: string): RuntimeSweepSelector | null {
  const startsWithMatch = activeRequest.match(STARTS_WITH_SELECTOR_PATTERN);
  if (startsWithMatch?.[1]) {
    return {
      mode: "starts_with",
      term: startsWithMatch[1].trim()
    };
  }
  const containsMatch = activeRequest.match(CONTAINS_SELECTOR_PATTERN);
  if (containsMatch?.[1]) {
    return {
      mode: "contains",
      term: containsMatch[1].trim()
    };
  }
  return null;
}

/**
 * Evaluates whether a request is a bounded Desktop-folder runtime sweep that should stay on a
 * deterministic process-management lane instead of drifting back into scaffold/build work.
 *
 * **Why it exists:**
 * This classifier carves out the high-friction `enumerate matching user folders, stop only their
 * exact listening servers` task so the planner does not improvise unrelated project generation in
 * response to a process-management request.
 *
 * **What it talks to:**
 * - Uses `extractActiveRequestSegment` (import `extractActiveRequestSegment`) from
 *   `../../core/currentRequestExtraction`.
 * - Uses `isRuntimeProcessManagementRequest` (import `isRuntimeProcessManagementRequest`) from
 *   `./liveVerificationPolicy`.
 * - Uses local constants/helpers within this module.
 *
 * @param currentUserRequest - Conversation-aware planner request text.
 * @returns `true` when the request is a bounded folder-matching runtime sweep.
 */
export function isDesktopFolderRuntimeProcessSweepRequest(
  currentUserRequest: string
): boolean {
  const activeRequest = extractActiveRequestSegment(currentUserRequest).trim();
  if (!activeRequest) return false;
  if (
    hasPlannerResolvedRouteMetadata(currentUserRequest) &&
    !hasResolvedRuntimeControlIntent(currentUserRequest, "stop_runtime") &&
    !hasResolvedRuntimeControlIntent(currentUserRequest, "inspect_runtime")
  ) {
    return false;
  }
  return (
    isRuntimeProcessManagementRequest(activeRequest) &&
    FOLDER_TARGET_PATTERN.test(activeRequest) &&
    STOP_SERVER_PATTERN.test(activeRequest) &&
    Boolean(extractRuntimeSweepSelector(activeRequest)) &&
    (
      DESKTOP_LOCATION_PATTERN.test(activeRequest) ||
      DOCUMENTS_LOCATION_PATTERN.test(activeRequest) ||
      DOWNLOADS_LOCATION_PATTERN.test(activeRequest)
    )
  );
}

/**
 * Builds deterministic fallback actions for bounded Desktop-folder runtime sweeps so process
 * inspection and shutdown cannot drift into unrelated scaffold/build work.
 *
 * **Why it exists:**
 * The planner needs one eager bounded lane for `Desktop folders matching X -> stop only their
 * running servers` requests; otherwise retries can waste budget on unrelated project generation.
 *
 * **What it talks to:**
 * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from
 *   `../../core/actionCostPolicy`.
 * - Uses `extractActiveRequestSegment` (import `extractActiveRequestSegment`) from
 *   `../../core/currentRequestExtraction`.
 * - Uses `makeId` (import `makeId`) from `../../core/ids`.
 * - Uses `PlannerExecutionEnvironmentContext` (import `PlannerExecutionEnvironmentContext`) from
 *   `./executionStyleContracts`.
 * - Uses local constants/helpers within this module.
 *
 * @param requestContext - Conversation-aware request text.
 * @param executionEnvironment - Planner execution environment context.
 * @returns Deterministic fallback actions, or an empty list when the request is not explicit enough.
 */
export function buildDeterministicDesktopRuntimeProcessSweepFallbackActions(
  requestContext: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): PlannedAction[] {
  if (
    !executionEnvironment ||
    executionEnvironment.platform !== "win32"
  ) {
    return [];
  }
  const activeRequest = extractActiveRequestSegment(requestContext).trim();
  if (!isDesktopFolderRuntimeProcessSweepRequest(activeRequest)) return [];
  const rootPath = resolveRequestedRuntimeSweepRootPath(activeRequest, executionEnvironment);
  const selector = extractRuntimeSweepSelector(activeRequest);
  if (!rootPath || !selector) return [];
  return [
    {
      id: makeId("action"),
      type: "stop_folder_runtime_processes",
      description:
        "Inspect the matching user-owned folders, stop only exact listening server processes tied to those folders, and prove which folders still had running servers afterward.",
      params: {
        rootPath,
        selectorMode: selector.mode,
        selectorTerm: selector.term
      },
      estimatedCostUsd: estimateActionCostUsd({
        type: "stop_folder_runtime_processes",
        params: {
          rootPath,
          selectorMode: selector.mode,
          selectorTerm: selector.term
        }
      })
    }
  ];
}
