/** @fileoverview Small helpers for recording assistant turns inside conversation routing. */

import { recordAssistantTurnWithSourceRecall } from "../conversationSessionMutations";
import type { ConversationSession, ConversationAssistantTurnKind } from "../sessionStore";
import type { ConversationSourceRecallCaptureDependencies } from "./managerContracts";

/**
 * Records a routing-owned assistant turn with structured turn-kind metadata.
 *
 * **Why it exists:**
 * The routing entrypoint needs to stamp assistant-turn authority without repeating the same
 * mutation-call boilerplate across clarification, status, and informational branches.
 *
 * **What it talks to:**
 * - Uses `recordAssistantTurnWithSourceRecall` from `../conversationSessionMutations`.
 *
 * @param session - Session receiving the assistant turn.
 * @param text - Assistant text to append.
 * @param receivedAt - Timestamp for the turn.
 * @param maxConversationTurns - Maximum retained turn count.
 * @param assistantTurnKind - Structured assistant-turn kind attached to metadata.
 * @param sourceRecallCapture - Optional lower-authority Source Recall capture dependencies.
 */
export async function recordRoutingAssistantTurn(
  session: ConversationSession,
  text: string,
  receivedAt: string,
  maxConversationTurns: number,
  assistantTurnKind: ConversationAssistantTurnKind,
  sourceRecallCapture: ConversationSourceRecallCaptureDependencies | null = null
): Promise<void> {
  await recordAssistantTurnWithSourceRecall(session, text, receivedAt, maxConversationTurns, {
    assistantTurnKind,
    sourceRecallCapture
  });
}
