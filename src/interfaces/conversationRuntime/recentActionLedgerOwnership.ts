/**
 * @fileoverview Resolves browser-session ownership and preview-process linkage for recent-action ledgers.
 */

import type { ActionRunResult } from "../../core/types";
import {
  normalizeInteger,
  normalizeString
} from "./recentActionLedgerMetadataHelpers";

export interface TaskLevelLinkedProcessContext {
  leaseId: string;
  cwd: string | null;
  pid: number | null;
}

export interface BrowserSessionOwnershipContext extends TaskLevelLinkedProcessContext {
  workspaceRootPath: string | null;
}

interface IndexedTaskLevelLinkedProcessContext extends TaskLevelLinkedProcessContext {
  actionIndex: number;
}

/**
 * Normalizes one local path into a stable comparable value.
 *
 * @param value - Candidate local path.
 * @returns Comparable path, or `null` when the input is blank.
 */
function normalizeComparablePath(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Collects successful non-stopped managed-process leases from a completed task with execution order.
 *
 * @param actionResults - Action results emitted by the completed task.
 * @returns Managed-process candidates in execution order.
 */
export function collectTaskLevelLinkedProcesses(
  actionResults: readonly ActionRunResult[]
): readonly IndexedTaskLevelLinkedProcessContext[] {
  return actionResults
    .map((actionResult, actionIndex) => {
      const metadata = actionResult.executionMetadata ?? {};
      const leaseId = normalizeString(metadata.processLeaseId);
      if (!leaseId || actionResult.executionStatus !== "success") {
        return null;
      }
      if (normalizeString(metadata.processLifecycleStatus) === "PROCESS_STOPPED") {
        return null;
      }
      return {
        leaseId,
        cwd: normalizeString(metadata.processCwd),
        pid: normalizeInteger(metadata.processPid),
        actionIndex
      } satisfies IndexedTaskLevelLinkedProcessContext;
    })
    .filter((candidate): candidate is IndexedTaskLevelLinkedProcessContext => candidate !== null);
}

/**
 * Resolves one browser-open action's most relevant preview-process lease from completed task
 * results when explicit browser ownership metadata is absent.
 *
 * @param actionResult - Browser-open action being materialized into session ledgers.
 * @param actionIndex - Execution index of the browser-open action.
 * @param taskLevelLinkedProcesses - Successful non-stopped process leases from the same task.
 * @returns Linked process context, or `null` when no deterministic match exists.
 */
export function resolveBrowserLinkedProcessForAction(
  actionResult: ActionRunResult,
  actionIndex: number,
  taskLevelLinkedProcesses: readonly IndexedTaskLevelLinkedProcessContext[]
): TaskLevelLinkedProcessContext | null {
  const priorCandidates = taskLevelLinkedProcesses
    .filter((candidate) => candidate.actionIndex < actionIndex)
    .sort((left, right) => right.actionIndex - left.actionIndex);
  if (priorCandidates.length === 0) {
    return null;
  }

  const actionRootPath =
    actionResult.action.type === "open_browser"
      ? normalizeString(actionResult.action.params.rootPath)
      : null;
  const comparableActionRootPath = normalizeComparablePath(actionRootPath);
  if (comparableActionRootPath) {
    const matchingRootCandidates = priorCandidates.filter(
      (candidate) => normalizeComparablePath(candidate.cwd) === comparableActionRootPath
    );
    if (matchingRootCandidates.length > 0) {
      return matchingRootCandidates[0] ?? null;
    }
  }

  if (priorCandidates.length === 1) {
    return priorCandidates[0] ?? null;
  }

  const uniqueComparableCwds = new Set(
    priorCandidates
      .map((candidate) => normalizeComparablePath(candidate.cwd))
      .filter((candidateCwd): candidateCwd is string => candidateCwd !== null)
  );
  if (uniqueComparableCwds.size === 1) {
    return priorCandidates[0] ?? null;
  }

  return null;
}
