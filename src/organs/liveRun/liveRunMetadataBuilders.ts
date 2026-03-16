/**
 * @fileoverview Shared metadata builders for browser-session and runtime-ownership inspection outcomes.
 */

import { RuntimeTraceDetailValue } from "../../core/types";
import { BrowserSessionControllerKind } from "./browserSessionRegistry";
import type { BrowserSessionSnapshot } from "./browserSessionRegistry";
import {
  RuntimeInspectionRecommendedNextAction,
  UntrackedHolderCandidate
} from "./untrackedPreviewCandidateInspection";

export type RuntimeOwnershipInspectionClassification =
  | "current_tracked"
  | "stale_tracked"
  | "orphaned_attributable"
  | "unknown";

/**
 * Serializes untracked-holder kinds into stable comma-delimited metadata.
 *
 * @param candidates - Untracked holder candidates collected by runtime inspection.
 * @returns Comma-delimited kind list, or `null` when no candidates were found.
 */
function serializeUntrackedCandidateKinds(
  candidates: readonly UntrackedHolderCandidate[]
): string | null {
  if (candidates.length === 0) {
    return null;
  }
  return candidates.map((candidate) => candidate.holderKind).join(",");
}

/**
 * Builds persistent browser-open metadata for receipts and conversation ledgers.
 *
 * @param details - Structured browser-open details for this outcome.
 * @returns Metadata bag safe for runtime trace persistence.
 */
export function buildBrowserSessionExecutionMetadata(details: {
  sessionId: string;
  url: string;
  status: "open" | "closed";
  visibility: "visible" | "headless";
  controllerKind: BrowserSessionControllerKind;
  controlAvailable: boolean;
  browserProcessPid: number | null;
  workspaceRootPath?: string | null;
  linkedProcessLeaseId?: string | null;
  linkedProcessCwd?: string | null;
  linkedProcessPid?: number | null;
  openMethod?: string | null;
}): Record<string, RuntimeTraceDetailValue> {
  return {
    browserSession: true,
    browserSessionId: details.sessionId,
    browserSessionUrl: details.url,
    browserSessionStatus: details.status,
    browserSessionVisibility: details.visibility,
    browserSessionControllerKind: details.controllerKind,
    browserSessionControlAvailable: details.controlAvailable,
    browserSessionBrowserProcessPid: details.browserProcessPid,
    browserSessionWorkspaceRootPath: details.workspaceRootPath ?? null,
    browserSessionLinkedProcessLeaseId: details.linkedProcessLeaseId ?? null,
    browserSessionLinkedProcessCwd: details.linkedProcessCwd ?? null,
    browserSessionLinkedProcessPid: details.linkedProcessPid ?? null,
    browserOpenMethod: details.openMethod ?? null
  };
}

/**
 * Builds machine-readable metadata for linked browser-session cleanup performed alongside another
 * exact runtime operation like `stop_process`.
 *
 * @param sessions - Browser sessions observed after cleanup was attempted.
 * @returns Metadata bag safe for runtime trace persistence.
 */
export function buildLinkedBrowserSessionCleanupMetadata(
  sessions: readonly BrowserSessionSnapshot[]
): Record<string, RuntimeTraceDetailValue> {
  return {
    linkedBrowserSessionCleanupCount: sessions.length,
    linkedBrowserSessionCleanupRecordsJson:
      sessions.length > 0 ? JSON.stringify(sessions) : null
  };
}

/**
 * Builds runtime-owned holder or workspace-inspection metadata for recovery planning.
 *
 * @param details - Structured inspection details for this outcome.
 * @returns Metadata bag safe for runtime trace persistence.
 */
