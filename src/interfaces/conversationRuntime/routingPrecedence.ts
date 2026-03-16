/**
 * @fileoverview Canonical routing-precedence helpers for the human-centric execution front door.
 */

import type { ConversationSession } from "../sessionStore";
import { hasActiveClarification } from "./clarificationState";

export const CONVERSATION_ROUTING_PRECEDENCE = [
  "slash_command",
  "voice_command_phrase",
  "active_clarification",
  "proposal_follow_up",
  "natural_intent_resolution",
  "media_only_fallback"
] as const;

export type ConversationRoutingPrecedenceStage =
  (typeof CONVERSATION_ROUTING_PRECEDENCE)[number];

/**
 * Returns whether active clarification must outrank generic follow-up heuristics for this session.
 *
 * @param session - Session being routed through the conversation front door.
 * @returns Whether the active clarification state should consume the next user turn first.
 */
export function shouldResolveActiveClarificationFirst(
  session: Pick<ConversationSession, "activeClarification">
): boolean {
  return hasActiveClarification(session);
}
