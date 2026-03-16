/**
 * @fileoverview Structured runtime-inspection metadata helpers for workspace-lock recovery.
 */

import type { TaskRunResult } from "../types";

/**
 * Structured runtime-owned inspection metadata recovered from approved inspection actions.
 */
export interface RuntimeOwnershipInspectionMetadata {
  recommendedNextAction: string | null;
  ownershipClassification: string | null;
  previewProcessLeaseIds: readonly string[];
  recoveredExactPreviewHolderPids: readonly number[];
  recoveredExactPreviewHolderLeaseIds: readonly string[];
  untrackedCandidatePids: readonly number[];
  untrackedCandidateKinds: readonly string[];
  untrackedCandidateNames: readonly string[];
  untrackedCandidates: readonly RuntimeInspectionUntrackedCandidateMetadata[];
}

/**
 * Structured untracked-holder metadata recovered from runtime inspection output.
 */
export interface RuntimeInspectionUntrackedCandidateMetadata {
  pid: number;
  kind: string | null;
  name: string | null;
  confidence: "high" | "medium" | "low" | null;
  reason: string | null;
}

/**
 * Keeps the higher-priority recovery recommendation when multiple inspections contribute metadata.
 *
 * @param currentValue - Current highest-priority recommendation.
 * @param nextValue - Newly observed recommendation.
 * @returns The higher-priority recommendation value.
 */
function selectHigherPriorityRecommendedNextAction(
  currentValue: string | null,
  nextValue: string | null
): string | null {
  const priority = new Map<string, number>([
    ["stop_exact_tracked_holders", 5],
    ["clarify_before_exact_non_preview_shutdown", 4],
    ["clarify_before_likely_non_preview_shutdown", 3],
    ["clarify_before_untracked_shutdown", 2],
    ["manual_non_preview_holder_cleanup", 1],
    ["manual_orphaned_browser_cleanup", 2],
    ["collect_more_evidence", 1]
  ]);
  if (!nextValue) {
    return currentValue;
  }
  if (!currentValue) {
    return nextValue;
  }
  return (priority.get(nextValue) ?? 0) > (priority.get(currentValue) ?? 0)
    ? nextValue
    : currentValue;
}

/**
 * Keeps the higher-priority ownership classification when multiple inspections contribute metadata.
 *
 * @param currentValue - Current highest-priority classification.
 * @param nextValue - Newly observed classification.
 * @returns The higher-priority classification value.
 */
function selectHigherPriorityOwnershipClassification(
  currentValue: string | null,
  nextValue: string | null
): string | null {
  const priority = new Map<string, number>([
    ["current_tracked", 4],
    ["orphaned_attributable", 3],
    ["stale_tracked", 2],
    ["unknown", 1]
  ]);
  if (!nextValue) {
    return currentValue;
  }
  if (!currentValue) {
    return nextValue;
  }
  return (priority.get(nextValue) ?? 0) > (priority.get(currentValue) ?? 0)
    ? nextValue
    : currentValue;
}

/**
 * Parses one comma-separated metadata field into unique string entries.
 *
 * @param value - Runtime metadata value.
 * @returns Unique non-empty string entries in first-seen order.
 */
function parseCsvStrings(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of value.split(",")) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

/**
 * Parses one pipe-delimited metadata field into unique string entries.
 *
 * @param value - Runtime metadata value.
 * @returns Unique non-empty string entries in first-seen order.
 */
function parsePipeStrings(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of value.split("|")) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

/**
 * Parses one delimited metadata field without deduplicating so candidate metadata keeps index
 * alignment across names, kinds, confidences, and reasons.
 *
 * @param value - Runtime metadata value.
 * @param delimiter - Single-character field delimiter.
 * @returns Ordered trimmed entries.
 */
function parseDelimitedValuesPreserveOrder(value: unknown, delimiter: string): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  return value.split(delimiter).map((entry) => entry.trim());
}

/**
 * Parses one comma-separated metadata field into integer process ids.
 *
 * @param value - Runtime metadata value.
 * @returns Integer process ids parsed from the metadata field.
 */
function parseCsvIntegers(value: unknown): number[] {
  const numbers: number[] = [];
  for (const entry of parseCsvStrings(value)) {
    const parsed = Number.parseInt(entry, 10);
    if (Number.isInteger(parsed)) {
      numbers.push(parsed);
    }
  }
  return numbers;
}

/**
 * Rehydrates structured untracked-holder metadata from parallel runtime metadata fields.
 *
 * @param metadata - Execution metadata emitted by runtime inspection.
 * @returns Ordered candidate records aligned with the original runtime inspection output.
 */
