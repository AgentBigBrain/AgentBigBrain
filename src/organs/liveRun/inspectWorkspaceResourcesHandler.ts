/**
 * @fileoverview Inspects runtime-owned browser and preview resources for one workspace or local path.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  InspectPathHoldersActionParams,
  InspectWorkspaceResourcesActionParams
} from "../../core/types";
import { buildManualHolderReleaseGuidance } from "../../core/autonomy/workspaceRecoveryNarration";
import { buildLikelyNonPreviewHolderCountSummary } from "../../core/autonomy/workspaceRecoveryNarration";
import {
  isCurrentTrackedBrowserSessionSnapshot,
  isOrphanedAttributableBrowserSessionSnapshot,
  isStaleTrackedBrowserSessionSnapshot,
  type BrowserSessionSnapshot
} from "./browserSessionRegistry";
import {
  buildExecutionOutcome,
  buildRuntimeOwnershipInspectionMetadata,
  LiveRunExecutorContext,
  normalizeOptionalString
} from "./contracts";
import {
  isCurrentTrackedManagedProcessSnapshot,
  isStaleTrackedManagedProcessSnapshot,
  type ManagedProcessSnapshot
} from "./managedProcessRegistry";
import {
  collectRecoveredExactPreviewHolders,
  type RecoveredExactPreviewHolderCandidate,
} from "./inspectWorkspaceResourcesRecovery";
import {
  RuntimeInspectionRecommendedNextAction,
  UntrackedHolderCandidate
} from "./untrackedPreviewCandidateInspection";
import {
  promoteExactNonPreviewTargetPathCandidate,
  selectContextualManualCleanupLikelyNonPreviewCandidates,
  selectClarificationSafeLikelyNonPreviewCandidates,
  selectDominantExactNonPreviewTargetPathCandidate,
  selectExactNonPreviewTargetPathCandidates
} from "./untrackedPreviewCandidateRecoverySelectors";
import { type RuntimeOwnershipInspectionClassification } from "./liveRunMetadataBuilders";

interface RuntimeInspectionMatches {
  browserSessions: BrowserSessionSnapshot[];
  processSnapshots: ManagedProcessSnapshot[];
  staleBrowserSessions: BrowserSessionSnapshot[];
  staleProcessSnapshots: ManagedProcessSnapshot[];
  orphanedBrowserSessions: BrowserSessionSnapshot[];
  recoveredExactPreviewHolders: readonly RecoveredExactPreviewHolderCandidate[];
  untrackedCandidates: readonly UntrackedHolderCandidate[];
  ownershipClassification: RuntimeOwnershipInspectionClassification;
  recommendedNextAction: RuntimeInspectionRecommendedNextAction;
}

/**
 * Normalizes a filesystem path into a stable comparison form.
 *
 * @param value - Candidate filesystem path.
 * @returns Normalized path, or `null` when absent.
 */
function normalizeComparablePath(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.normalize(trimmed).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Resolves a local file URL into a comparable filesystem path.
 *
 * @param url - Candidate URL string.
 * @returns Local file path, or `null` when the URL is not a local file URL.
 */
function resolveLocalFilePathFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "file:") {
      return null;
    }
    return normalizeComparablePath(fileURLToPath(parsedUrl));
  } catch {
    return null;
  }
}

/**
 * Returns whether two filesystem targets overlap by direct equality or containment.
 *
 * @param left - First path candidate.
 * @param right - Second path candidate.
 * @returns `true` when the paths overlap.
 */
function pathsOverlap(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  const separator = path.sep;
  return (
    normalizedLeft.startsWith(`${normalizedRight}${separator}`) ||
    normalizedRight.startsWith(`${normalizedLeft}${separator}`)
  );
}

/**
 * Chooses the highest-priority ownership classification visible in the inspection results.
 *
 * @param matches - Classified runtime inspection matches.
 * @returns Primary ownership classification for this inspection.
 */
