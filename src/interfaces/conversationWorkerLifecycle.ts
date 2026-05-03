/**
 * @fileoverview Implements deterministic worker-loop lifecycle helpers for conversation queue execution.
 */

import { assertAckInvariants } from "./ackStateMachine";
import { backfillPulseSnippet } from "./pulseEmissionLifecycle";
import { shouldSuppressPulseUserFacingDeliveryV1 } from "./pulseUxRuntime";
import { elapsedSeconds } from "./conversationManagerHelpers";
import {
  applyConversationDomainSignalWindow,
  findRecentJob,
  recordAssistantTurn,
  setActiveClarification,
  setActiveWorkspace,
  setProgressState,
  setReturnHandoff,
  upsertBrowserSession,
  upsertPathDestination,
  upsertRecentAction,
  upsertRecentJob
} from "./conversationSessionMutations";
import {
  ConversationActiveWorkspaceRecord,
  ConversationJob,
  ConversationSession
} from "./sessionStore";
import { buildConversationWorkerProgressMessage } from "./conversationRuntime/conversationWorkerProgressText";
import {
  discoverWorkspacePrimaryArtifactPath,
  discoverWorkspaceReferencePaths
} from "./conversationRuntime/workspaceArtifactDiscovery";
import { deriveConversationLedgersFromTaskRunResult } from "./conversationRuntime/recentActionLedger";
import { buildConversationReturnHandoff } from "./conversationRuntime/returnHandoff";
import { buildPausedReturnHandoffProgressState } from "./conversationRuntime/returnHandoffControl";
import { deriveTaskRecoveryClarification } from "./conversationRuntime/taskRecoveryClarification";
import { reconcileConversationExecutionRuntimeSession } from "./conversationRuntime/executionInputRuntimeOwnership";
import {
  basenameCrossPlatformPath,
  dirnameCrossPlatformPath,
  extnameCrossPlatformPath,
  localFileUrlToAbsolutePath,
  normalizeCrossPlatformPath
} from "../core/crossPlatformPath";
import type { BrowserSessionSnapshot } from "../organs/liveRun/browserSessionRegistry";
import type { ManagedProcessSnapshot } from "../organs/liveRun/managedProcessRegistry";
import type { TaskRunResult } from "../core/types";
import type {
  ConversationOutboundDeliveryTrace,
  ConversationExecutionProgressUpdate,
  ConversationExecutionResult,
  ConversationNotifierTransport,
  ExecuteConversationTask
} from "./conversationRuntime/managerContracts";

export type {
  ConversationDeliveryResult,
  ConversationExecutionResult,
  ConversationNotifierCapabilities,
  ConversationNotifierTransport,
  ExecuteConversationTask
} from "./conversationRuntime/managerContracts";

const WORKFLOW_CONTINUITY_MODES = new Set([
  "plan",
  "build",
  "static_html_build",
  "framework_app_build",
  "autonomous",
  "review"
] as const);

/**
 * Narrows conversation modes down to the subset that should count as workflow continuity.
 *
 * @param mode - Candidate continuity mode persisted on the session.
 * @returns `true` when the mode should reinforce workflow-domain continuity.
 */
function isWorkflowContinuityMode(
  mode: NonNullable<ConversationSession["modeContinuity"]>["activeMode"] | null | undefined
): mode is "plan" | "build" | "static_html_build" | "framework_app_build" | "autonomous" | "review" {
  return (
    mode === "plan" ||
    mode === "build" ||
    mode === "static_html_build" ||
    mode === "framework_app_build" ||
    mode === "autonomous" ||
    mode === "review"
  );
}

/**
 * Evaluates notifier native-streaming support and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Worker heartbeat delivery chooses between persistent messages and Telegram draft streaming based on
 * this capability check to avoid duplicate transport branching logic.
 *
 * **What it talks to:**
 * - Reads notifier capabilities and optional `stream` transport method.
 *
 * @param notify - Transport used by the worker loop for progress delivery.
 * @returns `true` when native streaming is supported and callable.
 */
function canUseNativeStreaming(
  notify: ConversationNotifierTransport
): boolean {
  return notify.capabilities.supportsNativeStreaming && typeof notify.stream === "function";
}

/**
 * Syncs worker-owned continuity state back into the shared domain context after lifecycle mutations.
 *
 * @param session - Conversation session whose continuity signals should be aligned.
 * @param observedAt - Timestamp to stamp onto the bounded domain update.
 */
function syncConversationDomainContinuityFromLifecycle(
  session: ConversationSession,
  observedAt: string
): void {
  const continuitySignals = {
    activeWorkspace: session.activeWorkspace !== null,
    returnHandoff: session.returnHandoff !== null,
    modeContinuity: session.modeContinuity !== null
  };
  const workflowContinuityActive =
    continuitySignals.activeWorkspace ||
    continuitySignals.returnHandoff ||
    (
      session.modeContinuity !== null &&
      isWorkflowContinuityMode(session.modeContinuity.activeMode) &&
      WORKFLOW_CONTINUITY_MODES.has(session.modeContinuity.activeMode)
    );

  applyConversationDomainSignalWindow(session, {
    observedAt,
    laneSignals: workflowContinuityActive
      ? [
          {
            lane: "workflow",
            observedAt,
            source: "continuity_state",
            weight: 1
          }
        ]
      : [],
    continuitySignals
  });
}

/**
 * Collects the newest concrete changed paths emitted by one completed job.
 *
 * @param session - Session containing recent-action ledgers.
 * @param sourceJobId - Job whose concrete side effects should be preferred.
 * @returns Ordered changed file/folder paths for continuity recall.
 */
function collectWorkspaceChangedPaths(
  session: ConversationSession,
  sourceJobId: string
): string[] {
  const seen = new Set<string>();
  const changedPaths: string[] = [];
  for (const action of session.recentActions) {
    if (action.sourceJobId !== sourceJobId || !action.location) {
      continue;
    }
    if (action.kind !== "file" && action.kind !== "folder") {
      continue;
    }
    if (seen.has(action.location)) {
      continue;
    }
    seen.add(action.location);
    changedPaths.push(action.location);
  }
  return changedPaths;
}

/**
 * Recovers the newest concrete file/folder evidence already attributed to one workspace root.
 *
 * @param session - Session containing recent-action and path-destination ledgers.
 * @param rootPath - Workspace root whose remembered evidence should be gathered.
 * @param limit - Maximum number of remembered paths to return.
 * @returns Ordered file/folder paths attributable to the same workspace root.
 */
