/**
 * @fileoverview Shared deterministic action-normalization helpers for explicit planner repair.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import {
  dirnameCrossPlatformPath,
  localFileUrlToAbsolutePath
} from "../../core/crossPlatformPath";
import { makeId } from "../../core/ids";
import type { PlannedAction } from "../../core/types";
import {
  containsWorkspaceRecoveryInspectFirstMarker,
  containsWorkspaceRecoveryPostShutdownRetryMarker,
  containsWorkspaceRecoveryStopExactMarker
} from "../../core/autonomy/workspaceRecoveryCommandBuilders";
import { isTrackedArtifactEditPreviewPlan } from "./buildExecutionActionHeuristics";
import { hasNonRespondAction, requiresExecutableBuildPlan } from "./buildExecutionPolicy";
import type {
  RequiredActionType
} from "./executionStyleContracts";

const LINKED_PREVIEW_LEASE_INLINE_PATTERN = /\blinkedPreviewLease=([A-Za-z0-9:_-]+)/i;
const LINKED_PREVIEW_CWD_INLINE_PATTERN = /\blinkedPreviewCwd=([^\n]+)/i;
const LINKED_PREVIEW_PROCESS_LINE_PATTERN =
  /\bLinked preview process:\s*leaseId=([A-Za-z0-9:_-]+)(?:;\s*cwd=([^\n]+))?/i;
const PREVIEW_PROCESS_LEASES_LINE_PATTERN = /^-\s*Preview process leases:\s*(.+)$/im;
const WORKSPACE_ROOT_LINE_PATTERN = /^-\s*Root path:\s*(.+)$/im;
const VISIBLE_PREVIEW_URL_LINE_PATTERN =
  /^-\s*Visible preview already exists:\s*([^;\n]+)(?:;.*)?$/im;

/**
 * Normalizes optional string.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Evaluates whether missing preview process lease id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isMissingPreviewProcessLeaseId(value: unknown): boolean {
  const normalized = normalizeOptionalString(value);
  return (
    normalized === null ||
    normalized.toLowerCase() === "none" ||
    normalized.toLowerCase() === "null"
  );
}

/**
 * Derives local file workspace root path.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `dirnameCrossPlatformPath` (import `dirnameCrossPlatformPath`) from `../../core/crossPlatformPath`.
 * - Uses `localFileUrlToAbsolutePath` (import `localFileUrlToAbsolutePath`) from `../../core/crossPlatformPath`.
 * @param urlValue - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function deriveLocalFileWorkspaceRootPath(urlValue: unknown): string | null {
  const normalizedUrl = normalizeOptionalString(urlValue);
  if (!normalizedUrl?.startsWith("file://")) {
    return null;
  }
  try {
    const localPath = localFileUrlToAbsolutePath(normalizedUrl);
    return localPath ? dirnameCrossPlatformPath(localPath) : null;
  } catch {
    return null;
  }
}

/**
 * Uniques non empty.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param values - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Normalizes tracked preview lease id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeTrackedPreviewLeaseId(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return isMissingPreviewProcessLeaseId(normalized) ? null : normalized;
}

/**
 * Extracts tracked preview lease ids.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param fullExecutionInput - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractTrackedPreviewLeaseIds(fullExecutionInput: string): string[] {
  const leaseIds: string[] = [];
  const previewLeaseListMatch = fullExecutionInput.match(PREVIEW_PROCESS_LEASES_LINE_PATTERN);
  if (previewLeaseListMatch?.[1]) {
    leaseIds.push(
      ...previewLeaseListMatch[1]
        .split(",")
        .map((value) => normalizeTrackedPreviewLeaseId(value))
        .filter((value): value is string => value !== null && /^[A-Za-z0-9:_-]+$/.test(value))
    );
  }
  const inlineMatch = fullExecutionInput.match(LINKED_PREVIEW_LEASE_INLINE_PATTERN);
  const normalizedInlineLeaseId = normalizeTrackedPreviewLeaseId(inlineMatch?.[1] ?? null);
  if (normalizedInlineLeaseId) {
    leaseIds.push(normalizedInlineLeaseId);
  }
  const processLineMatch = fullExecutionInput.match(LINKED_PREVIEW_PROCESS_LINE_PATTERN);
  const normalizedProcessLineLeaseId = normalizeTrackedPreviewLeaseId(processLineMatch?.[1] ?? null);
  if (normalizedProcessLineLeaseId) {
    leaseIds.push(normalizedProcessLineLeaseId);
  }
  return uniqueNonEmpty(leaseIds);
}

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
  return extractTrackedPreviewLeaseIds(fullExecutionInput)[0] ?? null;
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
  const linkedPreviewLeaseIds = extractTrackedPreviewLeaseIds(fullExecutionInput);
  const filteredActions = actions.filter((action) => {
    if (action.type !== "stop_process") {
      return true;
    }
    const hasExactPidTarget =
      typeof action.params.pid === "number" &&
      Number.isInteger(action.params.pid) &&
      action.params.pid > 0;
    const leaseId =
      typeof action.params.leaseId === "string" ? action.params.leaseId.trim() : null;
    if (hasExactPidTarget) {
      return true;
    }
    if (isMissingPreviewProcessLeaseId(leaseId)) {
      return false;
    }
    if (linkedPreviewLeaseIds.length === 0) {
      return true;
    }
    return leaseId !== null && linkedPreviewLeaseIds.includes(leaseId);
  });

  if (linkedPreviewLeaseIds.length === 0) {
    return filteredActions;
  }

  const hasCloseBrowserAction = filteredActions.some(
    (action) => action.type === "close_browser"
  );

  if (hasCloseBrowserAction) {
    for (const linkedPreviewLeaseId of linkedPreviewLeaseIds) {
      if (hasLinkedPreviewStopProcessAction(filteredActions, linkedPreviewLeaseId)) {
        continue;
      }
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
    const derivedLocalFileWorkspaceRootPath = deriveLocalFileWorkspaceRootPath(action.params.url);
    const params: Record<string, unknown> = {
      ...action.params
    };
    if (
      linkedPreviewLeaseId &&
      typeof params.previewProcessLeaseId !== "string"
    ) {
      params.previewProcessLeaseId = linkedPreviewLeaseId;
    }
    if (derivedLocalFileWorkspaceRootPath) {
      params.rootPath = derivedLocalFileWorkspaceRootPath;
    } else if (workspaceRootPath && typeof params.rootPath !== "string") {
      params.rootPath = workspaceRootPath;
    }
    if (isMissingPreviewProcessLeaseId(params.previewProcessLeaseId)) {
      delete params.previewProcessLeaseId;
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
  currentUserRequest: string,
  requiredActionType: RequiredActionType = null
): PlannedAction[] {
  const shouldStripRespond =
    (requiresExecutableBuildPlan(currentUserRequest) || requiredActionType === "close_browser") &&
    hasNonRespondAction(actions);
  if (!shouldStripRespond) {
    return actions;
  }
  return actions.filter((action) => action.type !== "respond");
}