function classifyOwnership(
  matches: Pick<
    RuntimeInspectionMatches,
    | "browserSessions"
    | "processSnapshots"
    | "staleBrowserSessions"
    | "staleProcessSnapshots"
    | "orphanedBrowserSessions"
    | "recoveredExactPreviewHolders"
    | "untrackedCandidates"
  >
): RuntimeOwnershipInspectionClassification {
  if (
    matches.browserSessions.length > 0 ||
    matches.processSnapshots.length > 0 ||
    matches.recoveredExactPreviewHolders.length > 0
  ) {
    return "current_tracked";
  }
  if (matches.orphanedBrowserSessions.length > 0 || matches.untrackedCandidates.length > 0) {
    return "orphaned_attributable";
  }
  if (matches.staleBrowserSessions.length > 0 || matches.staleProcessSnapshots.length > 0) {
    return "stale_tracked";
  }
  return "unknown";
}

/**
 * Chooses the next safe action after classifying current, stale, and orphaned inspection matches.
 *
 * @param matches - Classified runtime inspection matches.
 * @returns Next safe action for downstream recovery logic.
 */
function selectRecommendedNextAction(
  matches: Pick<
    RuntimeInspectionMatches,
    | "browserSessions"
    | "processSnapshots"
    | "recoveredExactPreviewHolders"
    | "untrackedCandidates"
    | "orphanedBrowserSessions"
  >
): RuntimeInspectionRecommendedNextAction {
  const hasPreviewStyleUntrackedCandidates = matches.untrackedCandidates.some(
    (candidate) => candidate.holderKind === "preview_server"
  );
  const exactNonPreviewCandidates = selectExactNonPreviewTargetPathCandidates(
    matches.untrackedCandidates
  );
  const likelyNonPreviewCandidates = selectClarificationSafeLikelyNonPreviewCandidates(
    matches.untrackedCandidates
  );
  const dominantExactNonPreviewCandidate = selectDominantExactNonPreviewTargetPathCandidate(
    matches.untrackedCandidates
  );
  if (
    matches.browserSessions.length > 0 ||
    matches.processSnapshots.length > 0 ||
    matches.recoveredExactPreviewHolders.length > 0
  ) {
    return "stop_exact_tracked_holders";
  }
  if (
    (dominantExactNonPreviewCandidate || exactNonPreviewCandidates.length > 1) &&
    matches.orphanedBrowserSessions.length === 0
  ) {
    return "clarify_before_exact_non_preview_shutdown";
  }
  if (
    likelyNonPreviewCandidates.length > 0 &&
    matches.orphanedBrowserSessions.length === 0
  ) {
    return "clarify_before_likely_non_preview_shutdown";
  }
  if (hasPreviewStyleUntrackedCandidates) {
    return "clarify_before_untracked_shutdown";
  }
  if (matches.orphanedBrowserSessions.length > 0) {
    return "manual_orphaned_browser_cleanup";
  }
  if (matches.untrackedCandidates.length > 0) {
    return "manual_non_preview_holder_cleanup";
  }
  return "collect_more_evidence";
}

/**
 * Collects runtime-owned browser and preview resources that match one workspace or path selector.
 *
 * @param context - Shared live-run executor context.
 * @param selectors - Exact workspace/path selectors supplied by the caller.
 * @returns Matching runtime-owned browser sessions and managed preview processes.
 */