export function buildRuntimeOwnershipInspectionMetadata(details: {
  inspectionKind: "path_holders" | "workspace_resources";
  targetPath: string | null;
  rootPath: string | null;
  previewUrl: string | null;
  recoveredExactPreviewHolderPids: readonly number[];
  recoveredExactPreviewHolderLeaseIds: readonly string[];
  browserSessionIds: readonly string[];
  browserProcessPids: readonly number[];
  previewProcessLeaseIds: readonly string[];
  previewProcessPids: readonly number[];
  staleBrowserSessionIds: readonly string[];
  stalePreviewProcessLeaseIds: readonly string[];
  orphanedBrowserSessionIds: readonly string[];
  foundTrackedHolder: boolean;
  foundTrackedWorkspaceResource: boolean;
  foundStaleTrackedResource: boolean;
  foundOrphanedAttributableResource: boolean;
  ownershipClassification: RuntimeOwnershipInspectionClassification;
  untrackedCandidates: readonly UntrackedHolderCandidate[];
  recommendedNextAction: RuntimeInspectionRecommendedNextAction;
}): Record<string, RuntimeTraceDetailValue> {
  return {
    runtimeOwnershipInspection: true,
    runtimeOwnershipInspectionKind: details.inspectionKind,
    inspectionTargetPath: details.targetPath,
    inspectionRootPath: details.rootPath,
    inspectionPreviewUrl: details.previewUrl,
    inspectionRecoveredExactPreviewHolderPids:
      details.recoveredExactPreviewHolderPids.length > 0
        ? details.recoveredExactPreviewHolderPids.join(",")
        : null,
    inspectionRecoveredExactPreviewHolderLeaseIds:
      details.recoveredExactPreviewHolderLeaseIds.length > 0
        ? details.recoveredExactPreviewHolderLeaseIds.join(",")
        : null,
    inspectionRecoveredExactPreviewHolderCount:
      details.recoveredExactPreviewHolderPids.length,
    inspectionBrowserSessionIds:
      details.browserSessionIds.length > 0 ? details.browserSessionIds.join(",") : null,
    inspectionBrowserProcessPids:
      details.browserProcessPids.length > 0 ? details.browserProcessPids.join(",") : null,
    inspectionPreviewProcessLeaseIds:
      details.previewProcessLeaseIds.length > 0
        ? details.previewProcessLeaseIds.join(",")
        : null,
    inspectionPreviewProcessPids:
      details.previewProcessPids.length > 0 ? details.previewProcessPids.join(",") : null,
    inspectionBrowserSessionCount: details.browserSessionIds.length,
    inspectionPreviewProcessCount: details.previewProcessLeaseIds.length,
    inspectionStaleBrowserSessionIds:
      details.staleBrowserSessionIds.length > 0
        ? details.staleBrowserSessionIds.join(",")
        : null,
    inspectionStalePreviewProcessLeaseIds:
      details.stalePreviewProcessLeaseIds.length > 0
        ? details.stalePreviewProcessLeaseIds.join(",")
        : null,
    inspectionOrphanedBrowserSessionIds:
      details.orphanedBrowserSessionIds.length > 0
        ? details.orphanedBrowserSessionIds.join(",")
        : null,
    inspectionStaleBrowserSessionCount: details.staleBrowserSessionIds.length,
    inspectionStalePreviewProcessCount: details.stalePreviewProcessLeaseIds.length,
    inspectionOrphanedBrowserSessionCount: details.orphanedBrowserSessionIds.length,
    inspectionFoundTrackedHolder: details.foundTrackedHolder,
    inspectionFoundTrackedWorkspaceResource: details.foundTrackedWorkspaceResource,
    inspectionFoundStaleTrackedResource: details.foundStaleTrackedResource,
    inspectionFoundOrphanedAttributableResource:
      details.foundOrphanedAttributableResource,
    inspectionOwnershipClassification: details.ownershipClassification,
    inspectionUntrackedCandidateCount: details.untrackedCandidates.length,
    inspectionUntrackedCandidatePids:
      details.untrackedCandidates.length > 0
        ? details.untrackedCandidates.map((candidate) => candidate.pid).join(",")
        : null,
    inspectionUntrackedCandidateNames:
      details.untrackedCandidates.length > 0
        ? details.untrackedCandidates
            .map((candidate) => candidate.processName ?? "unknown")
            .join("|")
        : null,
    inspectionUntrackedCandidateConfidences:
      details.untrackedCandidates.length > 0
        ? details.untrackedCandidates.map((candidate) => candidate.confidence).join(",")
        : null,
    inspectionUntrackedCandidateKinds: serializeUntrackedCandidateKinds(details.untrackedCandidates),
    inspectionUntrackedCandidateReasons:
      details.untrackedCandidates.length > 0
        ? details.untrackedCandidates.map((candidate) => candidate.reason).join("|")
        : null,
    inspectionFoundUntrackedCandidate: details.untrackedCandidates.length > 0,
    inspectionRecommendedNextAction: details.recommendedNextAction
  };
}
