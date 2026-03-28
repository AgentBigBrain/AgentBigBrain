/**
 * @fileoverview Owns bounded post-execution worker auto-recovery for exact tracked workspace holders.
 */

import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import {
  deriveWorkspaceRecoverySignal,
  type WorkspaceRecoverySignal
} from "../../core/autonomy/workspaceRecoveryPolicy";
import { buildStopExactTrackedRecoverySignal } from "../../core/autonomy/workspaceRecoverySignalBuilders";
import type { TaskRunResult } from "../../core/types";
import type {
  ConversationJob,
  ConversationSession
} from "../sessionStore";
import { enqueueConversationJob } from "./conversationLifecycle";
import {
  buildAutomaticTrackedWorkspaceInspectFirstExecutionInput,
  buildAutomaticTrackedWorkspaceInspectFirstNotice,
  buildAutomaticTrackedWorkspacePostShutdownRetryExecutionInput,
  buildAutomaticTrackedWorkspacePostShutdownRetryNotice,
  buildAutomaticTrackedWorkspaceRecoveryExecutionInput,
  buildAutomaticTrackedWorkspaceRecoveryNotice,
  hasAutomaticTrackedWorkspaceInspectFirstMarker,
  hasAutomaticTrackedWorkspaceRecoveryMarker,
  hasWaitingForUserRecoveryStop,
  isLocalOrganizationRequest,
  pathsOverlap,
  replaceLatestAssistantTurnText,
  shouldEnqueuePostShutdownOrganizationRetry,
  uniqueNonEmpty
} from "./conversationWorkerAutoRecoverySupport";

/**
 * Returns whether newer queued work should take precedence over automatic recovery retries.
 *
 * @param session - Mutable conversation session after the completed job has been persisted.
 * @returns `true` when automatic recovery should fail closed instead of queuing behind newer work.
 */
function hasNewerQueuedWork(session: ConversationSession): boolean {
  return session.queuedJobs.length > 0;
}

/**
 * Returns whether automatic workspace-recovery retries are still compatible with the shared session domain.
 *
 * @param session - Mutable conversation session after the completed job has been persisted.
 * @returns `true` when recovery remains workflow-compatible or legacy metadata is still unknown.
 */
function hasWorkflowCompatibleRecoveryContext(session: ConversationSession): boolean {
  const workspaceSnapshotLane = session.activeWorkspace?.domainSnapshotLane ?? null;
  const handoffSnapshotLane = session.returnHandoff?.domainSnapshotLane ?? null;
  if (workspaceSnapshotLane === "workflow") {
    return true;
  }
  if (handoffSnapshotLane === "workflow") {
    return true;
  }
  if (
    workspaceSnapshotLane === "profile" ||
    workspaceSnapshotLane === "relationship" ||
    workspaceSnapshotLane === "system_policy" ||
    handoffSnapshotLane === "profile" ||
    handoffSnapshotLane === "relationship" ||
    handoffSnapshotLane === "system_policy"
  ) {
    return false;
  }
  if (session.domainContext.dominantLane === "workflow") {
    return true;
  }
  if (
    session.domainContext.dominantLane === "profile" ||
    session.domainContext.dominantLane === "relationship" ||
    session.domainContext.dominantLane === "system_policy"
  ) {
    return false;
  }
  return (
    session.modeContinuity?.activeMode === "plan" ||
    session.modeContinuity?.activeMode === "build" ||
    session.modeContinuity?.activeMode === "autonomous" ||
    session.modeContinuity?.activeMode === "review"
  ) || session.domainContext.dominantLane === "unknown";
}

/**
 * Resolves the most human-facing organization request text available for a queued automatic
 * workspace-recovery retry.
 *
 * @param completedJob - Persisted completed job whose original input should be preserved.
 * @param taskRunResult - Completed task result whose task input may already be wrapped.
 * @returns Original human request text suitable for the next queued job input.
 */
function resolveAutomaticTrackedWorkspaceRecoverySourceInput(
  completedJob: ConversationJob,
  taskRunResult: TaskRunResult
): string {
  const completedInput = completedJob.input.trim();
  if (completedInput.length > 0) {
    return completedInput;
  }
  const activeRequest = extractActiveRequestSegment(taskRunResult.task.userInput).trim();
  if (activeRequest.length > 0) {
    return activeRequest;
  }
  return taskRunResult.task.goal.trim() || taskRunResult.task.userInput.trim();
}