export function inspectRuntimeOwnedWorkspaceResources(
  context: LiveRunExecutorContext,
  selectors: {
    path: string | null;
    rootPath: string | null;
    previewUrl: string | null;
    browserSessionId: string | null;
    previewProcessLeaseId: string | null;
  }
): RuntimeInspectionMatches {
  const matchedBrowserSnapshots = context.browserSessionRegistry.listSnapshots().filter((snapshot) => {
    if (selectors.browserSessionId && snapshot.sessionId === selectors.browserSessionId) {
      return true;
    }
    if (
      selectors.previewProcessLeaseId &&
      snapshot.linkedProcessLeaseId === selectors.previewProcessLeaseId
    ) {
      return true;
    }
    if (selectors.previewUrl && snapshot.url === selectors.previewUrl) {
      return true;
    }
    if (pathsOverlap(snapshot.workspaceRootPath, selectors.path)) {
      return true;
    }
    if (pathsOverlap(snapshot.workspaceRootPath, selectors.rootPath)) {
      return true;
    }
    if (pathsOverlap(snapshot.linkedProcessCwd, selectors.path)) {
      return true;
    }
    if (pathsOverlap(snapshot.linkedProcessCwd, selectors.rootPath)) {
      return true;
    }
    if (pathsOverlap(resolveLocalFilePathFromUrl(snapshot.url), selectors.path)) {
      return true;
    }
    if (pathsOverlap(resolveLocalFilePathFromUrl(snapshot.url), selectors.rootPath)) {
      return true;
    }
    return false;
  });

  const matchedProcessSnapshots = context.managedProcessRegistry.listSnapshots().filter((snapshot) => {
    if (selectors.previewProcessLeaseId && snapshot.leaseId === selectors.previewProcessLeaseId) {
      return true;
    }
    if (pathsOverlap(snapshot.cwd, selectors.path)) {
      return true;
    }
    if (pathsOverlap(snapshot.cwd, selectors.rootPath)) {
      return true;
    }
    return false;
  });

  const browserSessions = matchedBrowserSnapshots.filter((snapshot) =>
    isCurrentTrackedBrowserSessionSnapshot(snapshot)
  );
  const staleBrowserSessions = matchedBrowserSnapshots.filter((snapshot) =>
    isStaleTrackedBrowserSessionSnapshot(snapshot)
  );
  const orphanedBrowserSessions = matchedBrowserSnapshots.filter((snapshot) =>
    isOrphanedAttributableBrowserSessionSnapshot(snapshot)
  );
  const processSnapshots = matchedProcessSnapshots.filter((snapshot) =>
    isCurrentTrackedManagedProcessSnapshot(snapshot)
  );
  const staleProcessSnapshots = matchedProcessSnapshots.filter((snapshot) =>
    isStaleTrackedManagedProcessSnapshot(snapshot)
  );

  return {
    browserSessions,
    processSnapshots,
    staleBrowserSessions,
    staleProcessSnapshots,
    orphanedBrowserSessions,
    recoveredExactPreviewHolders: [],
    untrackedCandidates: [],
    ownershipClassification: classifyOwnership({
      browserSessions,
      processSnapshots,
      staleBrowserSessions,
      staleProcessSnapshots,
      orphanedBrowserSessions,
      recoveredExactPreviewHolders: [],
      untrackedCandidates: []
    }),
    recommendedNextAction: selectRecommendedNextAction({
      browserSessions,
      processSnapshots,
      recoveredExactPreviewHolders: [],
      orphanedBrowserSessions,
      untrackedCandidates: []
    })
  };
}

/**
 * Normalizes related action or session ids into one comparable lineage key.
 *
 * @param value - Runtime resource id or action id.
 * @returns Comparable lineage key, or `null` when absent.
 */
/**
 * Augments exact runtime-owned inspection with bounded likely untracked preview-holder candidates.
 *
 * @param context - Shared live-run executor context.
 * @param selectors - Exact workspace/path selectors supplied by the caller.
 * @returns Tracked matches plus candidate-holder guidance and next safe action.
 */
