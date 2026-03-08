/**
 * @fileoverview Canonical contracts for the stable Agent Pulse scheduler entrypoint.
 */

import type { AgentPulseReason } from "../../core/agentPulse";
import type {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult
} from "../../core/profileMemoryStore";
import type { PulseEmissionRecordV1 } from "../../core/stage6_86PulseCandidates";
import type { EntityGraphV1 } from "../../core/types";
import type {
  ConversationSession,
  InterfaceSessionStore
} from "../sessionStore";

export interface AgentPulseStateUpdate {
  optIn?: boolean;
  mode?: ConversationSession["agentPulse"]["mode"];
  routeStrategy?: ConversationSession["agentPulse"]["routeStrategy"];
  lastPulseSentAt?: string | null;
  lastPulseReason?: string | null;
  lastPulseTargetConversationId?: string | null;
  lastDecisionCode?: ConversationSession["agentPulse"]["lastDecisionCode"];
  lastEvaluatedAt?: string | null;
  lastContextualLexicalEvidence?: ConversationSession["agentPulse"]["lastContextualLexicalEvidence"];
  updatedAt?: string;
  newEmission?: PulseEmissionRecordV1;
}

export interface AgentPulseSchedulerDeps {
  provider: "telegram" | "discord";
  sessionStore: InterfaceSessionStore;
  evaluateAgentPulse: (
    request: AgentPulseEvaluationRequest
  ) => Promise<AgentPulseEvaluationResult>;
  enqueueSystemJob: (
    session: ConversationSession,
    systemInput: string,
    receivedAt: string
  ) => Promise<boolean>;
  updatePulseState: (
    conversationKey: string,
    update: AgentPulseStateUpdate
  ) => Promise<void>;
  enableDynamicPulse?: boolean;
  getEntityGraph?: () => Promise<EntityGraphV1>;
}

export interface AgentPulseSchedulerConfig {
  tickIntervalMs: number;
  reasonPriority: AgentPulseReason[];
}

export type ApplyPulseStateToUserSessions = (
  userSessions: ConversationSession[],
  update: AgentPulseStateUpdate
) => Promise<void>;

export const DEFAULT_AGENT_PULSE_SCHEDULER_CONFIG: AgentPulseSchedulerConfig = {
  tickIntervalMs: 120_000,
  reasonPriority: ["unresolved_commitment", "stale_fact_revalidation", "contextual_followup"]
};
