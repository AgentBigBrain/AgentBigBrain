/**
 * @fileoverview Builds the dedicated editable status-panel flow used by long-running conversation jobs.
 */

import type {
  ConversationJob,
  ConversationSession
} from "../sessionStore";
import { createAutonomousProgressSender } from "../transportRuntime/deliveryLifecycle";
import type {
  ConversationExecutionProgressUpdate
} from "./managerContracts";
import type {
  ConversationNotifierTransport
} from "../conversationWorkerLifecycle";
import { buildConversationWorkerProgressMessage } from "./conversationWorkerProgressText";
import { canUseConversationAckTimerForSession } from "./conversationLifecycle";

const AUTONOMOUS_STOPPED_SUMMARY_PATTERNS: readonly RegExp[] = [
  /\brun stopped before it finished\b/i,
  /\bhit a blocker before i could finish\b/i,
  /\bstopped because\b/i,
  /\bdeterministic recovery stopped for\b/i
] as const;

/**
 * Returns whether a queue-completed job actually ended in a blocked autonomous stop state from
 * the user's point of view.
 *
 * @param job - Persisted completed job outcome.
 * @returns `true` when the summary is a blocked terminal autonomous result.
 */
function hasBlockedTerminalSummary(job: ConversationJob): boolean {
  const summary = typeof job.resultSummary === "string" ? job.resultSummary.trim() : "";
  if (!summary) {
    return false;
  }
  return AUTONOMOUS_STOPPED_SUMMARY_PATTERNS.some((pattern) => pattern.test(summary));
}

/**
 * Returns a dedicated editable status sender when the session/transport supports it.
 *
 * @param sessionKey - Provider-scoped session key.
 * @param notify - Active notifier transport.
 * @param job - Running job under evaluation.
 * @returns Editable status sender, or `null` when ack/edit-replace flow should stay active.
 */
export function createPersistentConversationStatusSender(
  sessionKey: string,
  notify: ConversationNotifierTransport,
  job: ConversationJob
): ((message: string) => Promise<void>) | null {
  if (job.isSystemJob === true) {
    return null;
  }
  if (!canUseConversationAckTimerForSession(sessionKey, notify)) {
    return null;
  }
  return createAutonomousProgressSender(notify, {
    source: "worker_status_panel",
    sessionKey,
    jobId: job.id,
    jobCreatedAt: job.createdAt
  });
}

/**
 * Maps structured runtime progress into one concise persistent status-panel update.
 *
 * @param update - Structured progress signal.
 * @returns Human-facing persistent status message.
 */
export function buildPersistentStatusMessage(
  update: ConversationExecutionProgressUpdate
): string {
  const statusLabel = (() => {
    switch (update.status) {
      case "starting":
        return "Thinking";
      case "working":
        return "Working";
      case "retrying":
        return "Working";
      case "verifying":
        return "Verifying";
      case "waiting_for_user":
        return "Waiting on you";
      case "completed":
        return "Done";
      case "stopped":
        return "Blocked";
      default:
        return "Working";
    }
  })();
  return `Status: ${statusLabel}\n${update.message}`;
}

/**
 * Builds the initial status-panel update shown when a queued job begins.
 *
 * @param job - Running job being described.
 * @returns Initial persistent status message.
 */
export function buildInitialPersistentStatusMessage(job: ConversationJob): string {
  return buildPersistentStatusMessage({
    status: "starting",
    message: buildConversationWorkerProgressMessage(job)
  });
}

/**
 * Builds the terminal status-panel update that should remain after final delivery.
 *
 * @param session - Latest persisted session after final delivery.
 * @param job - Persisted job outcome.
 * @returns Terminal persistent status update, or `null` when no final status should be shown.
 */
export function buildTerminalPersistentStatusUpdate(
  session: ConversationSession,
  job: ConversationJob
): ConversationExecutionProgressUpdate | null {
  if (session.progressState?.status === "waiting_for_user" && session.progressState.message) {
    return {
      status: "waiting_for_user",
      message: session.progressState.message
    };
  }
  if (
    job.status === "completed" &&
    (job.finalDeliveryOutcome === "failed" || job.finalDeliveryOutcome === "rate_limited")
  ) {
    const failureCode = job.finalDeliveryLastErrorCode ?? (
      job.finalDeliveryOutcome === "rate_limited"
        ? "TELEGRAM_RATE_LIMITED"
        : "FINAL_DELIVERY_FAILED"
    );
    return {
      status: "completed",
      message:
        job.finalDeliveryOutcome === "rate_limited"
          ? `The work finished, but Telegram rate-limited the full final reply (${failureCode}). Ask me to summarize it again here if you need the full result.`
          : `The work finished, but sending the full final reply here failed (${failureCode}). Ask me to summarize it again or open the result directly.`
    };
  }
  if (job.status === "completed" && !hasBlockedTerminalSummary(job)) {
    return {
      status: "completed",
      message: job.recoveryTrace?.status === "recovered"
        ? "Finished this request after a bounded automatic recovery. The final reply is below."
        : "Finished this request. The final reply is below."
    };
  }
  return {
    status: "stopped",
    message: hasBlockedTerminalSummary(job)
      ? "This run hit a blocker before it could finish. The final reply is below."
      : job.errorMessage?.trim().length
      ? job.recoveryTrace?.status === "failed"
        ? `Blocked after a bounded recovery attempt: ${job.errorMessage}`
        : `Blocked: ${job.errorMessage}`
      : "This run hit a blocker before it could finish."
  };
}
