/** @fileoverview Small turn-recording helpers shared by the stable conversation-routing entrypoint. */

import type { TopicKeyInterpretationSignalV1 } from "../../core/stage6_86ConversationStack";
import { recordUserTurn } from "../conversationSessionMutations";
import type { ConversationSession } from "../sessionStore";

/**
 * Records a user turn while preserving topic-key interpretation metadata for later continuity use.
 *
 * @param session - Mutable conversation session receiving the new user turn.
 * @param input - Raw user text.
 * @param receivedAt - Timestamp attached to the user turn.
 * @param maxConversationTurns - Session turn-retention bound.
 * @param topicKeyInterpretation - Optional topic-key interpretation captured for this turn.
 */
export function recordTopicAwareUserTurn(
  session: ConversationSession,
  input: string,
  receivedAt: string,
  maxConversationTurns: number,
  topicKeyInterpretation: TopicKeyInterpretationSignalV1 | null
): void {
  recordUserTurn(session, input, receivedAt, maxConversationTurns, { topicKeyInterpretation });
}
