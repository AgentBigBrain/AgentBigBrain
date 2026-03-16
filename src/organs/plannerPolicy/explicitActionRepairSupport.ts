/**
 * @fileoverview Shared deterministic action-normalization helpers for explicit planner repair.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { makeId } from "../../core/ids";
import type { PlannedAction } from "../../core/types";
import {
  containsWorkspaceRecoveryInspectFirstMarker,
  containsWorkspaceRecoveryPostShutdownRetryMarker,
  containsWorkspaceRecoveryStopExactMarker
} from "../../core/autonomy/workspaceRecoveryCommandBuilders";
import { isTrackedArtifactEditPreviewPlan } from "./buildExecutionActionHeuristics";
import { hasNonRespondAction, requiresExecutableBuildPlan } from "./buildExecutionPolicy";
import type { RequiredActionType } from "./executionStyleContracts";

const LINKED_PREVIEW_LEASE_INLINE_PATTERN = /\blinkedPreviewLease=([A-Za-z0-9:_-]+)/i;
const LINKED_PREVIEW_CWD_INLINE_PATTERN = /\blinkedPreviewCwd=([^\n]+)/i;
const LINKED_PREVIEW_PROCESS_LINE_PATTERN =
  /\bLinked preview process:\s*leaseId=([A-Za-z0-9:_-]+)(?:;\s*cwd=([^\n]+))?/i;
const WORKSPACE_ROOT_LINE_PATTERN = /^-\s*Root path:\s*(.+)$/im;
const VISIBLE_PREVIEW_URL_LINE_PATTERN =
  /^-\s*Visible preview already exists:\s*([^;\n]+)(?:;.*)?$/im;

/**
 * Detects whether the current request is one of the bounded workspace-recovery marker turns.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when workspace-recovery normalization should stay in effect.
 */
export function isWorkspaceRecoveryMarkerRequest(currentUserRequest: string): boolean {
  return (
    containsWorkspaceRecoveryInspectFirstMarker(currentUserRequest) ||
    containsWorkspaceRecoveryStopExactMarker(currentUserRequest) ||
    containsWorkspaceRecoveryPostShutdownRetryMarker(currentUserRequest)
  );
}

/**
 * Extracts one linked preview-process lease id from the conversation-aware execution input.
 *
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Linked preview-process lease id, or `null` when the current request context has none.
 */
export function extractLinkedPreviewLeaseId(fullExecutionInput: string): string | null {
  const inlineMatch = fullExecutionInput.match(LINKED_PREVIEW_LEASE_INLINE_PATTERN);
  if (inlineMatch?.[1]) {
    return inlineMatch[1];
  }
  const processLineMatch = fullExecutionInput.match(LINKED_PREVIEW_PROCESS_LINE_PATTERN);
  return processLineMatch?.[1] ?? null;
}

/**
 * Extracts the linked preview-process working folder from the conversation-aware execution input.
 *
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Linked preview cwd, or `null` when the current request context has none.
 */
function extractLinkedPreviewCwd(fullExecutionInput: string): string | null {
  const inlineMatch = fullExecutionInput.match(LINKED_PREVIEW_CWD_INLINE_PATTERN);
  if (inlineMatch?.[1]) {
    return inlineMatch[1].trim();
  }
  const processLineMatch = fullExecutionInput.match(LINKED_PREVIEW_PROCESS_LINE_PATTERN);
  return processLineMatch?.[2]?.trim() ?? null;
}

/**
 * Extracts one tracked workspace root path from the conversation-aware execution input.
 *
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Workspace root path, or `null` when the current request context has none.
 */