async function inspectWorkspaceResourcesWithCandidates(
  context: LiveRunExecutorContext,
  selectors: {
    path: string | null;
    rootPath: string | null;
    previewUrl: string | null;
    browserSessionId: string | null;
    previewProcessLeaseId: string | null;
  }
): Promise<RuntimeInspectionMatches> {
  const trackedMatches = inspectRuntimeOwnedWorkspaceResources(context, selectors);
  const trackedPids = [
    ...trackedMatches.browserSessions
      .map((snapshot) => snapshot.browserProcessPid)
      .filter((pid): pid is number => typeof pid === "number"),
    ...trackedMatches.processSnapshots
      .map((snapshot) => snapshot.pid)
      .filter((pid): pid is number => typeof pid === "number")
  ];
  const recoveredExactPreviewHolders = await collectRecoveredExactPreviewHolders(
    context,
    trackedMatches.browserSessions,
    trackedMatches.processSnapshots,
    trackedMatches.staleProcessSnapshots,
    selectors
  );
  const recoveredPids = new Set(recoveredExactPreviewHolders.map((candidate) => candidate.pid));
  const untrackedCandidates = context.inspectSystemPreviewCandidates
    ? (
        await context.inspectSystemPreviewCandidates({
          targetPath: selectors.path,
          rootPath: selectors.rootPath,
          previewUrl: selectors.previewUrl,
          trackedPids
        })
      )
        .filter((candidate) => !recoveredPids.has(candidate.pid))
        .map((candidate) => promoteExactNonPreviewTargetPathCandidate(candidate))
    : [];
  return {
    ...trackedMatches,
    recoveredExactPreviewHolders,
    untrackedCandidates,
    ownershipClassification: classifyOwnership({
      ...trackedMatches,
      recoveredExactPreviewHolders,
      untrackedCandidates
    }),
    recommendedNextAction: selectRecommendedNextAction({
      browserSessions: trackedMatches.browserSessions,
      processSnapshots: trackedMatches.processSnapshots,
      recoveredExactPreviewHolders,
      orphanedBrowserSessions: trackedMatches.orphanedBrowserSessions,
      untrackedCandidates
    })
  };
}

/**
 * Renders one bounded inspection summary for user-facing recovery or proof surfaces.
 *
 * @param matches - Matching runtime-owned resources.
 * @param targetLabel - Human-readable inspection target.
 * @returns Bounded inspection summary.
 */