/**
 * Promotes one blocked local-organization run directly into exact tracked-holder recovery when
 * the current session already owns live preview leases for every blocked folder path.
 *
 * @param session - Mutable conversation session with current tracked workspace state.
 * @param taskRunResult - Completed blocked task result.
 * @param recoverySignal - Derived recovery signal for the blocked run.
 * @returns Exact tracked-holder signal, or `null` when the blocked paths exceed the live tracked scope.
 */
function buildSessionExactTrackedWorkspaceRecoverySignal(
  session: ConversationSession,
  taskRunResult: TaskRunResult,
  recoverySignal: WorkspaceRecoverySignal
): WorkspaceRecoverySignal | null {
  if (
    recoverySignal.recommendedAction !== "inspect_first" ||
    !isLocalOrganizationRequest(taskRunResult.task.userInput)
  ) {
    return null;
  }
  const activeWorkspace = session.activeWorkspace;
  if (
    !activeWorkspace ||
    activeWorkspace.ownershipState !== "tracked" ||
    !activeWorkspace.stillControllable ||
    activeWorkspace.previewProcessLeaseIds.length === 0
  ) {
    return null;
  }
  const trackedBrowserSessions = session.browserSessions.filter(
    (browserSession) =>
      activeWorkspace.browserSessionIds.includes(browserSession.id) &&
      browserSession.status === "open" &&
      browserSession.controlAvailable
  );
  const liveExactLeaseIds = uniqueNonEmpty([
    ...trackedBrowserSessions.map((browserSession) => browserSession.linkedProcessLeaseId),
    ...activeWorkspace.previewProcessLeaseIds
  ]);
  if (liveExactLeaseIds.length === 0) {
    return null;
  }

  const attributableRoots = uniqueNonEmpty([
    activeWorkspace.rootPath,
    activeWorkspace.previewProcessCwd,
    ...trackedBrowserSessions.map((browserSession) => browserSession.workspaceRootPath),
    ...trackedBrowserSessions.map((browserSession) => browserSession.linkedProcessCwd)
  ]);
  if (attributableRoots.length === 0) {
    return null;
  }

  const blockedFolderPaths = recoverySignal.blockedFolderPaths ?? [];
  if (
    blockedFolderPaths.length > 0 &&
    blockedFolderPaths.some(
      (blockedFolderPath) =>
        !attributableRoots.some((candidateRoot) =>
          pathsOverlap(candidateRoot, blockedFolderPath)
        )
    )
  ) {
    return null;
  }

  const recoveredExactHolderPids = trackedBrowserSessions
    .map((browserSession) => browserSession.linkedProcessPid)
    .filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0);

  return buildStopExactTrackedRecoverySignal({
    matchedRuleId: "post_execution_exact_holder_folder_recovery_from_session",
    reasoning:
      "The blocked folders are all attributable to live preview leases already tracked in this same conversation, so the runtime can skip another generic inspect step and stop only those exact holders.",
    question:
      "I found the exact tracked preview holders blocking those folders in this same workspace, so I'm shutting down only those tracked holders and retrying the move now.",
    recoveryInstruction:
      `Recovery instruction: stop only these exact tracked preview holders if they are still active: ${liveExactLeaseIds.map((leaseId) => `leaseId=\"${leaseId}\"`).join(", ")}. ` +
      "Verify they stopped, then retry the original folder-organization request. Do not stop unrelated apps by name.",
    trackedPreviewProcessLeaseIds: liveExactLeaseIds,
    recoveredExactHolderPids,
    blockedFolderPaths
  });
}

/**
 * Enqueues one bounded automatic retry when exact tracked holder evidence proves the safe recovery path.
 *
 * @param session - Mutable conversation session after the completed job has been persisted.
 * @param completedJob - Persisted completed job whose summary may be replaced by the retry notice.
 * @param taskRunResult - Completed task result used to derive recovery evidence.
 * @returns `true` when the retry job was queued and the completed-job summary was replaced.
 */
