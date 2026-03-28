/**
 * @fileoverview Owns stale-running-job recovery below the stable conversation ingress coordinator.
 */

import { canTransitionAckLifecycleState } from "../ackStateMachine";
import {
  buildRecoveredStaleJob,
  buildRecoveredStaleQueuedJob
} from "../conversationManagerHelpers";
import {
  findRecentJob,
  upsertRecentJob
} from "../conversationSessionMutations";
import type { ConversationSessionRecoveryContext } from "./contracts";

/**
 * Returns whether one persisted timestamp is older than the bounded stale-recovery window.
 *
 * @param timestampIso - Persisted lifecycle timestamp under evaluation.
 * @param nowIso - Current ingress timestamp.
 * @param thresholdMs - Maximum allowed age before recovery should trigger.
 * @returns `true` when the timestamp is stale enough to recover.
 */
function isOlderThanRecoveryWindow(
  timestampIso: string | null | undefined,
  nowIso: string,
  thresholdMs: number
): boolean {
  if (!timestampIso) {
    return false;
  }
  const nowMs = Date.parse(nowIso);
  const candidateMs = Date.parse(timestampIso);
  if (!Number.isFinite(nowMs) || !Number.isFinite(candidateMs)) {
    return false;
  }
  return nowMs - candidateMs >= thresholdMs;
}

/**
 * Clears a stale user-facing working progress snapshot when there is no running worker left to own
 * it.
 *
 * @param context - Stable ingress recovery context plus mutable session state.
 * @returns `true` when the stale progress snapshot was cleared.
 */
function clearOrphanedWorkingProgressIfNeeded(
  context: ConversationSessionRecoveryContext
): boolean {
  const { session, nowIso, deps } = context;
  if (session.progressState?.status !== "working") {
    return false;
  }
  if (
    !isOlderThanRecoveryWindow(
      session.progressState.updatedAt,
      nowIso,
      deps.config.staleRunningJobRecoveryMs
    )
  ) {
    return false;
  }
  if (session.runningJobId && session.progressState.jobId === session.runningJobId) {
    return false;
  }
  session.progressState = null;
  session.updatedAt = nowIso;
  return true;
}

/**
 * Fails queued jobs that outlived the worker/runtime that should have started them.
 *
 * @param context - Stable ingress recovery context plus mutable session state.
 * @returns `true` when at least one stale queued job was recovered.
 */
function recoverStaleQueuedJobsIfNeeded(
  context: ConversationSessionRecoveryContext
): boolean {
  const { session, nowIso, deps } = context;
  if (session.runningJobId || session.queuedJobs.length === 0) {
    return false;
  }
  const staleJobs = session.queuedJobs.filter((job) =>
    isOlderThanRecoveryWindow(job.createdAt, nowIso, deps.config.staleRunningJobRecoveryMs)
  );
  if (staleJobs.length === 0) {
    return false;
  }
  const staleJobIds = new Set(staleJobs.map((job) => job.id));
  session.queuedJobs = session.queuedJobs.filter((job) => !staleJobIds.has(job.id));
  for (const job of staleJobs) {
    upsertRecentJob(
      session,
      buildRecoveredStaleQueuedJob(job, nowIso),
      deps.config.maxRecentJobs
    );
  }
  session.updatedAt = nowIso;
  return true;
}

/**
 * Recovers stale running-job state when persisted session metadata outlives the active worker.
 *
 * @param context - Stable ingress recovery context plus mutable session state.
 */
export function recoverStaleRunningJobIfNeeded(
  context: ConversationSessionRecoveryContext
): void {
  const { sessionKey, session, nowIso, deps } = context;
  if (deps.isWorkerActive(sessionKey)) {
    return;
  }
  recoverStaleQueuedJobsIfNeeded(context);
  clearOrphanedWorkingProgressIfNeeded(context);
  if (!session.runningJobId) {
    return;
  }

  if (
    !isOlderThanRecoveryWindow(
      session.updatedAt,
      nowIso,
      deps.config.staleRunningJobRecoveryMs
    )
  ) {
    return;
  }

  deps.clearAckTimer(sessionKey);
  const recoveredJob = findRecentJob(session, session.runningJobId);
  if (recoveredJob) {
    recoveredJob.status = "failed";
    recoveredJob.completedAt = nowIso;
    recoveredJob.resultSummary = null;
    recoveredJob.errorMessage = "Recovered stale running job after runtime interruption.";
    recoveredJob.recoveryTrace = {
      kind: "stale_session_recovery",
      status: "failed",
      summary: "Recovered stale running job after runtime interruption.",
      updatedAt: nowIso,
      recoveryClass: null,
      fingerprint: null
    };
    recoveredJob.ackTimerGeneration += 1;
    recoveredJob.ackLastErrorCode = "STALE_RUNNING_JOB_RECOVERED";
    recoveredJob.ackMessageId = null;
    recoveredJob.ackSentAt = null;
    recoveredJob.ackLifecycleState = canTransitionAckLifecycleState(
      recoveredJob.ackLifecycleState,
      "CANCELLED"
    )
      ? "CANCELLED"
      : recoveredJob.ackLifecycleState;
    if (recoveredJob.finalDeliveryOutcome === "not_attempted") {
      recoveredJob.finalDeliveryOutcome = "failed";
    }
    recoveredJob.finalDeliveryAttemptCount = Math.max(1, recoveredJob.finalDeliveryAttemptCount);
    recoveredJob.finalDeliveryLastErrorCode = "STALE_RUNNING_JOB_RECOVERED";
    recoveredJob.finalDeliveryLastAttemptAt = nowIso;
    upsertRecentJob(session, recoveredJob, deps.config.maxRecentJobs);
  } else {
    const syntheticRecoveredJob = buildRecoveredStaleJob(
      session.runningJobId,
      session.updatedAt,
      nowIso
    );
    upsertRecentJob(session, syntheticRecoveredJob, deps.config.maxRecentJobs);
  }

  session.runningJobId = null;
  session.updatedAt = nowIso;
}