function parseUntrackedCandidateMetadata(
  metadata: Record<string, unknown>
): RuntimeInspectionUntrackedCandidateMetadata[] {
  const pids = parseCsvIntegers(metadata.inspectionUntrackedCandidatePids);
  if (pids.length === 0) {
    return [];
  }
  const kinds = parseDelimitedValuesPreserveOrder(metadata.inspectionUntrackedCandidateKinds, ",");
  const names = parseDelimitedValuesPreserveOrder(metadata.inspectionUntrackedCandidateNames, "|");
  const confidences = parseDelimitedValuesPreserveOrder(
    metadata.inspectionUntrackedCandidateConfidences,
    ","
  );
  const reasons = parseDelimitedValuesPreserveOrder(
    metadata.inspectionUntrackedCandidateReasons,
    "|"
  );

  return pids.map((pid, index) => {
    const confidenceValue = confidences[index];
    return {
      pid,
      kind: kinds[index] && kinds[index] !== "unknown" ? kinds[index] : null,
      name: names[index] && names[index] !== "unknown" ? names[index] : null,
      confidence:
        confidenceValue === "high" || confidenceValue === "medium" || confidenceValue === "low"
          ? confidenceValue
          : null,
      reason: reasons[index] && reasons[index] !== "unknown" ? reasons[index] : null
    };
  });
}

/**
 * Extracts the newest runtime-ownership inspection metadata from a completed task result.
 *
 * @param taskRunResult - Completed task result being evaluated for recovery.
 * @returns Structured inspection metadata or `null` when no inspection action was approved.
 */
export function readRuntimeOwnershipInspectionMetadata(
  taskRunResult: TaskRunResult
): RuntimeOwnershipInspectionMetadata | null {
  const previewLeaseIds = new Set<string>();
  const recoveredExactPreviewHolderPids = new Set<number>();
  const recoveredExactPreviewHolderLeaseIds = new Set<string>();
  const untrackedCandidatePids = new Set<number>();
  const untrackedCandidateKinds = new Set<string>();
  const untrackedCandidateNames = new Set<string>();
  const untrackedCandidates: RuntimeInspectionUntrackedCandidateMetadata[] = [];
  let recommendedNextAction: string | null = null;
  let ownershipClassification: string | null = null;
  let sawInspection = false;
  for (const actionResult of taskRunResult.actionResults) {
    if (!actionResult?.approved) {
      continue;
    }
    if (
      actionResult.action.type !== "inspect_workspace_resources" &&
      actionResult.action.type !== "inspect_path_holders"
    ) {
      continue;
    }
    const metadata = actionResult.executionMetadata ?? {};
    if (metadata.runtimeOwnershipInspection !== true) {
      continue;
    }
    sawInspection = true;
    recommendedNextAction = selectHigherPriorityRecommendedNextAction(
      recommendedNextAction,
      typeof metadata.inspectionRecommendedNextAction === "string"
        ? metadata.inspectionRecommendedNextAction
        : null
    );
    ownershipClassification = selectHigherPriorityOwnershipClassification(
      ownershipClassification,
      typeof metadata.inspectionOwnershipClassification === "string"
        ? metadata.inspectionOwnershipClassification
        : null
    );
    for (const leaseId of parseCsvStrings(metadata.inspectionPreviewProcessLeaseIds)) {
      previewLeaseIds.add(leaseId);
    }
    for (const leaseId of parseCsvStrings(metadata.inspectionRecoveredExactPreviewHolderLeaseIds)) {
      recoveredExactPreviewHolderLeaseIds.add(leaseId);
    }
    for (const pid of parseCsvIntegers(metadata.inspectionRecoveredExactPreviewHolderPids)) {
      recoveredExactPreviewHolderPids.add(pid);
    }
    for (const pid of parseCsvIntegers(metadata.inspectionUntrackedCandidatePids)) {
      untrackedCandidatePids.add(pid);
    }
    for (const kind of parseCsvStrings(metadata.inspectionUntrackedCandidateKinds)) {
      untrackedCandidateKinds.add(kind);
    }
    for (const name of parsePipeStrings(metadata.inspectionUntrackedCandidateNames)) {
      untrackedCandidateNames.add(name);
    }
    for (const candidate of parseUntrackedCandidateMetadata(metadata)) {
      untrackedCandidates.push(candidate);
    }
  }
  if (!sawInspection) {
    return null;
  }
  return {
    recommendedNextAction,
    ownershipClassification,
    previewProcessLeaseIds: Array.from(previewLeaseIds),
    recoveredExactPreviewHolderPids: Array.from(recoveredExactPreviewHolderPids),
    recoveredExactPreviewHolderLeaseIds: Array.from(recoveredExactPreviewHolderLeaseIds),
    untrackedCandidatePids: Array.from(untrackedCandidatePids),
    untrackedCandidateKinds: Array.from(untrackedCandidateKinds),
    untrackedCandidateNames: Array.from(untrackedCandidateNames),
    untrackedCandidates
  };
}
