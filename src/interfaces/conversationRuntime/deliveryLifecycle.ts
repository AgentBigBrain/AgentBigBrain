/**
 * @fileoverview Canonical ack-timer and final-delivery persistence lifecycle helpers.
 */

import {
  assertAckInvariants,
  canEditAckMessage,
  deriveAckEligibility,
  isFinalDeliveryTerminal,
  isRateLimitedErrorCode
} from "../ackStateMachine";
import { findRecentJob, upsertRecentJob } from "../conversationSessionMutations";
import type {
  DeliverFinalMessageInput,
  HandleAckTimerFireInput,
  ScheduleAckTimerForJobInput
} from "./deliveryContracts";
import {
  streamEditableAckPreview,
  streamNativeFinalPreview
} from "./deliveryPreview";
import type {
  ConversationJob
} from "../sessionStore";

/**
 * Builds stable outbound-trace metadata for worker-owned delivery operations.
 *
 * @param source - Delivery phase being emitted.
 * @param sessionKey - Conversation session that owns the job.
 * @param job - Persisted job supplying stable identifiers.
 * @returns Structured outbound trace attached to transport sends/edits/streams.
 */
function buildWorkerDeliveryTrace(
  source:
    | "worker_ack"
    | "worker_final_preview"
    | "worker_final",
  sessionKey: string,
  job: ConversationJob
) {
  return {
    source,
    sessionKey,
    jobId: job.id,
    jobCreatedAt: job.createdAt
  } as const;
}

/**
 * Schedules delayed ack timer delivery for one running job when transport/session capabilities allow it.
 *
 * @param input - Timer state, running job metadata, and lifecycle callbacks.
 */
export function scheduleAckTimerForJob(input: ScheduleAckTimerForJobInput): void {
  const {
    sessionKey,
    runningJob,
    notify,
    ackTimers,
    clearAckTimer,
    canUseAckTimerForSession,
    onTimerFire
  } = input;
  clearAckTimer(sessionKey);
  if (!canUseAckTimerForSession(sessionKey, notify)) {
    return;
  }
  if (!runningJob.ackEligibleAt) {
    return;
  }

  const eligibleAtMs = Date.parse(runningJob.ackEligibleAt);
  if (!Number.isFinite(eligibleAtMs)) {
    return;
  }
  const delayMs = Math.max(0, eligibleAtMs - Date.now());
  const timerRecord = {
    jobId: runningJob.id,
    generation: runningJob.ackTimerGeneration
  };
  const timer = setTimeout(() => {
    ackTimers.delete(sessionKey);
    void onTimerFire(timerRecord);
  }, delayMs);
  ackTimers.set(sessionKey, timer);
}

/**
 * Processes an expired ack timer and persists deterministic ack metadata outcomes.
 *
 * @param input - Ack timer context and callback dependencies from conversation manager.
 * @returns Promise resolving once ack timer outcomes are persisted.
 */