function summarizeInspectionMatches(
  matches: RuntimeInspectionMatches,
  targetLabel: string
): string {
  if (
    matches.browserSessions.length === 0 &&
    matches.processSnapshots.length === 0 &&
    matches.staleBrowserSessions.length === 0 &&
    matches.staleProcessSnapshots.length === 0 &&
    matches.orphanedBrowserSessions.length === 0 &&
    matches.recoveredExactPreviewHolders.length === 0 &&
    matches.untrackedCandidates.length === 0
  ) {
    return `No current, stale, or attributable runtime-owned browser or preview resources currently match ${targetLabel}. Recommended next safe action: ${matches.recommendedNextAction}.`;
  }
  const previewCandidates = matches.untrackedCandidates.filter(
    (candidate) => candidate.holderKind === "preview_server"
  );
  const nonPreviewCandidates = matches.untrackedCandidates.filter(
    (candidate) => candidate.holderKind !== "preview_server"
  );
  const browserSummary =
    matches.browserSessions.length > 0
      ? `current tracked browser sessions: ${matches.browserSessions.map((snapshot) => snapshot.sessionId).join(", ")}`
      : null;
  const processSummary =
    matches.processSnapshots.length > 0
      ? `current tracked preview processes: ${matches.processSnapshots.map((snapshot) => snapshot.leaseId).join(", ")}`
      : null;
  const staleBrowserSummary =
    matches.staleBrowserSessions.length > 0
      ? `stale tracked browser sessions: ${matches.staleBrowserSessions.map((snapshot) => snapshot.sessionId).join(", ")}`
      : null;
  const staleProcessSummary =
    matches.staleProcessSnapshots.length > 0
      ? `stale tracked preview processes: ${matches.staleProcessSnapshots.map((snapshot) => snapshot.leaseId).join(", ")}`
      : null;
  const orphanedBrowserSummary =
    matches.orphanedBrowserSessions.length > 0
      ? `orphaned attributable browser sessions: ${matches.orphanedBrowserSessions.map((snapshot) => snapshot.sessionId).join(", ")}`
      : null;
  const recoveredExactHolderSummary =
    matches.recoveredExactPreviewHolders.length > 0
      ? `recovered exact preview holders: ${matches.recoveredExactPreviewHolders
          .map(
            (candidate) =>
              `pid ${candidate.pid}` +
              (candidate.leaseId ? ` via ${candidate.leaseId}` : "") +
              (candidate.processName ? ` (${candidate.processName})` : "") +
              ` reason=${candidate.reason}`
          )
          .join(", ")}`
      : null;
  const candidateSummary =
    previewCandidates.length > 0
      ? `likely orphaned attributable preview holders: ${previewCandidates
          .map(
            (candidate) =>
              `pid ${candidate.pid}` +
              (candidate.port !== null ? ` port=${candidate.port}` : "") +
              (candidate.processName ? ` (${candidate.processName})` : "") +
              ` confidence=${candidate.confidence} kind=${candidate.holderKind} reason=${candidate.reason}`
          )
          .join(", ")}`
      : null;
  const nonPreviewCandidateSummary =
    nonPreviewCandidates.length > 0
      ? `likely non-preview local holders: ${nonPreviewCandidates
          .map(
            (candidate) =>
              `pid ${candidate.pid}` +
              (candidate.processName ? ` (${candidate.processName})` : "") +
              ` confidence=${candidate.confidence} kind=${candidate.holderKind} reason=${candidate.reason}`
          )
          .join(", ")}`
      : null;
  const exactNonPreviewCandidates = selectExactNonPreviewTargetPathCandidates(
    matches.untrackedCandidates
  );
  const likelyNonPreviewCandidates = selectClarificationSafeLikelyNonPreviewCandidates(
    nonPreviewCandidates
  );
  const contextualManualCleanupCandidates =
    selectContextualManualCleanupLikelyNonPreviewCandidates(nonPreviewCandidates);
  const dominantExactNonPreviewCandidate = selectDominantExactNonPreviewTargetPathCandidate(
    nonPreviewCandidates
  );
  const nextStepSummary =
    matches.recommendedNextAction === "manual_orphaned_browser_cleanup"
      ? "Recommended next safe action: manual_orphaned_browser_cleanup. These look like older assistant browser windows still tied to the workspace, but the runtime no longer has direct control over them."
      : matches.recommendedNextAction === "clarify_before_exact_non_preview_shutdown"
        ? `Recommended next safe action: clarify_before_exact_non_preview_shutdown. ${
            exactNonPreviewCandidates.length > 1
              ? `${exactNonPreviewCandidates.length} high-confidence exact local holders look tied to this workspace, so the next safe step is to confirm only those exact shutdowns before retrying.`
              : "One high-confidence local holder looks tied to this workspace, so the next safe step is to confirm that exact shutdown before retrying."
          }` +
          (exactNonPreviewCandidates.length > 1 && nonPreviewCandidates.length > exactNonPreviewCandidates.length
            ? " I also found weaker non-preview matches, but these exact path matches are still the strongest shutdown-safe candidates."
            : dominantExactNonPreviewCandidate && nonPreviewCandidates.length > 1
              ? " I also found weaker non-preview matches, but this exact path match is still the strongest shutdown-safe candidate."
              : "")
        : matches.recommendedNextAction === "clarify_before_likely_non_preview_shutdown"
          ? `Recommended next safe action: clarify_before_likely_non_preview_shutdown. ${
              buildLikelyNonPreviewHolderCountSummary(
                likelyNonPreviewCandidates.map((candidate) => candidate.holderKind),
                likelyNonPreviewCandidates.length
              )
            } still look tied to this workspace, so the next safe step is to confirm only that inspected holder set before retrying.`
        : matches.recommendedNextAction === "manual_non_preview_holder_cleanup"
          ? contextualManualCleanupCandidates.length > 0
            ? `Recommended next safe action: manual_non_preview_holder_cleanup. ${
                buildLikelyNonPreviewHolderCountSummary(
                  contextualManualCleanupCandidates.map((candidate) => candidate.holderKind),
                  contextualManualCleanupCandidates.length
                )
              } still look tied to this workspace, but that broader local set is outside the confirmation lane, so automatic shutdown is not safe from runtime evidence alone. ${buildManualHolderReleaseGuidance(
                contextualManualCleanupCandidates.map((candidate) => candidate.holderKind),
                contextualManualCleanupCandidates
                  .map((candidate) => candidate.processName)
                  .filter((candidate): candidate is string => typeof candidate === "string")
              )}`
            : `Recommended next safe action: manual_non_preview_holder_cleanup. These look like local editor, shell, sync, or other non-preview processes, so automatic shutdown is not safe from runtime evidence alone. ${buildManualHolderReleaseGuidance(
                nonPreviewCandidates.map((candidate) => candidate.holderKind),
                nonPreviewCandidates
                  .map((candidate) => candidate.processName)
                  .filter((candidate): candidate is string => typeof candidate === "string")
              )}`
        : `Recommended next safe action: ${matches.recommendedNextAction}.`;
  return `Inspection results for ${targetLabel}: ${[
    browserSummary,
    processSummary,
    staleBrowserSummary,
    staleProcessSummary,
    orphanedBrowserSummary,
    recoveredExactHolderSummary,
    candidateSummary,
    nonPreviewCandidateSummary
  ].filter(Boolean).join("; ")}. Primary ownership classification: ${matches.ownershipClassification}. ${nextStepSummary}`;
}

