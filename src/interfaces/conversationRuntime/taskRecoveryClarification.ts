/**
 * @fileoverview Detects recoverable task blockers that should become persisted user clarifications instead of terminal dead ends.
 */

import type { TaskRunResult } from "../../core/types";
import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import { deriveWorkspaceRecoverySignal } from "../../core/autonomy/workspaceRecoveryPolicy";
import type { ActiveClarificationState } from "../sessionStore";
import { createTaskRecoveryClarificationState } from "./clarificationBroker";

export interface TaskRecoveryClarificationResult {
  clarification: ActiveClarificationState | null;
  reply: string;
}

/**
 * Builds a persisted clarification when a local organization request can continue after the user
 * confirms the next safe recovery step.
 *
 * **Why it exists:**
 * A lock failure should not strand the user in a terminal blocked summary when the runtime still
 * has a safe next step it can attempt with explicit confirmation.
 *
 * **What it talks to:**
 * - Uses `createTaskRecoveryClarificationState` (import `createTaskRecoveryClarificationState`) from `./clarificationBroker`.
 * - Uses local helpers within this module.
 *
 * @param taskRunResult - Completed task result being persisted to the conversation session.
 * @param requestedAt - Timestamp used for the persisted clarification state.
 * @returns Recovery reply plus optional persisted clarification state, or `null` when no recovery prompt applies.
 */
export function deriveTaskRecoveryClarification(
  taskRunResult: TaskRunResult,
  requestedAt: string
): TaskRecoveryClarificationResult | null {
  const sourceInput =
    extractActiveRequestSegment(taskRunResult.task.userInput).trim() ||
    taskRunResult.task.userInput;
  const recoverySignal = deriveWorkspaceRecoverySignal(taskRunResult);
  if (!recoverySignal) {
    return null;
  }

  if (recoverySignal.recommendedAction === "stop_no_live_holders_found") {
    return {
      clarification: null,
      reply: recoverySignal.question
    };
  }

  const clarificationOptions =
    recoverySignal.recommendedAction === "stop_exact_tracked_holders" ||
    recoverySignal.recommendedAction === "clarify_before_exact_non_preview_shutdown" ||
    recoverySignal.recommendedAction === "clarify_before_likely_non_preview_shutdown"
      ? [
          {
            id: "retry_with_shutdown" as const,
            label: "Yes, shut them down and retry"
          },
          {
            id: "cancel" as const,
            label: "No, leave them alone"
          }
        ]
      : [
          {
            id: "continue_recovery" as const,
            label: "Yes, inspect and continue"
          },
          {
            id: "cancel" as const,
            label: "No, leave them alone"
          }
        ];

  return {
    clarification: createTaskRecoveryClarificationState(
      sourceInput,
      requestedAt,
      recoverySignal.question,
      recoverySignal.matchedRuleId,
      recoverySignal.recoveryInstruction,
      clarificationOptions
    ),
    reply: recoverySignal.question
  };
}
