/**
 * @fileoverview Implements deterministic worker-loop lifecycle helpers for conversation queue execution.
 */

import { assertAckInvariants } from "./ackStateMachine";
import { backfillPulseSnippet } from "./pulseEmissionLifecycle";
import { elapsedSeconds } from "./conversationManagerHelpers";
import {
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
import { deriveConversationLedgersFromTaskRunResult } from "./conversationRuntime/recentActionLedger";
import { buildConversationReturnHandoff } from "./conversationRuntime/returnHandoff";
import { buildPausedReturnHandoffProgressState } from "./conversationRuntime/returnHandoffControl";
import { deriveTaskRecoveryClarification } from "./conversationRuntime/taskRecoveryClarification";
import { reconcileConversationExecutionRuntimeSession } from "./conversationRuntime/executionInputRuntimeOwnership";
import {
  dirnameCrossPlatformPath,
  extnameCrossPlatformPath
} from "../core/crossPlatformPath";
import type { BrowserSessionSnapshot } from "../organs/liveRun/browserSessionRegistry";
import type { ManagedProcessSnapshot } from "../organs/liveRun/managedProcessRegistry";
import type {
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
function selectPrimaryArtifactPath(
  changedPaths: readonly string[],
  previousWorkspace: ConversationActiveWorkspaceRecord | null
): string | null {
  const htmlPath = changedPaths.find((entry) => entry.toLowerCase().endsWith(".html"));
  if (htmlPath) {
    return htmlPath;
  }
  const filePath = changedPaths.find((entry) => extnameCrossPlatformPath(entry).length > 0);
  if (filePath) {
    return filePath;
  }
  return previousWorkspace?.primaryArtifactPath ?? null;
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
  browserSession: ConversationSession["browserSessions"][number] | null,
  primaryArtifactPath: string | null,
  previousWorkspace: ConversationActiveWorkspaceRecord | null
): string | null {
  const processDestination =
    session.pathDestinations.find(
      (destination) =>
        destination.sourceJobId === sourceJobId &&
        destination.id.startsWith("path:process:")
    ) ?? null;
  if (browserSession?.workspaceRootPath) {
    return browserSession.workspaceRootPath;
  }
  if (browserSession?.linkedProcessCwd) {
    return browserSession.linkedProcessCwd;
  }
  if (processDestination) {
    return processDestination.resolvedPath;
  }
  const folderDestination =
    session.pathDestinations.find(
      (destination) =>
        destination.sourceJobId === sourceJobId &&
        !destination.resolvedPath.toLowerCase().endsWith(".html") &&
        !destination.resolvedPath.toLowerCase().endsWith(".css") &&
        !destination.resolvedPath.toLowerCase().endsWith(".js")
    ) ?? null;
  if (folderDestination) {
    return folderDestination.resolvedPath;
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
  const continuityBrowserSession =
    (previousWorkspace?.browserSessionId
      ? session.browserSessions.find(
          (browserSession) => browserSession.id === previousWorkspace.browserSessionId
        ) ?? null
      : null) ??
    currentJobBrowserSession;
  const changedPaths = collectWorkspaceChangedPaths(session, sourceJobId);
  const primaryArtifactPath = selectPrimaryArtifactPath(changedPaths, previousWorkspace);
  const rootPath = resolveWorkspaceRootPath(
    session,
    sourceJobId,
    continuityBrowserSession,
    primaryArtifactPath,
    previousWorkspace
  );
  const previewUrl =
    continuityBrowserSession?.url ??
    session.recentActions.find(
      (action) =>
        action.sourceJobId === sourceJobId &&
        action.kind === "url" &&
        typeof action.location === "string"
    )?.location ??
    previousWorkspace?.previewUrl ??
    null;
  const previewProcessLeaseIds = uniqueNonEmpty([
    continuityBrowserSession?.linkedProcessLeaseId ?? null,
    previousWorkspace?.previewProcessLeaseId ?? null,
    ...(previousWorkspace?.previewProcessLeaseIds ?? []),
    ...currentJobBrowserSessions.map((browserSession) => browserSession.linkedProcessLeaseId)
  ]);
  const browserSessionIds = uniqueNonEmpty([
    continuityBrowserSession?.id ?? null,
    previousWorkspace?.browserSessionId ?? null,
    ...(previousWorkspace?.browserSessionIds ?? []),
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
    previousWorkspace?.lastKnownPreviewProcessPid ??
    null;
  const browserProcessPid =
    continuityBrowserSession?.browserProcessPid ??
    previousWorkspace?.browserProcessPid ??
    null;
  const previewProcessCwd =
    continuityBrowserSession?.workspaceRootPath ??
    continuityBrowserSession?.linkedProcessCwd ??
    previousWorkspace?.previewProcessCwd ??
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
      previousWorkspace?.id ??
      `workspace:${rootPath ?? primaryArtifactPath ?? previewUrl ?? sourceJobId}`,
    label: "Current project workspace",
    rootPath,
    primaryArtifactPath,
    previewUrl,
    browserSessionId: continuityBrowserSession?.id ?? previousWorkspace?.browserSessionId ?? null,
    browserSessionIds,
    browserSessionStatus:
      continuityBrowserSession?.status ??
      previousWorkspace?.browserSessionStatus ??
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
        : (previousWorkspace?.lastChangedPaths ?? []),
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
  summary: string | null
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
  return session.browserSessions.some(
    (browserSession) =>
      activeWorkspace.browserSessionIds.includes(browserSession.id) &&
      browserSession.status === "closed"
  );
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
  job: ConversationJob;
  executeTask: ExecuteConversationTask;
  notify: ConversationNotifierTransport;
  heartbeatIntervalMs: number;
  suppressHeartbeat: boolean;
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
    job,
    executeTask,
    notify,
    heartbeatIntervalMs,
    suppressHeartbeat,
    onProgressUpdate,
    onExecutionSettled
  } = input;
  const useNativeStreaming = !suppressHeartbeat && canUseNativeStreaming(notify);

  if (useNativeStreaming) {
    void notify.stream!(buildConversationWorkerProgressMessage(job)).catch(() => undefined);
  }

  const heartbeat = suppressHeartbeat
    ? null
    : setInterval(() => {
        if (job.status !== "running") {
          return;
        }
        const elapsed = elapsedSeconds(job.startedAt ?? job.createdAt);
        const progressText = buildConversationWorkerProgressMessage(job, elapsed);
        if (useNativeStreaming) {
          void notify.stream!(progressText).catch(() => undefined);
          return;
        }
        void notify.send(progressText).catch(() => undefined);
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
    if (heartbeat) {
      clearInterval(heartbeat);
    }
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
  const persistedRunningJob = findRecentJob(session, executedJob.id) ?? executedJob;
  persistedRunningJob.status = executedJob.status;
  persistedRunningJob.completedAt = executedJob.completedAt;
  persistedRunningJob.resultSummary = executedJob.resultSummary;
  persistedRunningJob.errorMessage = executedJob.errorMessage;

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
  if (shouldPromoteClosedPreviewStackSummary(session, persistedRunningJob.resultSummary)) {
    persistedRunningJob.resultSummary = buildClosedPreviewStackSummary(session);
  }

  if (persistedRunningJob.status === "completed") {
    setReturnHandoff(
      session,
      buildConversationReturnHandoff(
        persistedRunningJob,
        session.progressState,
        session.activeWorkspace
      )
    );
  }

  if (persistedRunningJob.status === "completed") {
    backfillPulseSnippet(session, persistedRunningJob);
  }
  if (persistedRunningJob.status === "completed" && persistedRunningJob.resultSummary) {
    recordAssistantTurn(
      session,
      persistedRunningJob.resultSummary,
      persistedRunningJob.completedAt ?? session.updatedAt,
      maxConversationTurns
    );
  }

  return persistedRunningJob;
}

/**
 * Detects the deterministic system-job blocked state that should suppress duplicate final delivery.
 *
 * @param job - Persisted job outcome being evaluated.
 * @returns `true` when this job already emitted blocked output and should skip final send/edit.
 */
export function isBlockedSystemJobOutcome(job: ConversationJob): boolean {
  return (
    job.isSystemJob === true &&
    job.status === "completed" &&
    typeof job.resultSummary === "string" &&
    job.resultSummary.includes("State: blocked")
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