export async function handleAckTimerFire(input: HandleAckTimerFireInput): Promise<void> {
  const {
    sessionKey,
    timerRecord,
    notify,
    store,
    maxRecentJobs,
    canUseAckTimerForSession,
    setAckLifecycleState
  } = input;

  const session = await store.getSession(sessionKey);
  if (!session || session.runningJobId !== timerRecord.jobId) {
    return;
  }

  const runningJob = findRecentJob(session, timerRecord.jobId);
  if (!runningJob || runningJob.status !== "running") {
    return;
  }
  if (runningJob.ackTimerGeneration !== timerRecord.generation) {
    return;
  }

  const nowIso = new Date().toISOString();
  const eligibility = deriveAckEligibility(
    runningJob,
    nowIso,
    canUseAckTimerForSession(sessionKey, notify)
  );
  if (!eligibility.eligible) {
    if (eligibility.reasonCode && eligibility.reasonCode !== "ACK_DELAY_NOT_REACHED") {
      runningJob.ackLastErrorCode = eligibility.reasonCode;
      upsertRecentJob(session, runningJob, maxRecentJobs);
      session.updatedAt = nowIso;
      await store.setSession(session);
    }
    return;
  }

  const ackMessage =
    "I'm on it. I'll keep you posted here as I go.";
  const delivery = await notify.send(
    ackMessage,
    buildWorkerDeliveryTrace("worker_ack", sessionKey, runningJob)
  );
  if (!delivery.ok) {
    setAckLifecycleState(
      runningJob,
      "CANCELLED",
      delivery.errorCode ?? "ACK_SEND_FAILED"
    );
    runningJob.ackLastErrorCode = delivery.errorCode ?? "ACK_SEND_FAILED";
    upsertRecentJob(session, runningJob, maxRecentJobs);
    session.updatedAt = nowIso;
    await store.setSession(session);
    return;
  }

  if (!delivery.messageId) {
    setAckLifecycleState(
      runningJob,
      "CANCELLED",
      "ACK_MESSAGE_ID_MISSING"
    );
    runningJob.ackLastErrorCode = "ACK_MESSAGE_ID_MISSING";
    upsertRecentJob(session, runningJob, maxRecentJobs);
    session.updatedAt = nowIso;
    await store.setSession(session);
    return;
  }

  setAckLifecycleState(runningJob, "SENT", "ACK_STATE_TRANSITION_BLOCKED");
  runningJob.ackMessageId = delivery.messageId;
  runningJob.ackSentAt = nowIso;
  runningJob.ackLastErrorCode = null;
  const invariant = assertAckInvariants(runningJob);
  if (!invariant.ok) {
    setAckLifecycleState(
      runningJob,
      "CANCELLED",
      invariant.reasonCode ?? "ACK_INVARIANT_FAILED"
    );
    runningJob.ackLastErrorCode = invariant.reasonCode ?? "ACK_INVARIANT_FAILED";
    runningJob.ackMessageId = null;
  }

  upsertRecentJob(session, runningJob, maxRecentJobs);
  session.updatedAt = nowIso;
  await store.setSession(session);
}

/**
 * Sends or edits the final user-facing message and persists delivery outcomes.
 *
 * @param input - Final-delivery context and callback dependencies from conversation manager.
 * @returns Promise resolving after final-delivery outcomes are persisted.
 */
