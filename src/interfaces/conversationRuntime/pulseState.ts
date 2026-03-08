/**
 * @fileoverview Owns persisted Agent Pulse session-state updates for the interface runtime.
 */

import type { PulseEmissionRecordV1 } from "../../core/stage6_86PulseCandidates";
import { appendPulseEmission } from "./sessionPulseMetadata";
import {
  type AgentPulseDecisionCode,
  type AgentPulseMode,
  type AgentPulseRouteStrategy,
  type ConversationSession,
  InterfaceSessionStore
} from "../sessionStore";

export interface ConversationAgentPulseStateUpdate {
  optIn: boolean;
  mode: AgentPulseMode;
  routeStrategy: AgentPulseRouteStrategy;
  lastPulseSentAt: string | null;
  lastPulseReason: string | null;
  lastPulseTargetConversationId: string | null;
  lastDecisionCode: AgentPulseDecisionCode;
  lastEvaluatedAt: string | null;
  lastContextualLexicalEvidence: ConversationSession["agentPulse"]["lastContextualLexicalEvidence"];
  updatedAt: string;
  newEmission: PulseEmissionRecordV1;
}

export interface UpdateConversationAgentPulseStateInput {
  conversationKey: string;
  update: Partial<ConversationAgentPulseStateUpdate>;
  store: InterfaceSessionStore;
}

/**
 * Applies a partial Agent Pulse state update for one conversation session.
 *
 * @param input - Target session key, persisted store, and partial pulse-state patch.
 */
export async function updateConversationAgentPulseState(
  input: UpdateConversationAgentPulseStateInput
): Promise<void> {
  const { conversationKey, update, store } = input;
  const session = await store.getSession(conversationKey);
  if (!session) {
    return;
  }

  if (typeof update.optIn === "boolean") {
    session.agentPulse.optIn = update.optIn;
  }
  if (update.mode === "private" || update.mode === "public") {
    session.agentPulse.mode = update.mode;
  }
  if (
    update.routeStrategy === "last_private_used" ||
    update.routeStrategy === "current_conversation"
  ) {
    session.agentPulse.routeStrategy = update.routeStrategy;
  }
  if ("lastPulseSentAt" in update) {
    session.agentPulse.lastPulseSentAt = update.lastPulseSentAt ?? null;
  }
  if ("lastPulseReason" in update) {
    session.agentPulse.lastPulseReason = update.lastPulseReason ?? null;
  }
  if ("lastPulseTargetConversationId" in update) {
    session.agentPulse.lastPulseTargetConversationId = update.lastPulseTargetConversationId ?? null;
  }
  if (update.lastDecisionCode) {
    session.agentPulse.lastDecisionCode = update.lastDecisionCode;
  }
  if ("lastEvaluatedAt" in update) {
    session.agentPulse.lastEvaluatedAt = update.lastEvaluatedAt ?? null;
  }
  if ("lastContextualLexicalEvidence" in update) {
    session.agentPulse.lastContextualLexicalEvidence =
      update.lastContextualLexicalEvidence ?? null;
  }
  if (update.newEmission) {
    appendPulseEmission(session.agentPulse, update.newEmission);
  }
  if (typeof update.updatedAt === "string" && update.updatedAt.trim()) {
    session.updatedAt = update.updatedAt;
  }

  await store.setSession(session);
}