function extractWorkspaceRootPath(fullExecutionInput: string): string | null {
  const match = fullExecutionInput.match(WORKSPACE_ROOT_LINE_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  const rootPath = match[1].trim();
  return rootPath && rootPath !== "unknown" ? rootPath : null;
}

/**
 * Extracts the tracked visible preview URL from the conversation-aware execution input.
 *
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Visible preview URL, or `null` when the current request context has none.
 */
function extractVisiblePreviewUrl(fullExecutionInput: string): string | null {
  const match = fullExecutionInput.match(VISIBLE_PREVIEW_URL_LINE_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  const previewUrl = match[1].trim();
  return previewUrl.length > 0 ? previewUrl : null;
}

/**
 * Evaluates whether the action list already stops the exact linked preview-process lease.
 *
 * @param actions - Normalized planner actions.
 * @param linkedPreviewLeaseId - Linked preview-process lease recorded in the request context.
 * @returns `true` when the plan already includes the exact shutdown step.
 */
export function hasLinkedPreviewStopProcessAction(
  actions: readonly PlannedAction[],
  linkedPreviewLeaseId: string
): boolean {
  return actions.some(
    (action) =>
      action.type === "stop_process" &&
      typeof action.params.leaseId === "string" &&
      action.params.leaseId.trim() === linkedPreviewLeaseId
  );
}

/**
 * Removes unrelated stop-process actions and appends the exact linked preview shutdown step when a
 * natural close-browser follow-up targets one tracked preview stack.
 *
 * @param actions - Normalized planner actions.
 * @param requiredActionType - Deterministic required explicit action type for the current request.
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Planner actions normalized for linked preview-stack shutdown semantics.
 */
export function normalizeLinkedPreviewShutdownActions(
  actions: PlannedAction[],
  requiredActionType: RequiredActionType,
  fullExecutionInput: string
): PlannedAction[] {
  if (requiredActionType !== "close_browser") {
    return actions;
  }
  const linkedPreviewLeaseId = extractLinkedPreviewLeaseId(fullExecutionInput);
  if (!linkedPreviewLeaseId) {
    return actions;
  }

  const hasCloseBrowserAction = actions.some((action) => action.type === "close_browser");
  const filteredActions = actions.filter((action) => {
    if (action.type !== "stop_process") {
      return true;
    }
    const leaseId =
      typeof action.params.leaseId === "string" ? action.params.leaseId.trim() : "";
    return leaseId === linkedPreviewLeaseId;
  });

  if (
    hasCloseBrowserAction &&
    !hasLinkedPreviewStopProcessAction(filteredActions, linkedPreviewLeaseId)
  ) {
    filteredActions.push({
      id: makeId("action"),
      type: "stop_process",
      description: "Stop the tracked preview process linked to the browser session being closed.",
      params: {
        leaseId: linkedPreviewLeaseId
      },
      estimatedCostUsd: estimateActionCostUsd({
        type: "stop_process",
        params: {
          leaseId: linkedPreviewLeaseId
        }
      })
    });
  }

  return filteredActions;
}

/**
 * Backfills exact workspace ownership params into open-browser actions when the request context
 * already names the current tracked workspace or linked preview stack.
 *
 * @param actions - Normalized planner actions.
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Actions with exact workspace metadata backfilled into open-browser steps.
 */
export function normalizeOpenBrowserWorkspaceContext(
  actions: PlannedAction[],
  fullExecutionInput: string
): PlannedAction[] {
  const linkedPreviewLeaseId = extractLinkedPreviewLeaseId(fullExecutionInput);
  const linkedPreviewCwd = extractLinkedPreviewCwd(fullExecutionInput);
  const workspaceRootPath = extractWorkspaceRootPath(fullExecutionInput) ?? linkedPreviewCwd;
  if (!linkedPreviewLeaseId && !workspaceRootPath) {
    return actions;
  }
  return actions.map((action) => {
    if (action.type !== "open_browser") {
      return action;
    }
    const params = {
      ...action.params
    };
    if (
      linkedPreviewLeaseId &&
      typeof params.previewProcessLeaseId !== "string"
    ) {
      params.previewProcessLeaseId = linkedPreviewLeaseId;
    }
    if (workspaceRootPath && typeof params.rootPath !== "string") {
      params.rootPath = workspaceRootPath;
    }
    return {
      ...action,
      params
    };
  });
}

/**
 * Appends an exact tracked preview refresh step when an artifact-edit follow-up mutated the file
 * but omitted reopening the already-visible preview.
 *
 * @param actions - Normalized planner actions.
 * @param currentUserRequest - Active planner-facing request text.
 * @param requiredActionType - Deterministic required explicit action type for the current request.
 * @param fullExecutionInput - Conversation-aware execution payload sent to the planner.
 * @returns Actions with an exact preview-refresh step appended when the tracked edit context proves it is needed.
 */
export function normalizeTrackedArtifactPreviewRefreshActions(
  actions: PlannedAction[],
  currentUserRequest: string,
  requiredActionType: RequiredActionType,
  fullExecutionInput: string
): PlannedAction[] {
  const visiblePreviewUrl = extractVisiblePreviewUrl(fullExecutionInput);
  if (!visiblePreviewUrl) {
    return actions;
  }
  if (
    !isTrackedArtifactEditPreviewPlan(
      requiredActionType,
      currentUserRequest,
      fullExecutionInput,
      actions
    )
  ) {
    return actions;
  }
  const alreadyRefreshesVisiblePreview = actions.some((action) => {
    if (action.type !== "open_browser") {
      return false;
    }
    const actionUrl = typeof action.params.url === "string" ? action.params.url.trim() : "";
    return actionUrl.length > 0 && actionUrl === visiblePreviewUrl;
  });
  if (alreadyRefreshesVisiblePreview) {
    return actions;
  }

  return [
    ...actions,
    {
      id: makeId("action"),
      type: "open_browser",
      description: "Refresh the tracked visible preview so it reflects the edited artifact.",
      params: {
        url: visiblePreviewUrl
      },
      estimatedCostUsd: estimateActionCostUsd({
        type: "open_browser",
        params: {
          url: visiblePreviewUrl
        }
      })
    }
  ];
}

/**
 * Removes conversational `respond` actions when an execution-style build plan already contains real
 * executable work.
 *
 * @param actions - Normalized planner actions.
 * @param currentUserRequest - Active user request for execution-style policy checks.
 * @returns Actions with redundant respond steps removed when appropriate.
 */
export function stripExecutionStyleRespondActions(
  actions: PlannedAction[],
  currentUserRequest: string
): PlannedAction[] {
  if (!requiresExecutableBuildPlan(currentUserRequest) || !hasNonRespondAction(actions)) {
    return actions;
  }
  return actions.filter((action) => action.type !== "respond");
}