function collectRememberedWorkspacePaths(
  session: ConversationSession,
  rootPath: string | null,
  limit: number
): string[] {
  const comparableRootPath = toComparablePath(rootPath);
  if (!comparableRootPath) {
    return [];
  }

  const rememberedPaths: string[] = [];
  const seen = new Set<string>();
  const pushPath = (candidatePath: string | null | undefined): void => {
    if (!candidatePath || seen.has(candidatePath)) {
      return;
    }
    if (!isSameOrNestedComparablePath(toComparablePath(candidatePath), comparableRootPath)) {
      return;
    }
    seen.add(candidatePath);
    rememberedPaths.push(candidatePath);
  };

  for (const action of session.recentActions) {
    if (action.kind !== "file" && action.kind !== "folder") {
      continue;
    }
    pushPath(action.location);
    if (rememberedPaths.length >= limit) {
      return rememberedPaths;
    }
  }

  for (const destination of session.pathDestinations) {
    pushPath(destination.resolvedPath);
    if (rememberedPaths.length >= limit) {
      break;
    }
  }

  const nestedPaths = rememberedPaths.filter(
    (candidatePath) => toComparablePath(candidatePath) !== comparableRootPath
  );
  if (nestedPaths.length > 0) {
    return nestedPaths.slice(0, limit);
  }
  return rememberedPaths.slice(0, limit);
}

/**
 * Resolves file-level workspace references by combining remembered ledgers with safe framework
 * entrypoint discovery under the exact resolved root.
 *
 * @param session - Session containing remembered workspace ledgers.
 * @param rootPath - Resolved workspace root.
 * @param limit - Maximum number of paths to return.
 * @returns Ordered file paths attributable to the workspace.
 */
function resolveWorkspaceReferencePaths(
  session: ConversationSession,
  rootPath: string | null,
  limit: number
): string[] {
  const rememberedWorkspacePaths = collectRememberedWorkspacePaths(session, rootPath, limit);
  const rememberedFilePaths = rememberedWorkspacePaths.filter(
    (candidatePath) => extnameCrossPlatformPath(candidatePath).length > 0
  );
  if (rememberedFilePaths.length >= limit) {
    return rememberedFilePaths.slice(0, limit);
  }

  const discoveredPaths = discoverWorkspaceReferencePaths(rootPath, limit);
  return uniqueNonEmpty([
    ...rememberedFilePaths,
    ...discoveredPaths
  ]).slice(0, limit);
}

/**
 * Deduplicates non-empty strings while preserving first-seen order.
 *
 * @param values - Candidate string values.
 * @returns Unique non-empty strings.
 */
function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

const PROJECT_SOURCE_DIRECTORY_NAMES = new Set([
  "src",
  "app",
  "pages",
  "components",
  "styles",
  "public"
]);
const GENERIC_WORKSPACE_CONTAINER_NAMES = new Set([
  "desktop",
  "documents",
  "downloads",
  "onedrive",
  "pictures",
  "videos",
  "music"
]);

/**
 * Normalizes one local path into a case-insensitive comparable identity.
 *
 * @param candidatePath - Raw local path candidate.
 * @returns Comparable normalized path, or `null` when the input is blank.
 */
function toComparablePath(candidatePath: string | null | undefined): string | null {
  if (!candidatePath) {
    return null;
  }
  const normalized = normalizeCrossPlatformPath(candidatePath);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\\/g, "/").toLowerCase();
}

/**
 * Returns whether one comparable path is the same as or nested below another.
 *
 * @param candidatePath - Candidate child or same path.
 * @param rootPath - Candidate parent path.
 * @returns `true` when the candidate path is the same as or nested below the root.
 */
