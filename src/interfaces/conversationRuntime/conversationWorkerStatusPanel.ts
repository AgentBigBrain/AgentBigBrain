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
  return createAutonomousProgressSender(notify);
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
  if (job.status === "completed") {
    return {
      status: "completed",
      message: "Finished this request. The final reply is below."
    };
  }
  return {
    status: "stopped",
    message: job.errorMessage?.trim().length
      ? `Blocked: ${job.errorMessage}`
      : "This run hit a blocker before it could finish."
  };
}
