/**
 * @fileoverview Deterministic fallback actions for bounded workspace-recovery marker steps.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import {
  containsWorkspaceRecoveryInspectFirstMarker,
  containsWorkspaceRecoveryStopExactMarker
} from "../../core/autonomy/workspaceRecoveryCommandBuilders";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { extractWorkspaceRecoveryBlockedFolderPaths } from "./workspaceRecoveryParsing";

const ROOT_PATH_LINE_PATTERNS = [
  /^-\s*Preferred workspace root:\s*(.+)$/im,
  /^-\s*Root path:\s*(.+)$/im
] as const;
const PREVIEW_URL_LINE_PATTERNS = [
  /^-\s*Preferred preview URL:\s*(.+)$/im,
  /^-\s*Preview URL:\s*(.+)$/im
] as const;
const BROWSER_SESSION_ID_LINE_PATTERNS = [
  /^-\s*Exact tracked browser session ids:\s*(.+)$/im,
  /^-\s*Browser session ids:\s*(.+)$/im,
  /^-\s*Browser session id:\s*(.+)$/im
] as const;
const PREVIEW_PROCESS_LEASE_ID_LINE_PATTERNS = [
  /^-\s*Exact tracked preview lease ids:\s*(.+)$/im,
  /^-\s*Preview process leases:\s*(.+)$/im,
  /^-\s*Preview process lease:\s*(.+)$/im
] as const;
const ATTRIBUTABLE_ROOT_LINE_PATTERN = /^-\s*root=([^;\n]+);/gim;
const EXACT_LEASE_ID_INLINE_PATTERN = /\bleaseId="([^"]+)"/g;
const EXACT_PID_INLINE_PATTERN = /\bpid=(\d+)\b/g;

/**
 * Normalizes one optional workspace-recovery line value.
 *
 * @param value - Raw line value.
 * @returns Trimmed non-empty value, or `null` when absent.
 */
function normalizeOptionalLineValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized === "none" || normalized === "unknown") {
    return null;
  }
  return normalized;
}

/**
 * Parses one comma-delimited workspace-recovery line into unique entries.
 *
 * @param value - Raw line value.
 * @returns Unique non-empty entries in first-seen order.
 */
function parseCsvLineValue(value: string | null | undefined): string[] {
  const normalized = normalizeOptionalLineValue(value);
  if (!normalized) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of normalized.split(",")) {
    const entry = normalizeOptionalLineValue(part);
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Reads the first matching single-line value from the execution input.
 *
 * @param input - Full execution input containing workspace-recovery context.
 * @param patterns - Candidate line-match patterns.
 * @returns First normalized line value, or `null` when none matched.
 */
function readSingleLineValue(
  input: string,
  patterns: readonly RegExp[]
): string | null {
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = normalizeOptionalLineValue(match?.[1]);
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * Reads the first CSV entry from the first matching recovery-context line.
 *
 * @param input - Full execution input containing workspace-recovery context.
 * @param patterns - Candidate line-match patterns.
 * @returns First parsed entry, or `null` when none matched.
 */
function readFirstCsvEntry(
  input: string,
  patterns: readonly RegExp[]
): string | null {
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const values = parseCsvLineValue(match?.[1]);
    if (values.length > 0) {
      return values[0] ?? null;
    }
  }
  return null;
}

/**
 * Extracts remembered attributable workspace roots from the recovery context block.
 *
 * @param fullExecutionInput - Conversation-aware execution payload.
 * @returns Unique attributable root paths.
 */
function extractAttributableRoots(fullExecutionInput: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const match of fullExecutionInput.matchAll(ATTRIBUTABLE_ROOT_LINE_PATTERN)) {
    const candidate = normalizeOptionalLineValue(match[1]);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    roots.push(candidate);
  }
  return roots;
}

/**
 * Extracts exact tracked preview lease ids embedded in the current recovery request.
 *
 * @param currentUserRequest - Active marker-bearing request text.
 * @param fullExecutionInput - Full execution input containing additional context.
 * @returns Unique exact lease ids.
 */
function extractExactLeaseIds(currentUserRequest: string, fullExecutionInput: string): string[] {
  const leaseIds: string[] = [];
  const seen = new Set<string>();
  for (const input of [currentUserRequest, fullExecutionInput]) {
    for (const match of input.matchAll(EXACT_LEASE_ID_INLINE_PATTERN)) {
      const leaseId = normalizeOptionalLineValue(match[1]);
      if (!leaseId || seen.has(leaseId)) {
        continue;
      }
      seen.add(leaseId);
      leaseIds.push(leaseId);
    }
  }
  return leaseIds;
}

/**
 * Extracts exact recovered preview-holder pids embedded in the current recovery request.
 *
 * @param currentUserRequest - Active marker-bearing request text.
 * @param fullExecutionInput - Full execution input containing additional context.
 * @returns Unique exact pids.
 */
function extractExactPids(currentUserRequest: string, fullExecutionInput: string): number[] {
  const pids: number[] = [];
  const seen = new Set<number>();
  for (const input of [currentUserRequest, fullExecutionInput]) {
    for (const match of input.matchAll(EXACT_PID_INLINE_PATTERN)) {
      const pid = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isInteger(pid) || seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      pids.push(pid);
    }
  }
  return pids;
}

/**
 * Builds a deterministic `inspect_path_holders` action for one blocked path.
 *
 * @param targetPath - Exact blocked path to inspect.
 * @returns Planned inspection action.
 */