export function enqueueAutomaticTrackedWorkspaceRecoveryRetry(
  session: ConversationSession,
  completedJob: ConversationJob,
  taskRunResult: TaskRunResult
): boolean {
  if (hasNewerQueuedWork(session)) {
    return false;
  }
  if (!hasWorkflowCompatibleRecoveryContext(session)) {
    return false;
  }
  const sourceInput = resolveAutomaticTrackedWorkspaceRecoverySourceInput(
    completedJob,
    taskRunResult
  );
  if (shouldEnqueuePostShutdownOrganizationRetry(completedJob, taskRunResult)) {
    const retryNotice = buildAutomaticTrackedWorkspacePostShutdownRetryNotice();
    const previousSummary = completedJob.resultSummary;
    const retryReceivedAt = completedJob.completedAt ?? session.updatedAt;
    enqueueConversationJob(
      session,
      sourceInput,
      retryReceivedAt,
      buildAutomaticTrackedWorkspacePostShutdownRetryExecutionInput(sourceInput)
    );
    session.activeClarification = null;
    session.progressState = null;
    completedJob.resultSummary = retryNotice;
    completedJob.recoveryTrace = {
      kind: "workspace_auto_recovery",
      status: "attempting",
      summary: retryNotice,
      updatedAt: retryReceivedAt,
      recoveryClass: "WORKSPACE_HOLDER_CONFLICT",
      fingerprint: null
    };
    replaceLatestAssistantTurnText(session, previousSummary, retryNotice);
    return true;
  }

  const recoverySignal = deriveWorkspaceRecoverySignal(taskRunResult);
  if (!recoverySignal) {
    return false;
  }
  const promotedExactRecoverySignal = buildSessionExactTrackedWorkspaceRecoverySignal(
    session,
    taskRunResult,
    recoverySignal
  );
  const effectiveRecoverySignal = promotedExactRecoverySignal ?? recoverySignal;

  if (effectiveRecoverySignal.recommendedAction === "inspect_first") {
    if (
      !isLocalOrganizationRequest(taskRunResult.task.userInput) ||
      hasAutomaticTrackedWorkspaceInspectFirstMarker(completedJob)
    ) {
      return false;
    }
    if (hasWaitingForUserRecoveryStop(session, completedJob)) {
      return false;
    }

    const retryNotice = buildAutomaticTrackedWorkspaceInspectFirstNotice();
    const previousSummary = completedJob.resultSummary;
    const retryReceivedAt = completedJob.completedAt ?? session.updatedAt;
    enqueueConversationJob(
      session,
      sourceInput,
      retryReceivedAt,
      buildAutomaticTrackedWorkspaceInspectFirstExecutionInput(
        sourceInput,
        effectiveRecoverySignal
      )
    );
    session.activeClarification = null;
    session.progressState = null;
    completedJob.resultSummary = retryNotice;
    completedJob.recoveryTrace = {
      kind: "workspace_auto_recovery",
      status: "attempting",
      summary: retryNotice,
      updatedAt: retryReceivedAt,
      recoveryClass: "WORKSPACE_HOLDER_CONFLICT",
      fingerprint: null
    };
    replaceLatestAssistantTurnText(session, previousSummary, retryNotice);
    return true;
  }

  if (effectiveRecoverySignal.recommendedAction !== "stop_exact_tracked_holders") {
    return false;
  }
  if (hasAutomaticTrackedWorkspaceRecoveryMarker(completedJob)) {
    return false;
  }

  const retryNotice = buildAutomaticTrackedWorkspaceRecoveryNotice();
  const previousSummary = completedJob.resultSummary;
  const retryReceivedAt = completedJob.completedAt ?? session.updatedAt;
  enqueueConversationJob(
    session,
    sourceInput,
    retryReceivedAt,
    buildAutomaticTrackedWorkspaceRecoveryExecutionInput(
      sourceInput,
      effectiveRecoverySignal
    )
  );
  session.activeClarification = null;
  session.progressState = null;
  completedJob.resultSummary = retryNotice;
  completedJob.recoveryTrace = {
    kind: "workspace_auto_recovery",
    status: "attempting",
    summary: retryNotice,
    updatedAt: retryReceivedAt,
    recoveryClass: "WORKSPACE_HOLDER_CONFLICT",
    fingerprint: null
  };
  replaceLatestAssistantTurnText(session, previousSummary, retryNotice);
  return true;
}
