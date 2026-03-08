/**
 * @fileoverview Owns stale-running-job recovery below the stable conversation ingress coordinator.
 */

import { canTransitionAckLifecycleState } from "../ackStateMachine";
import { buildRecoveredStaleJob } from "../conversationManagerHelpers";
import {
  findRecentJob,
  upsertRecentJob
} from "../conversationSessionMutations";
import type { ConversationSessionRecoveryContext } from "./contracts";

/**
 * Recovers stale running-job state when persisted session metadata outlives the active worker.
 *
 * @param context - Stable ingress recovery context plus mutable session state.
 */
export function recoverStaleRunningJobIfNeeded(
  context: ConversationSessionRecoveryContext
): void {
  const { sessionKey, session, nowIso, deps } = context;
  if (!session.runningJobId) {
    return;
  }
  if (deps.isWorkerActive(sessionKey)) {
    return;
  }

  const nowMs = Date.parse(nowIso);
  const updatedAtMs = Date.parse(session.updatedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(updatedAtMs)) {
    return;
  }
  if (nowMs - updatedAtMs < deps.config.staleRunningJobRecoveryMs) {
    return;
  }

  deps.clearAckTimer(sessionKey);
  const recoveredJob = findRecentJob(session, session.runningJobId);
  if (recoveredJob) {
    recoveredJob.status = "failed";
    recoveredJob.completedAt = nowIso;
    recoveredJob.resultSummary = null;
    recoveredJob.errorMessage = "Recovered stale running job after runtime interruption.";
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
