/**
 * @fileoverview Keeps framework fallback request-bounding and goal-derived folder/theme resolution
 * separate from the main deterministic lifecycle builder.
 */

import { extractSemanticRequestSegment } from "../../core/currentRequestExtraction";
import { extractRequestedFrameworkFolderName } from "./frameworkBuildActionHeuristics";
import { getPathModuleForPathValue } from "./frameworkPathSupport";
import {
  isRuntimeProcessManagementRequest,
  requiresFrameworkAppScaffoldAction
} from "./liveVerificationPolicy";

const TRACKED_WORKSPACE_REFERENCE_PATTERN = /\b(?:reuse|existing|current|same|tracked)\b/i;
const FRAMEWORK_RESTART_CONTINUATION_PATTERN =
  /\b(?:restart|start|launch|run|open|reopen|bring\s+(?:back|up)|pull\s+up)\b/i;
const EXPLICIT_THEME_OR_STRUCTURE_OVERRIDE_PATTERN =
  /\b([3-6])\s+(?:main\s+)?sections?\b|\bdrone\b|\baerial\b|\buav\b|\bflight\b|\b(?:gritty|industrial|street|urban|detroit|steel|brick|concrete|foundry|warehouse)\b/i;

export interface FrameworkFallbackRequestContext {
  readonly activeRequest: string;
  readonly goalRequest: string;
  readonly requestedFolderName: string | null;
  readonly themeRequestContext: string;
  readonly requestedFolderNameExplicitlyNamedInActiveRequest: boolean;
  readonly activeRequestExplicitlyTargetsDifferentFolder: boolean;
}

/** Compares two folder labels using trimmed, case-insensitive matching. */
function folderNamesMatch(left: string | null, right: string | null): boolean {
  if (!left || !right) {
    return false;
  }
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Resolves the bounded active request, fallback folder name, and theme-driving request text for one
 * deterministic framework lifecycle turn.
 *
 * @param requestContext - Active planner input for this turn.
 * @param goalContext - Overarching task goal when later turns become generic.
 * @param effectiveTrackedWorkspaceRoot - Exact workspace root currently tracked for this turn.
 * @returns Request-bounded framework fallback context.
 */
export function resolveFrameworkFallbackRequestContext(
  requestContext: string,
  goalContext: string | null,
  effectiveTrackedWorkspaceRoot: string | null
): FrameworkFallbackRequestContext {
  const activeRequest = extractSemanticRequestSegment(requestContext).trim();
  const goalRequest =
    typeof goalContext === "string" ? extractSemanticRequestSegment(goalContext).trim() : "";
  if (isRuntimeProcessManagementRequest(activeRequest)) {
    return {
      activeRequest,
      goalRequest,
      requestedFolderName: null,
      themeRequestContext: activeRequest,
      requestedFolderNameExplicitlyNamedInActiveRequest: false,
      activeRequestExplicitlyTargetsDifferentFolder: false
    };
  }
  const trackedWorkspaceFolderName = effectiveTrackedWorkspaceRoot
    ? getPathModuleForPathValue(effectiveTrackedWorkspaceRoot).basename(
        effectiveTrackedWorkspaceRoot
      )
    : null;
  const activeRequestedFolderName = extractRequestedFrameworkFolderName(activeRequest);
  const goalRequestedFolderName =
    goalRequest.length > 0 ? extractRequestedFrameworkFolderName(goalRequest) : null;
  const activeRequestExplicitlyTargetsDifferentFolder =
    activeRequestedFolderName !== null &&
    trackedWorkspaceFolderName !== null &&
    !folderNamesMatch(activeRequestedFolderName, trackedWorkspaceFolderName);
  const prefersTrackedWorkspaceFolderName =
    trackedWorkspaceFolderName !== null &&
    activeRequestedFolderName === null &&
    (
      TRACKED_WORKSPACE_REFERENCE_PATTERN.test(activeRequest) ||
      FRAMEWORK_RESTART_CONTINUATION_PATTERN.test(activeRequest)
    );
  const requestedFolderName =
    activeRequestedFolderName ??
    (prefersTrackedWorkspaceFolderName ? trackedWorkspaceFolderName : null) ??
    goalRequestedFolderName ??
    trackedWorkspaceFolderName;
  const themeRequestContext =
    goalRequest.length > 0 &&
    FRAMEWORK_RESTART_CONTINUATION_PATTERN.test(activeRequest) &&
    !EXPLICIT_THEME_OR_STRUCTURE_OVERRIDE_PATTERN.test(activeRequest) &&
    !activeRequestExplicitlyTargetsDifferentFolder &&
    (
      effectiveTrackedWorkspaceRoot !== null ||
      activeRequestedFolderName === null ||
      requiresFrameworkAppScaffoldAction(activeRequest)
    )
      ? goalRequest
      : activeRequest;
  return {
    activeRequest,
    goalRequest,
    requestedFolderName,
    themeRequestContext,
    requestedFolderNameExplicitlyNamedInActiveRequest: activeRequestedFolderName !== null,
    activeRequestExplicitlyTargetsDifferentFolder
  };
}