/**
 * Executes `inspect_workspace_resources` using runtime-owned browser and process registries only.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this inspection request.
 * @returns Typed executor outcome with structured inspection metadata.
 */
export async function executeInspectWorkspaceResources(
  context: LiveRunExecutorContext,
  params: InspectWorkspaceResourcesActionParams
) {
  const rootPath = normalizeOptionalString(params.rootPath) ?? normalizeOptionalString(params.path);
  const previewUrl = normalizeOptionalString(params.previewUrl);
  const browserSessionId = normalizeOptionalString(params.browserSessionId);
  const previewProcessLeaseId = normalizeOptionalString(params.previewProcessLeaseId);
  if (!rootPath && !previewUrl && !browserSessionId && !previewProcessLeaseId) {
    return buildExecutionOutcome(
      "blocked",
      "Workspace resource inspection blocked: provide params.rootPath, params.previewUrl, params.browserSessionId, or params.previewProcessLeaseId.",
      "READ_MISSING_PATH"
    );
  }

  const matches = await inspectWorkspaceResourcesWithCandidates(context, {
    path: null,
    rootPath,
    previewUrl,
    browserSessionId,
    previewProcessLeaseId
  });
  return buildExecutionOutcome(
    "success",
    summarizeInspectionMatches(
      matches,
      rootPath ?? previewUrl ?? browserSessionId ?? previewProcessLeaseId ?? "the requested workspace"
    ),
    undefined,
    buildRuntimeOwnershipInspectionMetadata({
      inspectionKind: "workspace_resources",
      targetPath: null,
      rootPath,
      previewUrl,
      recoveredExactPreviewHolderPids: matches.recoveredExactPreviewHolders.map(
        (candidate) => candidate.pid
      ),
      recoveredExactPreviewHolderLeaseIds: matches.recoveredExactPreviewHolders
        .map((candidate) => candidate.leaseId)
        .filter((leaseId): leaseId is string => typeof leaseId === "string"),
      browserSessionIds: matches.browserSessions.map((snapshot) => snapshot.sessionId),
      browserProcessPids: matches.browserSessions
        .map((snapshot) => snapshot.browserProcessPid)
        .filter((pid): pid is number => typeof pid === "number"),
      previewProcessLeaseIds: matches.processSnapshots.map((snapshot) => snapshot.leaseId),
      previewProcessPids: matches.processSnapshots
        .map((snapshot) => snapshot.pid)
        .filter((pid): pid is number => typeof pid === "number"),
      staleBrowserSessionIds: matches.staleBrowserSessions.map((snapshot) => snapshot.sessionId),
      stalePreviewProcessLeaseIds: matches.staleProcessSnapshots.map(
        (snapshot) => snapshot.leaseId
      ),
      orphanedBrowserSessionIds: matches.orphanedBrowserSessions.map(
        (snapshot) => snapshot.sessionId
      ),
      foundTrackedHolder: matches.processSnapshots.length > 0,
      foundTrackedWorkspaceResource:
        matches.processSnapshots.length > 0 || matches.browserSessions.length > 0,
      foundStaleTrackedResource:
        matches.staleProcessSnapshots.length > 0 || matches.staleBrowserSessions.length > 0,
      foundOrphanedAttributableResource:
        matches.orphanedBrowserSessions.length > 0 || matches.untrackedCandidates.length > 0,
      ownershipClassification: matches.ownershipClassification,
      untrackedCandidates: matches.untrackedCandidates,
      recommendedNextAction: matches.recommendedNextAction
    })
  );
}

