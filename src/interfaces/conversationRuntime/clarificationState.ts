/**
 * @fileoverview Canonical clarification-state helpers for the human-centric execution front door.
 */

import type { ConversationSession } from "../sessionStore";

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
