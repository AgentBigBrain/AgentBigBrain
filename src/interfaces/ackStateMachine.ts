/**
 * @fileoverview Defines deterministic ack/final-delivery lifecycle helpers for conversation jobs.
 */

import {
  ConversationAckLifecycleState,
  ConversationFinalDeliveryOutcome,
  ConversationJob
} from "./sessionStore";

export const ACK_TERMINAL_STATES: readonly ConversationAckLifecycleState[] = [
  "REPLACED",
  "FINAL_SENT_NO_EDIT",
  "CANCELLED"
] as const;

const ACK_EDITABLE_STATES = new Set<ConversationAckLifecycleState>(["SENT"]);
const RATE_LIMIT_ERROR_CODES = new Set<string>([
  "RATE_LIMITED",
  "TELEGRAM_RATE_LIMITED",
  "DISCORD_RATE_LIMITED"
]);

export interface AckEligibilityDecision {
  eligible: boolean;
  reasonCode: string | null;
}

export interface AckInvariantDecision {
  ok: boolean;
  reasonCode: string | null;
}

/**
 * Evaluates ack terminal state and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the ack terminal state policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ConversationAckLifecycleState` (import `ConversationAckLifecycleState`) from `./sessionStore`.
 *
 * @param state - Value for state.
 * @returns `true` when this check passes.
 */
export function isAckTerminalState(state: ConversationAckLifecycleState): boolean {
  return ACK_TERMINAL_STATES.includes(state);
}

/**
 * Evaluates transition ack lifecycle state and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the transition ack lifecycle state policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ConversationAckLifecycleState` (import `ConversationAckLifecycleState`) from `./sessionStore`.
 *
 * @param current - Value for current.
 * @param next - Value for next.
 * @returns `true` when this check passes.
 */
export function canTransitionAckLifecycleState(
  current: ConversationAckLifecycleState,
  next: ConversationAckLifecycleState
): boolean {
  if (current === next) {
    return true;
  }
  if (isAckTerminalState(current)) {
    return false;
  }

  if (current === "NOT_SENT") {
    return next === "SENT" || next === "FINAL_SENT_NO_EDIT" || next === "CANCELLED";
  }
  if (current === "SENT") {
    return next === "REPLACED" || next === "FINAL_SENT_NO_EDIT" || next === "CANCELLED";
  }
  return false;
}

/**
 * Applies deterministic validity checks for ack invariants.
 *
 * **Why it exists:**
 * Fails fast when ack invariants is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `ConversationJob` (import `ConversationJob`) from `./sessionStore`.
 *
 * @param job - Value for job.
 * @returns Computed `AckInvariantDecision` result.
 */
export function assertAckInvariants(job: ConversationJob): AckInvariantDecision {
  if (job.ackLifecycleState === "SENT" && !job.ackMessageId) {
    return {
      ok: false,
      reasonCode: "ACK_MESSAGE_ID_MISSING"
    };
  }

  if (
    job.finalDeliveryOutcome === "sent" &&
    job.ackLifecycleState !== "REPLACED" &&
    job.ackLifecycleState !== "FINAL_SENT_NO_EDIT"
  ) {
    return {
      ok: false,
      reasonCode: "FINAL_SENT_WITH_NON_TERMINAL_ACK_STATE"
    };
  }

  if (
    job.finalDeliveryOutcome !== "not_attempted" &&
    job.finalDeliveryAttemptCount <= 0
  ) {
    return {
      ok: false,
      reasonCode: "FINAL_DELIVERY_ATTEMPT_COUNT_MISSING"
    };
  }

  return {
    ok: true,
    reasonCode: null
  };
}

/**
 * Derives ack eligibility from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for ack eligibility in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `ConversationJob` (import `ConversationJob`) from `./sessionStore`.
 *
 * @param job - Value for job.
 * @param nowIso - Timestamp used for ordering, timeout, or recency decisions.
 * @param supportsEdit - Value for supports edit.
 * @returns Computed `AckEligibilityDecision` result.
 */
export function deriveAckEligibility(
  job: ConversationJob,
  nowIso: string,
  supportsEdit: boolean
): AckEligibilityDecision {
  if (!supportsEdit) {
    return {
      eligible: false,
      reasonCode: "ACK_EDIT_UNSUPPORTED"
    };
  }

  if (isAckTerminalState(job.ackLifecycleState)) {
    return {
      eligible: false,
      reasonCode: "ACK_ALREADY_TERMINAL"
    };
  }

  if (job.finalDeliveryOutcome !== "not_attempted" || job.finalDeliveryAttemptCount > 0) {
    return {
      eligible: false,
      reasonCode: "FINAL_DELIVERY_ALREADY_ATTEMPTED"
    };
  }

  if (!job.ackEligibleAt) {
    return {
      eligible: false,
      reasonCode: "ACK_ELIGIBILITY_TIMESTAMP_MISSING"
    };
  }

  const nowMs = Date.parse(nowIso);
  const eligibleAtMs = Date.parse(job.ackEligibleAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(eligibleAtMs)) {
    return {
      eligible: false,
      reasonCode: "ACK_ELIGIBILITY_TIMESTAMP_INVALID"
    };
  }

  if (nowMs < eligibleAtMs) {
    return {
      eligible: false,
      reasonCode: "ACK_DELAY_NOT_REACHED"
    };
  }

  return {
    eligible: true,
    reasonCode: null
  };
}

/**
 * Evaluates edit ack message and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the edit ack message policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ConversationJob` (import `ConversationJob`) from `./sessionStore`.
 *
 * @param job - Value for job.
 * @returns `true` when this check passes.
 */
export function canEditAckMessage(job: ConversationJob): boolean {
  return ACK_EDITABLE_STATES.has(job.ackLifecycleState) && Boolean(job.ackMessageId);
}

/**
 * Evaluates rate limited error code and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the rate limited error code policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param errorCode - Value for error code.
 * @returns `true` when this check passes.
 */
export function isRateLimitedErrorCode(errorCode: string | null | undefined): boolean {
  if (!errorCode) {
    return false;
  }
  return RATE_LIMIT_ERROR_CODES.has(errorCode);
}

/**
 * Evaluates final delivery terminal and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the final delivery terminal policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ConversationFinalDeliveryOutcome` (import `ConversationFinalDeliveryOutcome`) from `./sessionStore`.
 *
 * @param outcome - Value for outcome.
 * @returns `true` when this check passes.
 */
export function isFinalDeliveryTerminal(
  outcome: ConversationFinalDeliveryOutcome
): boolean {
  return outcome === "sent" || outcome === "rate_limited" || outcome === "failed";
}