/**
 * Executes `inspect_path_holders` using runtime-owned browser and process registries only.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this inspection request.
 * @returns Typed executor outcome with structured inspection metadata.
 */
export async function executeInspectPathHolders(
  context: LiveRunExecutorContext,
  params: InspectPathHoldersActionParams
) {
  const targetPath = normalizeOptionalString(params.path);
  if (!targetPath) {
    return buildExecutionOutcome(
      "blocked",
      "Path-holder inspection blocked: missing params.path.",
      "READ_MISSING_PATH"
    );
  }

  const matches = await inspectWorkspaceResourcesWithCandidates(context, {
    path: targetPath,
    rootPath: null,
    previewUrl: null,
    browserSessionId: null,
    previewProcessLeaseId: null
  });
  return buildExecutionOutcome(
    "success",
    summarizeInspectionMatches(matches, targetPath),
    undefined,
    buildRuntimeOwnershipInspectionMetadata({
      inspectionKind: "path_holders",
      targetPath,
      rootPath: null,
      previewUrl: null,
      recoveredExactPreviewHolderPids: matches.recoveredExactPreviewHolders.map(
        (candidate) => candidate.pid
      ),
      recoveredExactPreviewHolderLeaseIds: matches.recoveredExactPreviewHolders
        .map((candidate) => candidate.leaseId)
        .filter((leaseId): leaseId is string => typeof leaseId === "string"),
      browserSessionIds: matches.browserSessions.map((snapshot) => snapshot.sessionId),
      browserProcessPids: matches.browserSessions
        .map((snapshot) => snapshot.browserProcessPid)
        .filter((pid): pid is number => typeof pid === "number"),
      previewProcessLeaseIds: matches.processSnapshots.map((snapshot) => snapshot.leaseId),
      previewProcessPids: matches.processSnapshots
        .map((snapshot) => snapshot.pid)
        .filter((pid): pid is number => typeof pid === "number"),
      staleBrowserSessionIds: matches.staleBrowserSessions.map((snapshot) => snapshot.sessionId),
      stalePreviewProcessLeaseIds: matches.staleProcessSnapshots.map(
        (snapshot) => snapshot.leaseId
      ),
      orphanedBrowserSessionIds: matches.orphanedBrowserSessions.map(
        (snapshot) => snapshot.sessionId
      ),
      foundTrackedHolder: matches.processSnapshots.length > 0,
      foundTrackedWorkspaceResource:
        matches.processSnapshots.length > 0 || matches.browserSessions.length > 0,
      foundStaleTrackedResource:
        matches.staleProcessSnapshots.length > 0 || matches.staleBrowserSessions.length > 0,
      foundOrphanedAttributableResource:
        matches.orphanedBrowserSessions.length > 0 || matches.untrackedCandidates.length > 0,
      ownershipClassification: matches.ownershipClassification,
      untrackedCandidates: matches.untrackedCandidates,
      recommendedNextAction: matches.recommendedNextAction
    })
  );
}
