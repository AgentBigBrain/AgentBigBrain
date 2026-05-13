/**
 * @fileoverview Canonical clarification-state helpers for the human-centric execution front door.
 */

import type { ConversationSession } from "../sessionStore";
import { canCurrentSessionControlRecord } from "../conversationSessionMutations";
import {
  isClarificationExpired,
  resolveClarificationAnswer,
  type ClarificationResolutionResult
} from "./clarificationBroker";

export const CLARIFICATION_CONTROLLER_MISMATCH_REPLY =
  "That clarification is waiting for the person who started it.";

export type ActiveClarificationRoutingGate =
  | {
      state: "none";
      clarification: null;
      answer: null;
    }
  | {
      state: "expired" | "blocked" | "allowed";
      clarification: NonNullable<ConversationSession["activeClarification"]>;
      answer: ClarificationResolutionResult | null;
    };

/**
 * Returns `true` when the session is waiting on a previously asked clarification question.
 *
 * @param session - Session whose clarification state should be checked.
 * @returns Whether the session has an active clarification.
 */
export function hasActiveClarification(
  session: Pick<ConversationSession, "activeClarification">
): boolean {
  return session.activeClarification !== null;
}

/**
 * Returns the active clarification question for a session, if one exists.
 *
 * @param session - Session whose clarification prompt should be read.
 * @returns Active clarification question, or `null` when none is pending.
 */
export function getActiveClarificationQuestion(
  session: Pick<ConversationSession, "activeClarification">
): string | null {
  return session.activeClarification?.question ?? null;
}

/**
 * Evaluates the active clarification before routing can treat a user turn as an answer.
 */
export function evaluateActiveClarificationRoutingGate(
  session: ConversationSession,
  userInput: string,
  receivedAt: string
): ActiveClarificationRoutingGate {
  const clarification = session.activeClarification;
  if (!clarification) {
    return {
      state: "none",
      clarification: null,
      answer: null
    };
  }
  if (isClarificationExpired(clarification, receivedAt)) {
    return {
      state: "expired",
      clarification,
      answer: null
    };
  }
  if (!canCurrentSessionControlRecord(session, clarification.controller)) {
    return {
      state: "blocked",
      clarification,
      answer: null
    };
  }
  return {
    state: "allowed",
    clarification,
    answer: resolveClarificationAnswer(clarification, userInput)
  };
}