export async function deliverFinalMessage(input: DeliverFinalMessageInput): Promise<void> {
  const {
    sessionKey,
    jobId,
    finalMessage,
    notify,
    store,
    maxRecentJobs,
    canUseAckTimerForSession,
    setAckLifecycleState
  } = input;

  const session = await store.getSession(sessionKey);
  if (!session) {
    return;
  }

  const runningOrRecentJob = findRecentJob(session, jobId);
  if (!runningOrRecentJob) {
    return;
  }
  if (isFinalDeliveryTerminal(runningOrRecentJob.finalDeliveryOutcome)) {
    return;
  }

  const canUseAckEdit =
    canUseAckTimerForSession(sessionKey, notify) && canEditAckMessage(runningOrRecentJob);
  const canEditInTransport = typeof notify.edit === "function";
  const baseNowIso = new Date().toISOString();
  let editablePreviewDeliveredFullText = false;
  let editAttempted = false;

  if (runningOrRecentJob.isSystemJob !== true) {
    if (canUseAckEdit && canEditInTransport) {
      const previewTrace = buildWorkerDeliveryTrace(
        "worker_final_preview",
        sessionKey,
        runningOrRecentJob
      );
      const previewResult = await streamEditableAckPreview(
        notify,
        runningOrRecentJob.ackMessageId!,
        finalMessage,
        previewTrace
      );
      editablePreviewDeliveredFullText = previewResult.deliveredFullText;
    } else {
      await streamNativeFinalPreview(
        notify,
        finalMessage,
        buildWorkerDeliveryTrace("worker_final_preview", sessionKey, runningOrRecentJob)
      );
    }
  }

  if (canUseAckEdit && canEditInTransport) {
    if (editablePreviewDeliveredFullText) {
      runningOrRecentJob.ackEditAttemptCount += 1;
      runningOrRecentJob.finalDeliveryAttemptCount += 1;
      runningOrRecentJob.finalDeliveryLastAttemptAt = baseNowIso;
      setAckLifecycleState(
        runningOrRecentJob,
        "REPLACED",
        "ACK_REPLACE_STATE_TRANSITION_BLOCKED"
      );
      runningOrRecentJob.finalDeliveryOutcome = "sent";
      runningOrRecentJob.finalDeliveryLastErrorCode = null;
      runningOrRecentJob.ackLastErrorCode = null;
      upsertRecentJob(session, runningOrRecentJob, maxRecentJobs);
      session.updatedAt = baseNowIso;
      await store.setSession(session);
      return;
    }

    editAttempted = true;
    runningOrRecentJob.ackEditAttemptCount += 1;
    runningOrRecentJob.finalDeliveryAttemptCount += 1;
    runningOrRecentJob.finalDeliveryLastAttemptAt = baseNowIso;
    const editResult = await notify.edit!(
      runningOrRecentJob.ackMessageId!,
      finalMessage,
      buildWorkerDeliveryTrace("worker_final", sessionKey, runningOrRecentJob)
    );
    if (editResult.ok) {
      setAckLifecycleState(
        runningOrRecentJob,
        "REPLACED",
        "ACK_REPLACE_STATE_TRANSITION_BLOCKED"
      );
      runningOrRecentJob.finalDeliveryOutcome = "sent";
      runningOrRecentJob.finalDeliveryLastErrorCode = null;
      runningOrRecentJob.ackLastErrorCode = null;
      upsertRecentJob(session, runningOrRecentJob, maxRecentJobs);
      session.updatedAt = baseNowIso;
      await store.setSession(session);
      return;
    }
    runningOrRecentJob.ackLastErrorCode = editResult.errorCode ?? "ACK_EDIT_FAILED";
    runningOrRecentJob.finalDeliveryLastErrorCode = editResult.errorCode ?? "ACK_EDIT_FAILED";
  }

  const sendAttemptAt = new Date().toISOString();
  runningOrRecentJob.finalDeliveryAttemptCount += 1;
  runningOrRecentJob.finalDeliveryLastAttemptAt = sendAttemptAt;
  const sendResult = await notify.send(
    finalMessage,
    buildWorkerDeliveryTrace("worker_final", sessionKey, runningOrRecentJob)
  );
  if (sendResult.ok) {
    runningOrRecentJob.finalDeliveryOutcome = "sent";
    runningOrRecentJob.finalDeliveryLastErrorCode = null;
    setAckLifecycleState(
      runningOrRecentJob,
      "FINAL_SENT_NO_EDIT",
      "ACK_FINAL_NO_EDIT_STATE_TRANSITION_BLOCKED"
    );
    upsertRecentJob(session, runningOrRecentJob, maxRecentJobs);
    session.updatedAt = sendAttemptAt;
    await store.setSession(session);
    return;
  }

  runningOrRecentJob.finalDeliveryOutcome = isRateLimitedErrorCode(sendResult.errorCode)
    ? "rate_limited"
    : "failed";
  runningOrRecentJob.finalDeliveryLastErrorCode =
    sendResult.errorCode ??
    (editAttempted ? "FINAL_SEND_FAILED_AFTER_EDIT_ATTEMPT" : "FINAL_SEND_FAILED");
  runningOrRecentJob.errorMessage =
    `Final response delivery failed (${runningOrRecentJob.finalDeliveryLastErrorCode}).`;
  runningOrRecentJob.status = "failed";
  setAckLifecycleState(
    runningOrRecentJob,
    "CANCELLED",
    runningOrRecentJob.finalDeliveryLastErrorCode
  );
  runningOrRecentJob.ackLastErrorCode = runningOrRecentJob.finalDeliveryLastErrorCode;
  upsertRecentJob(session, runningOrRecentJob, maxRecentJobs);
  session.updatedAt = sendAttemptAt;
  await store.setSession(session);
}