function isSameOrNestedComparablePath(
  candidatePath: string | null,
  rootPath: string | null
): boolean {
  if (!candidatePath || !rootPath) {
    return false;
  }
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

/**
 * Collapses common source subdirectories like `src/` back to the project root.
 *
 * @param candidateRoot - Candidate workspace root.
 * @returns Collapsed project root when a well-known source directory is detected.
 */
function collapseProjectSourceRoot(candidateRoot: string): string {
  const basename = basenameCrossPlatformPath(candidateRoot).toLowerCase();
  if (!PROJECT_SOURCE_DIRECTORY_NAMES.has(basename)) {
    return candidateRoot;
  }
  const parent = dirnameCrossPlatformPath(candidateRoot);
  return parent || candidateRoot;
}

/**
 * Finds the deepest shared ancestor directory across a set of local paths.
 *
 * @param candidatePaths - File or folder paths belonging to the same workspace.
 * @returns Shared ancestor directory, or `null` when none exists.
 */
function findCommonAncestorPath(candidatePaths: readonly string[]): string | null {
  const normalizedPaths = candidatePaths
    .map((entry) => normalizeCrossPlatformPath(entry))
    .filter((entry) => entry.length > 0);
  if (normalizedPaths.length === 0) {
    return null;
  }
  let candidate = normalizedPaths[0]!;
  while (candidate.length > 0) {
    const comparableCandidate = toComparablePath(candidate);
    if (
      normalizedPaths.every((entry) => isSameOrNestedComparablePath(toComparablePath(entry), comparableCandidate))
    ) {
      return candidate;
    }
    const parent = dirnameCrossPlatformPath(candidate);
    if (!parent || parent === candidate) {
      break;
    }
    candidate = parent;
  }
  return null;
}

/**
 * Derives the strongest project-root candidate from one job's changed files or artifact path.
 *
 * @param changedPaths - Concrete changed paths emitted by the completed job.
 * @param primaryArtifactPath - Preferred primary artifact path for the completed job.
 * @returns Current-job project root candidate, or `null` when no path evidence exists.
 */
function deriveCurrentJobWorkspaceRootFromPaths(
  changedPaths: readonly string[],
  primaryArtifactPath: string | null
): string | null {
  const locationDirectories = uniqueNonEmpty([
    ...changedPaths.map((entry) =>
      extnameCrossPlatformPath(entry).length > 0
        ? dirnameCrossPlatformPath(entry)
        : entry
    ),
    primaryArtifactPath
      ? extnameCrossPlatformPath(primaryArtifactPath).length > 0
        ? dirnameCrossPlatformPath(primaryArtifactPath)
        : primaryArtifactPath
      : null
  ]);
  const commonAncestor = findCommonAncestorPath(locationDirectories);
  if (!commonAncestor) {
    return null;
  }
  return collapseProjectSourceRoot(commonAncestor);
}

/**
 * Browsers session matches current job workspace.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
 * @param browserSession - Input consumed by this helper.
 * @param derivedCurrentJobRootPath - Input consumed by this helper.
 * @param primaryArtifactPath - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function browserSessionMatchesCurrentJobWorkspace(
  browserSession: ConversationSession["browserSessions"][number] | null,
  derivedCurrentJobRootPath: string | null,
  primaryArtifactPath: string | null
): boolean {
  if (!browserSession) {
    return false;
  }
  const comparableBrowserRoots = [
    browserSession.workspaceRootPath,
    browserSession.linkedProcessCwd
  ]
    .map((value) => toComparablePath(value))
    .filter((value): value is string => value !== null);
  if (comparableBrowserRoots.length === 0) {
    return false;
  }
  const comparableDerivedRoot = toComparablePath(derivedCurrentJobRootPath);
  if (
    comparableDerivedRoot &&
    comparableBrowserRoots.some((candidatePath) => candidatePath === comparableDerivedRoot)
  ) {
    return true;
  }
  const comparablePrimaryArtifactPath = toComparablePath(primaryArtifactPath);
  if (!comparablePrimaryArtifactPath) {
    return false;
  }
  return comparableBrowserRoots.some((candidateRoot) =>
    isSameOrNestedComparablePath(comparablePrimaryArtifactPath, candidateRoot)
  );
}

/**
 * Returns whether a remembered workspace root is specific enough to anchor continuity matching.
 *
 * @param workspace - Previously tracked workspace.
 * @returns `true` when the remembered root is project-specific rather than a generic container.
 */
function hasReliableWorkspaceRoot(
  workspace: ConversationActiveWorkspaceRecord
): boolean {
  if (!workspace.rootPath) {
    return false;
  }
  const basename = basenameCrossPlatformPath(workspace.rootPath).toLowerCase();
  if (!GENERIC_WORKSPACE_CONTAINER_NAMES.has(basename)) {
    return true;
  }
  return workspace.lastChangedPaths.some((entry) => {
    const parent = dirnameCrossPlatformPath(entry);
    return parent.length > 0 && normalizeCrossPlatformPath(parent) !== normalizeCrossPlatformPath(workspace.rootPath ?? "");
  });
}

/**
 * Returns whether the current job still belongs to the previously tracked workspace.
 *
 * @param previousWorkspace - Previously tracked workspace continuity snapshot.
 * @param changedPaths - Concrete changed paths emitted by the current job.
 * @param currentRootPath - Current-job workspace root candidate.
 * @param currentPrimaryArtifactPath - Current-job primary artifact path.
 * @param currentJobBrowserSession - Browser session opened by the current job when present.
 * @returns `true` when it is safe to reuse the previous workspace's preview continuity.
 */
function shouldReusePreviousWorkspaceContinuity(
  previousWorkspace: ConversationActiveWorkspaceRecord | null,
  changedPaths: readonly string[],
  currentRootPath: string | null,
  currentPrimaryArtifactPath: string | null,
  currentJobBrowserSession: ConversationSession["browserSessions"][number] | null
): boolean {
  if (!previousWorkspace) {
    return false;
  }
  if (
    currentJobBrowserSession?.id &&
    previousWorkspace.browserSessionIds.includes(currentJobBrowserSession.id)
  ) {
    return true;
  }

  const currentEvidencePaths = uniqueNonEmpty([
    currentPrimaryArtifactPath,
    ...changedPaths
  ]).map((entry) => toComparablePath(entry)).filter((entry): entry is string => entry !== null);
  if (currentEvidencePaths.length === 0 && !currentRootPath) {
    return true;
  }

  const previousStrongPaths = uniqueNonEmpty([
    previousWorkspace.primaryArtifactPath,
    ...previousWorkspace.lastChangedPaths,
    localFileUrlToAbsolutePath(previousWorkspace.previewUrl ?? "")
  ]).map((entry) => toComparablePath(entry)).filter((entry): entry is string => entry !== null);
  if (
    currentEvidencePaths.some((entry) => previousStrongPaths.includes(entry))
  ) {
    return true;
  }

  if (!hasReliableWorkspaceRoot(previousWorkspace)) {
    return false;
  }

  const comparablePreviousRoot = toComparablePath(previousWorkspace.rootPath);
  const comparableCurrentRoot = toComparablePath(currentRootPath);
  if (
    comparableCurrentRoot &&
    comparableCurrentRoot === comparablePreviousRoot
  ) {
    return true;
  }
  return currentEvidencePaths.some((entry) =>
    isSameOrNestedComparablePath(entry, comparablePreviousRoot)
  );
}

/**
 * Extracts one managed preview-process lease id from a recent-action identifier when present.
 *
 * @param actionId - Stable recent-action identifier.
 * @returns Lease id suffix, or `null` when the action is not a managed-process ledger entry.
 */
function extractProcessLeaseIdFromRecentActionId(actionId: string): string | null {
  const marker = ":process:";
  const markerIndex = actionId.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  return actionId.slice(markerIndex + marker.length).trim() || null;
}

/**
 * Collects managed preview-process lease ids emitted by the current job for the tracked workspace.
 *
 * @param session - Session containing recent-action ledgers.
 * @param sourceJobId - Job whose process ledgers should be considered.
 * @param rootPath - Current workspace root candidate.
 * @returns Exact process lease ids attributable to the current workspace run.
 */
function collectCurrentJobPreviewProcessLeaseIds(
  session: ConversationSession,
  sourceJobId: string,
  rootPath: string | null
): string[] {
  const comparableRootPath = toComparablePath(rootPath);
  return uniqueNonEmpty(
    session.recentActions
      .filter(
        (action) =>
          action.sourceJobId === sourceJobId &&
          action.kind === "process" &&
          action.status !== "closed" &&
          action.status !== "failed"
      )
      .filter((action) => {
        if (!comparableRootPath) {
          return true;
        }
        return isSameOrNestedComparablePath(toComparablePath(action.location), comparableRootPath);
      })
      .map((action) => extractProcessLeaseIdFromRecentActionId(action.id))
  );
}

/**
 * Resolves the newest persisted recent-action status for one managed preview-process lease.
 *
 * @param session - Session containing recent-action ledgers.
 * @param leaseId - Preview-process lease identifier being evaluated.
 * @returns Most recent persisted status for that lease, or `null` when the session never recorded it.
 */
function resolveLatestProcessActionStatusForLease(
  session: ConversationSession,
  leaseId: string
): ConversationSession["recentActions"][number]["status"] | null {
  const matchingAction = session.recentActions
    .filter((action) => action.kind === "process")
    .find((action) => extractProcessLeaseIdFromRecentActionId(action.id) === leaseId);
  return matchingAction?.status ?? null;
}

/**
 * Filters preview-process lease ids down to those the session still has live control evidence for.
 *
 * @param session - Session containing recent-action ledgers.
 * @param leaseIds - Candidate preview-process lease ids remembered for the workspace.
 * @param currentTrackedBrowserSession - Current controllable browser session tied to the workspace.
 * @returns Lease ids that still look live from session evidence.
 */
function selectLivePreviewProcessLeaseIds(
  session: ConversationSession,
  leaseIds: readonly string[],
  currentTrackedBrowserSession: ConversationSession["browserSessions"][number] | null
): string[] {
  return leaseIds.filter((leaseId) => {
    const latestStatus = resolveLatestProcessActionStatusForLease(session, leaseId);
    if (latestStatus === "running") {
      return true;
    }
    if (latestStatus === "closed" || latestStatus === "failed") {
      return false;
    }
    return (
      currentTrackedBrowserSession?.status === "open" &&
      currentTrackedBrowserSession.controlAvailable &&
      currentTrackedBrowserSession.linkedProcessLeaseId === leaseId
    );
  });
}

/**
 * Selects the strongest primary artifact path for the tracked workspace.
 *
 * @param changedPaths - Concrete changed paths emitted by the completed job.
 * @param previousWorkspace - Previously tracked workspace snapshot when continuity already exists.
 * @returns Preferred primary artifact path, or `null` when none is known.
 */
function selectPrimaryArtifactPathFromPaths(
  candidatePaths: readonly string[]
): string | null {
  const htmlPath = candidatePaths.find((entry) => entry.toLowerCase().endsWith(".html"));
  if (htmlPath) {
    return htmlPath;
  }
  const filePath = candidatePaths.find((entry) => extnameCrossPlatformPath(entry).length > 0);
  if (filePath) {
    return filePath;
  }
  return null;
}

/**
 * Selects the strongest primary artifact path for the tracked workspace.
 *
 * @param session - Session containing remembered workspace ledgers.
 * @param changedPaths - Concrete changed paths emitted by the completed job.
 * @param rootPath - Resolved workspace root for the current job.
 * @param previousWorkspace - Previously tracked workspace snapshot when continuity already exists.
 * @returns Preferred primary artifact path, or `null` when none is known for this workspace.
 */
function selectPrimaryArtifactPath(
  session: ConversationSession,
  changedPaths: readonly string[],
  rootPath: string | null,
  previousWorkspace: ConversationActiveWorkspaceRecord | null
): string | null {
  const currentJobArtifactPath = selectPrimaryArtifactPathFromPaths(changedPaths);
  if (currentJobArtifactPath) {
    return currentJobArtifactPath;
  }

  const comparableRootPath = toComparablePath(rootPath);
  if (
    previousWorkspace?.primaryArtifactPath &&
    isSameOrNestedComparablePath(
      toComparablePath(previousWorkspace.primaryArtifactPath),
      comparableRootPath
    )
  ) {
    return previousWorkspace.primaryArtifactPath;
  }

  const rememberedWorkspacePaths = collectRememberedWorkspacePaths(
    session,
    rootPath,
    5
  );
  const rememberedArtifactPath = selectPrimaryArtifactPathFromPaths(rememberedWorkspacePaths);
  if (rememberedArtifactPath) {
    return rememberedArtifactPath;
  }

  return discoverWorkspacePrimaryArtifactPath(rootPath);
}

/**
 * Resolves the workspace root path from the latest ledgers and prior continuity.
 *
 * @param session - Session containing persisted path and browser ledgers.
 * @param sourceJobId - Job currently being persisted.
 * @param browserSession - Preferred browser session for this workspace.
 * @param primaryArtifactPath - Preferred primary artifact path.
 * @param previousWorkspace - Previously tracked workspace snapshot when continuity already exists.
 * @returns Best-known workspace root path, or `null` when no stable project root is evident.
 */
function resolveWorkspaceRootPath(
  session: ConversationSession,
  sourceJobId: string,
  changedPaths: readonly string[],
  currentJobBrowserSession: ConversationSession["browserSessions"][number] | null,
  continuityBrowserSession: ConversationSession["browserSessions"][number] | null,
  primaryArtifactPath: string | null,
  previousWorkspace: ConversationActiveWorkspaceRecord | null
): string | null {
  const derivedCurrentJobRootPath = deriveCurrentJobWorkspaceRootFromPaths(
    changedPaths,
    primaryArtifactPath
  );
  const processDestination =
    session.pathDestinations.find(
      (destination) =>
        destination.sourceJobId === sourceJobId &&
        destination.id.startsWith("path:process:")
    ) ?? null;
  if (processDestination) {
    return processDestination.resolvedPath;
  }
  const folderDestination =
    session.pathDestinations.find(
      (destination) =>
        destination.sourceJobId === sourceJobId &&
        extnameCrossPlatformPath(destination.resolvedPath).length === 0
    ) ?? null;
  if (folderDestination) {
    return folderDestination.resolvedPath;
  }
  if (
    currentJobBrowserSession?.workspaceRootPath &&
    browserSessionMatchesCurrentJobWorkspace(
      currentJobBrowserSession,
      derivedCurrentJobRootPath,
      primaryArtifactPath
    )
  ) {
    return currentJobBrowserSession.workspaceRootPath;
  }
  if (
    currentJobBrowserSession?.linkedProcessCwd &&
    browserSessionMatchesCurrentJobWorkspace(
      currentJobBrowserSession,
      derivedCurrentJobRootPath,
      primaryArtifactPath
    )
  ) {
    return currentJobBrowserSession.linkedProcessCwd;
  }
  if (derivedCurrentJobRootPath) {
    return derivedCurrentJobRootPath;
  }
  if (continuityBrowserSession?.workspaceRootPath) {
    return continuityBrowserSession.workspaceRootPath;
  }
  if (continuityBrowserSession?.linkedProcessCwd) {
    return continuityBrowserSession.linkedProcessCwd;
  }
  if (primaryArtifactPath) {
    return dirnameCrossPlatformPath(primaryArtifactPath);
  }
  return previousWorkspace?.rootPath ?? null;
}

/**
 * Rebuilds the canonical active-workspace snapshot from the latest persisted ledgers.
 *
 * @param session - Session containing up-to-date ledgers for the completed job.
 * @param sourceJobId - Completed job currently being persisted.
 * @param updatedAt - Timestamp used for freshness ordering.
 * @returns Canonical active workspace snapshot, or `null` when this job produced no project continuity.
 */
function deriveActiveWorkspaceFromSession(
  session: ConversationSession,
  sourceJobId: string,
  updatedAt: string
): ConversationActiveWorkspaceRecord | null {
  const previousWorkspace = session.activeWorkspace ?? null;
  const currentJobBrowserSessions = session.browserSessions.filter(
    (browserSession) => browserSession.sourceJobId === sourceJobId
  );
  const currentJobBrowserSession = currentJobBrowserSessions[0] ?? null;
  const changedPaths = collectWorkspaceChangedPaths(session, sourceJobId);
  const currentJobPrimaryArtifactPath = selectPrimaryArtifactPathFromPaths(changedPaths);
  const currentJobRootPath = resolveWorkspaceRootPath(
    session,
    sourceJobId,
    changedPaths,
    currentJobBrowserSession,
    null,
    currentJobPrimaryArtifactPath,
    null
  );
  const reusePreviousContinuity = shouldReusePreviousWorkspaceContinuity(
    previousWorkspace,
    changedPaths,
    currentJobRootPath,
    currentJobPrimaryArtifactPath,
    currentJobBrowserSession
  );
  const continuityBrowserSession =
    currentJobBrowserSession ??
    (reusePreviousContinuity && previousWorkspace?.browserSessionId
      ? session.browserSessions.find(
          (browserSession) => browserSession.id === previousWorkspace.browserSessionId
        ) ?? null
      : null);
  const rootPath = resolveWorkspaceRootPath(
    session,
    sourceJobId,
    changedPaths,
    currentJobBrowserSession,
    continuityBrowserSession,
    currentJobPrimaryArtifactPath,
    reusePreviousContinuity ? previousWorkspace : null
  );
  const primaryArtifactPath = selectPrimaryArtifactPath(
    session,
    changedPaths,
    rootPath,
    reusePreviousContinuity ? previousWorkspace : null
  );
  const rememberedWorkspacePaths = resolveWorkspaceReferencePaths(
    session,
    rootPath,
    5
  );
  const previewUrlCandidate =
    currentJobBrowserSession?.url ??
    session.recentActions.find(
      (action) =>
        action.sourceJobId === sourceJobId &&
        action.kind === "url" &&
        typeof action.location === "string"
    )?.location ??
    (reusePreviousContinuity ? previousWorkspace?.previewUrl ?? null : null) ??
    null;
  const currentJobPreviewProcessLeaseIds = collectCurrentJobPreviewProcessLeaseIds(
    session,
    sourceJobId,
    rootPath
  );
  const previewProcessLeaseIds = uniqueNonEmpty([
    continuityBrowserSession?.linkedProcessLeaseId ?? null,
    ...currentJobPreviewProcessLeaseIds,
    ...(reusePreviousContinuity
      ? [
          previousWorkspace?.previewProcessLeaseId ?? null,
          ...(previousWorkspace?.previewProcessLeaseIds ?? [])
        ]
      : []),
    ...currentJobBrowserSessions.map((browserSession) => browserSession.linkedProcessLeaseId)
  ]);
  const browserSessionIds = uniqueNonEmpty([
    continuityBrowserSession?.id ?? null,
    ...(reusePreviousContinuity
      ? [
          previousWorkspace?.browserSessionId ?? null,
          ...(previousWorkspace?.browserSessionIds ?? [])
        ]
      : []),
    ...currentJobBrowserSessions.map((browserSession) => browserSession.id)
  ]);
  const currentTrackedBrowserSession =
    continuityBrowserSession?.status === "open" &&
    continuityBrowserSession.controlAvailable
      ? continuityBrowserSession
      : null;
  const livePreviewProcessLeaseIds = selectLivePreviewProcessLeaseIds(
    session,
    previewProcessLeaseIds,
    currentTrackedBrowserSession
  );
  const lastKnownPreviewProcessPid =
    continuityBrowserSession?.linkedProcessPid ??
    (reusePreviousContinuity ? previousWorkspace?.lastKnownPreviewProcessPid ?? null : null) ??
    null;
  const browserProcessPid =
    continuityBrowserSession?.browserProcessPid ??
    (reusePreviousContinuity ? previousWorkspace?.browserProcessPid ?? null : null) ??
    null;
  const previewProcessCwd =
    continuityBrowserSession?.workspaceRootPath ??
    continuityBrowserSession?.linkedProcessCwd ??
    (reusePreviousContinuity ? previousWorkspace?.previewProcessCwd ?? null : null) ??
    rootPath;
  const hasOpenBrowserSession = currentTrackedBrowserSession !== null;
  const hasPreviewProcess = livePreviewProcessLeaseIds.length > 0;
  const hasOpenAttributableBrowserSession = continuityBrowserSession?.status === "open";
  const previewStackState =
    hasOpenBrowserSession && hasPreviewProcess
      ? "browser_and_preview"
      : hasOpenBrowserSession
        ? "browser_only"
        : hasPreviewProcess
          ? "preview_only"
          : "detached";
  const stillControllable =
    hasOpenBrowserSession ||
    hasPreviewProcess;
  const ownershipState =
    stillControllable
      ? "tracked"
      : hasOpenAttributableBrowserSession
        ? "orphaned"
        : "stale";
  const primaryPreviewProcessLeaseId =
    livePreviewProcessLeaseIds[0] ??
    previewProcessLeaseIds[0] ??
    null;
  const previewUrl =
    hasOpenAttributableBrowserSession || hasPreviewProcess
      ? previewUrlCandidate
      : null;

  if (
    !rootPath &&
    !primaryArtifactPath &&
    !previewUrl &&
    !continuityBrowserSession &&
    !previousWorkspace
  ) {
    return null;
  }

  return {
    id:
      (reusePreviousContinuity ? previousWorkspace?.id ?? null : null) ??
      `workspace:${rootPath ?? primaryArtifactPath ?? previewUrl ?? sourceJobId}`,
    label: "Current project workspace",
    rootPath,
    primaryArtifactPath,
    previewUrl,
    browserSessionId:
      continuityBrowserSession?.id ??
      (reusePreviousContinuity ? previousWorkspace?.browserSessionId ?? null : null),
    browserSessionIds,
    browserSessionStatus:
      continuityBrowserSession?.status ??
      (reusePreviousContinuity ? previousWorkspace?.browserSessionStatus ?? null : null) ??
      null,
    browserProcessPid,
    previewProcessLeaseId: primaryPreviewProcessLeaseId,
    previewProcessLeaseIds,
    previewProcessCwd,
    lastKnownPreviewProcessPid,
    stillControllable,
    ownershipState,
    previewStackState,
    lastChangedPaths:
      changedPaths.length > 0
        ? changedPaths.slice(0, 5)
        : rememberedWorkspacePaths,
    sourceJobId,
    updatedAt
  };
}

/**
 * Returns whether the persisted close-preview summary should be promoted from a blocked follow-up
 * into a truthful closed-preview success message after live runtime reconciliation.
 */
function shouldPromoteClosedPreviewStackSummary(
  session: ConversationSession,
  summary: string | null,
  userInput: string,
  taskRunResult: TaskRunResult | null
): boolean {
  if (!summary || !/BROWSER_SESSION_CONTROL_UNAVAILABLE|One later step was blocked/i.test(summary)) {
    return false;
  }
  const activeWorkspace = session.activeWorkspace;
  if (!activeWorkspace) {
    return false;
  }
  if (
    activeWorkspace.browserSessionStatus !== "closed" ||
    activeWorkspace.ownershipState !== "stale" ||
    activeWorkspace.previewStackState !== "detached"
  ) {
    return false;
  }
  if (inputReferencesDifferentExplicitBrowserUrl(userInput, session)) {
    return false;
  }
  if (taskRunResult && !didRunAttemptTrackedPreviewShutdown(taskRunResult, activeWorkspace)) {
    return false;
  }
  if (!taskRunResult && !requestLooksLikeTrackedPreviewClose(userInput)) {
    return false;
  }
  return session.browserSessions.some(
    (browserSession) =>
      activeWorkspace.browserSessionIds.includes(browserSession.id) &&
      browserSession.status === "closed"
  );
}

const PROMOTION_EXPLICIT_URL_REFERENCE_PATTERN =
  /\b(?:https?:\/\/|file:\/\/\/)[^\s<>"')\]]+/gi;
const PROMOTION_BROWSER_CLOSE_REQUEST_PATTERN =
  /\b(?:close|shut|dismiss|hide)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;

/**
 * Normalizes browser-target URLs so persisted-summary reconciliation can detect foreign explicit URLs.
 *
 * @param rawUrl - Raw URL from the user request or tracked runtime state.
 * @returns Comparable normalized URL, or `null` when unsupported.
 */
function normalizeComparablePromotionBrowserUrl(
  rawUrl: string | null | undefined
): string | null {
  if (typeof rawUrl !== "string") {
    return null;
  }
  const trimmed = rawUrl.trim().replace(/[),.;!?]+$/g, "");
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const normalizedPath =
        parsed.pathname && parsed.pathname !== "/"
          ? parsed.pathname.replace(/\/+$/g, "")
          : "/";
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${normalizedPath}${parsed.search}`;
    }
    if (parsed.protocol === "file:") {
      return `${parsed.protocol}//${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Returns whether the current request names an explicit browser URL that does not match the tracked preview.
 *
 * @param userInput - Current executed job wording.
 * @param session - Current conversation session.
 * @returns `true` when summary promotion should not override a foreign explicit URL request.
 */
function inputReferencesDifferentExplicitBrowserUrl(
  userInput: string,
  session: ConversationSession
): boolean {
  const explicitUrls = (userInput.match(PROMOTION_EXPLICIT_URL_REFERENCE_PATTERN) ?? [])
    .map((match) => normalizeComparablePromotionBrowserUrl(match))
    .filter((match): match is string => typeof match === "string" && match.length > 0);
  if (explicitUrls.length === 0) {
    return false;
  }
  const trackedUrls = new Set<string>();
  const activePreviewUrl = normalizeComparablePromotionBrowserUrl(session.activeWorkspace?.previewUrl);
  if (activePreviewUrl) {
    trackedUrls.add(activePreviewUrl);
  }
  for (const browserSession of session.browserSessions) {
    const normalizedUrl = normalizeComparablePromotionBrowserUrl(browserSession.url);
    if (normalizedUrl) {
      trackedUrls.add(normalizedUrl);
    }
  }
  return explicitUrls.some((url) => !trackedUrls.has(url));
}

/**
 * Returns whether the current request still reads like a tracked-preview close follow-up.
 *
 * @param userInput - Current executed job wording.
 * @returns `true` when blocked close-preview copy can be promoted safely.
 */
function requestLooksLikeTrackedPreviewClose(userInput: string): boolean {
  return PROMOTION_BROWSER_CLOSE_REQUEST_PATTERN.test(userInput);
}

/**
 * Returns whether the current run actually targeted the tracked preview stack.
 *
 * @param taskRunResult - Completed governed run for the current job.
 * @param activeWorkspace - Reconciled tracked workspace after the run.
 * @returns `true` when close/stop actions hit the tracked browser or preview lease ids.
 */
function didRunAttemptTrackedPreviewShutdown(
  taskRunResult: TaskRunResult,
  activeWorkspace: ConversationActiveWorkspaceRecord
): boolean {
  const trackedBrowserSessionIds = new Set(
    activeWorkspace.browserSessionIds.filter((sessionId) => sessionId.trim().length > 0)
  );
  const trackedPreviewLeaseIds = new Set(
    activeWorkspace.previewProcessLeaseIds.filter((leaseId) => leaseId.trim().length > 0)
  );
  return taskRunResult.actionResults.some((result) => {
    if (!result.approved) {
      return false;
    }
    if (
      result.action.type === "close_browser" &&
      typeof result.action.params?.sessionId === "string"
    ) {
      return trackedBrowserSessionIds.has(result.action.params.sessionId);
    }
    if (
      result.action.type === "stop_process" &&
      typeof result.action.params?.leaseId === "string"
    ) {
      return trackedPreviewLeaseIds.has(result.action.params.leaseId);
    }
    return false;
  });
}

/**
 * Builds a truthful completion summary when the linked preview stack ended up fully closed even
 * though an intermediate browser-control step reported unavailable.
 */
function buildClosedPreviewStackSummary(session: ConversationSession): string {
  const activeWorkspace = session.activeWorkspace;
  const previewTarget =
    activeWorkspace?.previewUrl ??
    activeWorkspace?.primaryArtifactPath ??
    activeWorkspace?.rootPath ??
    "that landing page";
  return `I shut down the tracked local preview stack and closed the linked browser window for ${previewTarget}, so that project page is no longer left open.`;
}

export interface MarkQueuedJobRunningInput {
  session: ConversationSession;
  job: ConversationJob;
  ackDelayMs: number;
  maxRecentJobs: number;
}

/**
 * Marks a queued job as running and applies deterministic ack/final-delivery reset defaults.
 *
 * **Why it exists:**
 * Queue workers need one canonical mutation path before execution starts, otherwise status/ack
 * fields can drift between enqueue and execution surfaces.
 *
 * **What it talks to:**
 * - Mutates `ConversationJob` execution lifecycle fields.
 * - Mutates `ConversationSession.runningJobId`, `updatedAt`, and `recentJobs` via `upsertRecentJob`.
 *
 * @param input - Session/job context and lifecycle bounds for this transition.
 */
export function markQueuedJobRunning(input: MarkQueuedJobRunningInput): void {
  const {
    session,
    job,
    ackDelayMs,
    maxRecentJobs
  } = input;
  const startedAt = new Date().toISOString();
  job.status = "running";
  job.startedAt = startedAt;
  job.completedAt = null;
  job.errorMessage = null;
  job.resultSummary = null;
  job.recoveryTrace = null;
  job.ackMessageId = null;
  job.ackSentAt = null;
  job.ackLastErrorCode = null;
  job.ackEditAttemptCount = 0;
  job.ackEligibleAt = new Date(Date.parse(startedAt) + ackDelayMs).toISOString();
  job.finalDeliveryOutcome = "not_attempted";
  job.finalDeliveryAttemptCount = 0;
  job.finalDeliveryLastErrorCode = null;
  job.finalDeliveryLastAttemptAt = null;
  session.runningJobId = job.id;
  session.updatedAt = startedAt;
  setProgressState(session, {
    status: "working",
    message: buildConversationWorkerProgressMessage(job),
    jobId: job.id,
    updatedAt: startedAt
  });
  upsertRecentJob(session, job, maxRecentJobs);
}

/**
 * Determines whether worker heartbeat pings should be suppressed for a running job.
 *
 * **Why it exists:**
 * Autonomous/system jobs emit their own structured state and should not add generic
 * "Still working..." pings that can confuse users. Editable-ack transports suppress generic
 * heartbeats to avoid progress messages landing after final edited responses, and native-draft
 * transports suppress generic heartbeats to avoid long-lived draft placeholders.
 *
 * **What it talks to:**
 * - Reads `job.executionInput` and `job.isSystemJob`.
 * - Optionally reads notifier transport capabilities.
 *
 * @param job - Running job under evaluation.
 * @param autonomousExecutionPrefix - Prefix used to mark autonomous-loop execution input.
 * @param notify - Optional notifier transport capabilities for session-level suppression checks.
 * @returns `true` when heartbeat pings should be suppressed.
 */
export function shouldSuppressWorkerHeartbeat(
  job: ConversationJob,
  autonomousExecutionPrefix: string,
  notify?: ConversationNotifierTransport
): boolean {
  const isAutonomousJob =
    job.executionInput?.startsWith(autonomousExecutionPrefix) ?? false;
  const hasEditableAckTransport =
    notify?.capabilities.supportsEdit === true &&
    notify.capabilities.supportsNativeStreaming !== true;
  const hasNativeDraftStreamingTransport =
    notify?.capabilities.supportsNativeStreaming === true;
  return (
    isAutonomousJob ||
    job.isSystemJob === true ||
    hasEditableAckTransport ||
    hasNativeDraftStreamingTransport
  );
}

export interface ExecuteRunningJobInput {
  sessionKey: string;
  job: ConversationJob;
  executeTask: ExecuteConversationTask;
  notify: ConversationNotifierTransport;
  heartbeatIntervalMs: number;
  suppressHeartbeat: boolean;
  onWorkerHeartbeat?: () => void;
  onProgressUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void>;
  onExecutionSettled(): void;
}

/**
 * Runs one conversation job with optional heartbeat notifications and captures terminal status.
 *
 * **Why it exists:**
 * Worker-loop execution must consistently apply success/failure status semantics while cleaning up
 * timers/resources in `finally`, regardless of task outcomes.
 *
 * **What it talks to:**
 * - Calls runtime `executeTask` callback with execution input.
 * - Uses notifier `send()`/`stream()` for heartbeat pings when enabled.
 * - Invokes `onExecutionSettled` callback for timer cleanup.
 *
 * @param input - Running job, worker callbacks, and heartbeat controls.
 * @returns Full execution result when the task succeeds, otherwise `null` for failed runs.
 */
export async function executeRunningJob(
  input: ExecuteRunningJobInput
): Promise<ConversationExecutionResult | null> {
  const {
    sessionKey,
    job,
    executeTask,
    notify,
    heartbeatIntervalMs,
    suppressHeartbeat,
    onWorkerHeartbeat,
    onProgressUpdate,
    onExecutionSettled
  } = input;
  const useNativeStreaming = !suppressHeartbeat && canUseNativeStreaming(notify);
  const progressTrace: ConversationOutboundDeliveryTrace = {
    source: "worker_progress",
    sessionKey,
    jobId: job.id,
    jobCreatedAt: job.createdAt
  };

  if (useNativeStreaming) {
    void notify.stream!(buildConversationWorkerProgressMessage(job), progressTrace).catch(() => undefined);
  }

  onWorkerHeartbeat?.();
  const heartbeat = setInterval(() => {
    if (job.status !== "running") {
      return;
    }
    onWorkerHeartbeat?.();
    if (suppressHeartbeat) {
      return;
    }
    const elapsed = elapsedSeconds(job.startedAt ?? job.createdAt);
    const progressText = buildConversationWorkerProgressMessage(job, elapsed);
    if (useNativeStreaming) {
      void notify.stream!(progressText, progressTrace).catch(() => undefined);
      return;
    }
    void notify.send(progressText, progressTrace).catch(() => undefined);
  }, heartbeatIntervalMs);

  try {
    const result = await executeTask(
      job.executionInput ?? job.input,
      job.createdAt,
      onProgressUpdate
    );
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.resultSummary = result.summary;
    job.errorMessage = null;
    return result;
  } catch (error) {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.resultSummary = null;
    job.errorMessage = (error as Error).message;
    return null;
  } finally {
    clearInterval(heartbeat);
    onExecutionSettled();
  }
}

export interface PersistJobOutcomeInput {
  session: ConversationSession;
  executedJob: ConversationJob;
  executionResult: ConversationExecutionResult | null;
  browserSessionSnapshots?: readonly BrowserSessionSnapshot[];
  managedProcessSnapshots?: readonly ManagedProcessSnapshot[];
  maxRecentJobs: number;
  maxRecentActions: number;
  maxBrowserSessions: number;
  maxPathDestinations: number;
  maxConversationTurns: number;
}

/**
 * Persists completed worker outcome into session-ledger state and updates turn/pulse metadata.
 *
 * **Why it exists:**
 * Queue execution and delivery paths need one deterministic post-execution persistence rule set for
 * status updates, ack invariant checks, and conversation-context writes.
 *
 * **What it talks to:**
 * - Reads/writes `session.recentJobs` via `findRecentJob` and `upsertRecentJob`.
 * - Validates ack invariants with `assertAckInvariants`.
 * - Updates pulse + turn history via `backfillPulseSnippet` and `recordAssistantTurn`.
 *
 * @param input - Persisted session snapshot and completed in-memory job fields.
 * @returns Canonical persisted job record from session state.
 */
export function persistExecutedJobOutcome(input: PersistJobOutcomeInput): ConversationJob {
  const {
    session,
    executedJob,
    executionResult,
    browserSessionSnapshots,
    managedProcessSnapshots,
    maxRecentJobs,
    maxRecentActions,
    maxBrowserSessions,
    maxPathDestinations,
    maxConversationTurns
  } = input;
  const suppressUserDelivery = shouldSuppressCompletedSystemJobUserDelivery(
    executedJob,
    executionResult
  );
  const persistedRunningJob = findRecentJob(session, executedJob.id) ?? executedJob;
  persistedRunningJob.status = executedJob.status;
  persistedRunningJob.completedAt = executedJob.completedAt;
  persistedRunningJob.resultSummary = executedJob.resultSummary;
  persistedRunningJob.errorMessage = executedJob.errorMessage;
  persistedRunningJob.recoveryTrace =
    executedJob.recoveryTrace ?? persistedRunningJob.recoveryTrace ?? null;

  const invariant = assertAckInvariants(persistedRunningJob);
  if (!invariant.ok) {
    persistedRunningJob.ackLastErrorCode = invariant.reasonCode ?? "ACK_INVARIANT_FAILED";
  }

  session.runningJobId = null;
  session.updatedAt = new Date().toISOString();
  const pauseRequested =
    typeof persistedRunningJob.pauseRequestedAt === "string" &&
    persistedRunningJob.pauseRequestedAt.trim().length > 0;
  const terminalProgressState =
    pauseRequested
      ? buildPausedReturnHandoffProgressState(persistedRunningJob.id, session.updatedAt)
      : session.progressState &&
          (session.progressState.status === "completed" || session.progressState.status === "stopped")
      ? {
          ...session.progressState,
          jobId: null,
          updatedAt: session.updatedAt
        }
      : null;
  setProgressState(session, terminalProgressState);
  upsertRecentJob(session, persistedRunningJob, maxRecentJobs);

  if (persistedRunningJob.status === "completed" && executionResult?.taskRunResult) {
    const ledgers = deriveConversationLedgersFromTaskRunResult(
      executionResult.taskRunResult,
      persistedRunningJob.id,
      persistedRunningJob.completedAt ?? session.updatedAt
    );
    for (const action of ledgers.recentActions) {
      upsertRecentAction(session, action, maxRecentActions);
    }
    for (const browserSession of ledgers.browserSessions) {
      upsertBrowserSession(session, browserSession, maxBrowserSessions);
    }
    for (const destination of ledgers.pathDestinations) {
      upsertPathDestination(session, destination, maxPathDestinations);
    }
    setActiveWorkspace(
      session,
      deriveActiveWorkspaceFromSession(
        session,
        persistedRunningJob.id,
        persistedRunningJob.completedAt ?? session.updatedAt
      )
    );
    const taskRecoveryClarification = deriveTaskRecoveryClarification(
      executionResult.taskRunResult,
      persistedRunningJob.completedAt ?? session.updatedAt
    );
    if (taskRecoveryClarification) {
      persistedRunningJob.resultSummary = taskRecoveryClarification.reply;
      if (taskRecoveryClarification.clarification) {
        setActiveClarification(session, taskRecoveryClarification.clarification);
        setProgressState(session, {
          status: "waiting_for_user",
          message: taskRecoveryClarification.reply,
          jobId: null,
          updatedAt: persistedRunningJob.completedAt ?? session.updatedAt
        });
      }
    }
  }

  const reconciledSession = reconcileConversationExecutionRuntimeSession(
    session,
    browserSessionSnapshots,
    managedProcessSnapshots
  );
  if (reconciledSession !== session) {
    session.browserSessions = [...reconciledSession.browserSessions];
    session.activeWorkspace = reconciledSession.activeWorkspace;
  }
  if (
    shouldPromoteClosedPreviewStackSummary(
      session,
      persistedRunningJob.resultSummary,
      persistedRunningJob.input,
      executionResult?.taskRunResult ?? null
    )
  ) {
    persistedRunningJob.resultSummary = buildClosedPreviewStackSummary(session);
  }

  if (persistedRunningJob.status === "completed" && !suppressUserDelivery) {
    setReturnHandoff(
      session,
      buildConversationReturnHandoff(
        persistedRunningJob,
        session.progressState,
        session.activeWorkspace
      )
    );
  }
  syncConversationDomainContinuityFromLifecycle(
    session,
    persistedRunningJob.completedAt ?? session.updatedAt
  );

  if (persistedRunningJob.status === "completed") {
    backfillPulseSnippet(session, persistedRunningJob);
  }
  if (
    persistedRunningJob.status === "completed" &&
    persistedRunningJob.resultSummary &&
    !suppressUserDelivery
  ) {
    recordAssistantTurn(
      session,
      persistedRunningJob.resultSummary,
      persistedRunningJob.completedAt ?? session.updatedAt,
      maxConversationTurns,
      {
        assistantTurnKind: "workflow_progress"
      }
    );
  }

  return persistedRunningJob;
}

/**
 * Resolves whether a completed job should stay out of user-facing delivery surfaces.
 *
 * **Why it exists:**
 * System-job suppression should not depend solely on one caller remembering to set a flag. The
 * worker already has both the queued system input and the final summary, so it can infer when a
 * blocked pulse outcome must stay internal.
 *
 * **What it talks to:**
 * - Uses `ConversationExecutionResult` (import type `ConversationExecutionResult`) from
 *   `./conversationRuntime/managerContracts`.
 * - Uses `shouldSuppressPulseUserFacingDeliveryV1` from `./pulseUxRuntime`.
 * - Uses local blocked-summary shape checks within this module.
 *
 * @param job - Persisted or in-memory completed job being evaluated.
 * @param executionResult - Optional structured execution result from the current worker run.
 * @returns `true` when the result should stay off user-facing delivery surfaces.
 */
function shouldSuppressCompletedSystemJobUserDelivery(
  job: ConversationJob,
  executionResult?: ConversationExecutionResult | null
): boolean {
  if (executionResult?.suppressUserDelivery === true) {
    return true;
  }
  if (job.isSystemJob !== true) {
    return false;
  }
  const summary = executionResult?.summary ?? job.resultSummary ?? "";
  if (
    shouldSuppressPulseUserFacingDeliveryV1(
      job.executionInput ?? job.input,
      typeof summary === "string" ? summary : ""
    )
  ) {
    return true;
  }
  return (
    typeof summary === "string" &&
    (
      summary.includes("State: blocked") ||
      summary.includes("What happened: governance blocked the requested action")
    )
  );
}

/**
 * Detects the deterministic system-job state that should suppress user-facing delivery.
 *
 * **Why it exists:**
 * Background system jobs can complete successfully from the queue's perspective while still
 * producing internal-only blocked or suppressed outcomes. The worker needs one canonical guard so
 * those summaries do not leak into user-visible delivery or duplicate persistence paths.
 *
 * **What it talks to:**
 * - Uses `ConversationExecutionResult` (import type `ConversationExecutionResult`) from
 *   `./conversationRuntime/managerContracts`.
 * - Uses local summary-shape checks within this module.
 *
 * @param job - Persisted job outcome being evaluated.
 * @param executionResult - Optional structured execution result from the current worker run.
 * @returns `true` when this job should skip final send/edit and visible assistant-turn persistence.
 */
export function isBlockedSystemJobOutcome(
  job: ConversationJob,
  executionResult?: ConversationExecutionResult | null
): boolean {
  return (
    job.isSystemJob === true &&
    job.status === "completed" &&
    shouldSuppressCompletedSystemJobUserDelivery(job, executionResult)
  );
}

/**
 * Builds the final user-facing message text from a completed or failed conversation job.
 *
 * @param job - Persisted job outcome being rendered.
 * @param showCompletionPrefix - Whether to prepend "Done." to successful completions.
 * @returns Final message text passed to delivery lifecycle helpers.
 */
export function buildFinalMessageForJob(
  job: ConversationJob,
  showCompletionPrefix: boolean
): string {
  if (job.status === "completed") {
    const completionMessage = job.resultSummary ?? "";
    if (showCompletionPrefix) {
      return [
        "Done.",
        completionMessage
      ].filter(Boolean).join("\n");
    }
    return completionMessage.trim()
      ? completionMessage
      : "Request completed.";
  }
  return `Request failed: ${job.errorMessage ?? "Unknown error"}.`;
}