function buildInspectPathHoldersAction(targetPath: string): PlannedAction {
  return {
    id: makeId("action"),
    type: "inspect_path_holders",
    description: `Inspect runtime-owned holders for the blocked path ${targetPath}.`,
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
 * Deduplicates normalized string values while preserving first-seen order.
 *
 * @param values - Candidate string values.
 * @returns Unique non-empty values.
 */
function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeOptionalLineValue(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Builds a deterministic `inspect_workspace_resources` action from parsed recovery context.
 *
 * @param params - Parsed workspace selector parameters.
 * @returns Planned workspace inspection action.
 */
function buildInspectWorkspaceResourcesAction(params: {
  rootPath: string | null;
  previewUrl: string | null;
  browserSessionId: string | null;
  previewProcessLeaseId: string | null;
}): PlannedAction {
  return {
    id: makeId("action"),
    type: "inspect_workspace_resources",
    description: "Inspect exact runtime-owned workspace resources before any shutdown or retry.",
    params: {
      ...(params.rootPath ? { rootPath: params.rootPath } : {}),
      ...(params.previewUrl ? { previewUrl: params.previewUrl } : {}),
      ...(params.browserSessionId ? { browserSessionId: params.browserSessionId } : {}),
      ...(params.previewProcessLeaseId
        ? { previewProcessLeaseId: params.previewProcessLeaseId }
        : {})
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "inspect_workspace_resources",
      params: {
        ...(params.rootPath ? { rootPath: params.rootPath } : {}),
        ...(params.previewUrl ? { previewUrl: params.previewUrl } : {}),
        ...(params.browserSessionId ? { browserSessionId: params.browserSessionId } : {}),
        ...(params.previewProcessLeaseId
          ? { previewProcessLeaseId: params.previewProcessLeaseId }
          : {})
      }
    })
  };
}

/**
 * Builds a deterministic `stop_process` action for one exact tracked preview lease id.
 *
 * @param leaseId - Exact tracked preview-process lease id.
 * @returns Planned stop action.
 */
function buildStopProcessAction(leaseId: string): PlannedAction {
  return {
    id: makeId("action"),
    type: "stop_process",
    description: `Stop the exact tracked preview holder ${leaseId}.`,
    params: {
      leaseId
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "stop_process",
      params: {
        leaseId
      }
    })
  };
}

/**
 * Builds a deterministic `stop_process` action for one exact recovered preview-holder pid.
 *
 * @param pid - Exact recovered preview-holder pid.
 * @returns Planned stop action.
 */
function buildStopProcessPidAction(pid: number): PlannedAction {
  return {
    id: makeId("action"),
    type: "stop_process",
    description: `Stop the recovered exact preview-holder pid ${pid}.`,
    params: {
      pid
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "stop_process",
      params: {
        pid
      }
    })
  };
}

/**
 * Builds bounded deterministic workspace-recovery fallback actions when the model still fails to
 * emit valid governed actions for a marker-bearing recovery step.
 *
 * @param currentUserRequest - Active marker-bearing recovery request.
 * @param fullExecutionInput - Conversation-aware execution payload with workspace context.
 * @returns Governed fallback actions, or an empty list when this request should still fail closed.
 */
export function buildDeterministicWorkspaceRecoveryFallbackActions(
  currentUserRequest: string,
  fullExecutionInput: string
): PlannedAction[] {
  if (containsWorkspaceRecoveryStopExactMarker(currentUserRequest)) {
    const exactLeaseIds = extractExactLeaseIds(currentUserRequest, fullExecutionInput);
    if (exactLeaseIds.length > 0) {
      return exactLeaseIds.map(buildStopProcessAction);
    }
    return extractExactPids(currentUserRequest, fullExecutionInput).map(buildStopProcessPidAction);
  }

  if (!containsWorkspaceRecoveryInspectFirstMarker(currentUserRequest)) {
    return [];
  }

  const blockedFolderPaths = dedupeStrings(
    extractWorkspaceRecoveryBlockedFolderPaths(currentUserRequest).concat(
      extractWorkspaceRecoveryBlockedFolderPaths(fullExecutionInput)
    )
  );
  if (blockedFolderPaths.length > 0) {
    return blockedFolderPaths.slice(0, 5).map(buildInspectPathHoldersAction);
  }

  const attributableRoot = extractAttributableRoots(fullExecutionInput)[0] ?? null;
  const rootPath =
    readSingleLineValue(fullExecutionInput, ROOT_PATH_LINE_PATTERNS) ?? attributableRoot;
  const previewUrl = readSingleLineValue(fullExecutionInput, PREVIEW_URL_LINE_PATTERNS);
  const browserSessionId = readFirstCsvEntry(fullExecutionInput, BROWSER_SESSION_ID_LINE_PATTERNS);
  const previewProcessLeaseId =
    readFirstCsvEntry(fullExecutionInput, PREVIEW_PROCESS_LEASE_ID_LINE_PATTERNS) ??
    extractExactLeaseIds(currentUserRequest, fullExecutionInput)[0] ??
    null;

  if (rootPath || previewUrl || browserSessionId || previewProcessLeaseId) {
    return [
      buildInspectWorkspaceResourcesAction({
        rootPath,
        previewUrl,
        browserSessionId,
        previewProcessLeaseId
      })
    ];
  }

  return attributableRoot ? [buildInspectPathHoldersAction(attributableRoot)] : [];
}
