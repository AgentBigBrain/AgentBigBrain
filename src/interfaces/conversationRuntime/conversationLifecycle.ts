/**
 * @fileoverview Canonical queue and ack-lifecycle helpers for conversation runtime coordination.
 */

import { makeId } from "../../core/ids";
import { canTransitionAckLifecycleState } from "../ackStateMachine";
import type {
  ConversationAckLifecycleState,
  ConversationJob,
  ConversationSession
} from "../sessionStore";

export interface EnqueueResult {
  reply: string;
  shouldStartWorker: boolean;
}

interface AckTimerCapableNotifier {
  capabilities: {
    supportsEdit: boolean;
    supportsNativeStreaming: boolean;
  };
}

/**
 * Returns true when a session can use delayed ack plus later edit replacement flow.
 */
export function canUseConversationAckTimerForSession(
  sessionKey: string,
  notifier: AckTimerCapableNotifier
): boolean {
  const provider = sessionKey.split(":")[0]?.trim().toLowerCase();
  return (
    provider === "telegram" &&
    notifier.capabilities.supportsEdit &&
    !notifier.capabilities.supportsNativeStreaming
  );
}

/**
 * Applies one ack lifecycle transition with deterministic fallback on invalid moves.
 */
export function setConversationAckLifecycleState(
  job: ConversationJob,
  nextState: ConversationAckLifecycleState,
  fallbackErrorCode: string
): void {
  if (job.ackLifecycleState === nextState) {
    return;
  }
  if (!canTransitionAckLifecycleState(job.ackLifecycleState, nextState)) {
    if (canTransitionAckLifecycleState(job.ackLifecycleState, "CANCELLED")) {
      job.ackLifecycleState = "CANCELLED";
    }
    job.ackLastErrorCode = fallbackErrorCode;
    return;
  }
  job.ackLifecycleState = nextState;
}

/**
 * Cancels and removes any active ack timer for a session key.
 */
export function clearConversationAckTimer(
  sessionKey: string,
  ackTimers: Map<string, NodeJS.Timeout>
): void {
  const timer = ackTimers.get(sessionKey);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  ackTimers.delete(sessionKey);
}

/**
 * Enqueues a new job into the session queue and returns the worker-start decision.
 */
export function enqueueConversationJob(
  session: ConversationSession,
  input: string,
  receivedAt: string,
  executionInput: string = input,
  isSystemJob = false
): EnqueueResult {
  const job: ConversationJob = {
    id: makeId("job"),
    input,
    executionInput,
    createdAt: receivedAt,
    startedAt: null,
    completedAt: null,
    status: "queued",
    resultSummary: null,
    errorMessage: null,
    isSystemJob,
    ackTimerGeneration: 0,
    ackEligibleAt: null,
    ackLifecycleState: "NOT_SENT",
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: null,
    finalDeliveryOutcome: "not_attempted",
    finalDeliveryAttemptCount: 0,
    finalDeliveryLastErrorCode: null,
    finalDeliveryLastAttemptAt: null
  };
  session.queuedJobs.push(job);
  session.updatedAt = receivedAt;

  const hadActiveWork = Boolean(session.runningJobId) || session.queuedJobs.length > 1;
  if (hadActiveWork) {
    return {
      shouldStartWorker: false,
      reply: `Queued your request. Queue depth: ${session.queuedJobs.length}. Use /status to monitor progress.`
    };
  }

  return {
    shouldStartWorker: true,
    reply: ""
  };
}
