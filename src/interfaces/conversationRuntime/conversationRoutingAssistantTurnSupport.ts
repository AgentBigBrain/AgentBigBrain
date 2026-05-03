/** @fileoverview Small helpers for recording assistant turns inside conversation routing. */

import { recordAssistantTurn } from "../conversationSessionMutations";
import type { ConversationSession, ConversationAssistantTurnKind } from "../sessionStore";

/**
 * Records a routing-owned assistant turn with structured turn-kind metadata.
 *
 * **Why it exists:**
 * The routing entrypoint needs to stamp assistant-turn authority without repeating the same
 * mutation-call boilerplate across clarification, status, and informational branches.
 *
 * **What it talks to:**
 * - Uses `recordAssistantTurn` (import `recordAssistantTurn`) from `../conversationSessionMutations`.
 *
 * @param session - Session receiving the assistant turn.
 * @param text - Assistant text to append.
 * @param receivedAt - Timestamp for the turn.
 * @param maxConversationTurns - Maximum retained turn count.
 * @param assistantTurnKind - Structured assistant-turn kind attached to metadata.
 */
export function recordRoutingAssistantTurn(
  session: ConversationSession,
  text: string,
  receivedAt: string,
  maxConversationTurns: number,
  assistantTurnKind: ConversationAssistantTurnKind
): void {
  recordAssistantTurn(session, text, receivedAt, maxConversationTurns, {
    assistantTurnKind
  });
}
