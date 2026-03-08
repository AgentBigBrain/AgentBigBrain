/**
 * @fileoverview Canonical bounded contracts for human-centric proactive follow-up.
 */

import type { ConversationSession } from "../sessionStore";
import type { EntityGraphV1, PulseCandidateV1 } from "../../core/types";

export interface RelationshipClarificationUtilityRequest {
  anchoredEntityCount: number;
  openLoopCount: number;
  repeatedNegativeOutcomes: number;
}

export interface RelationshipClarificationQualificationRequest {
  candidate: PulseCandidateV1;
  graph: EntityGraphV1;
  recentConversationText: string;
  openLoopCount: number;
  repeatedNegativeOutcomes: number;
}

export interface ContextualTopicCooldownHistoryRecord {
  input: string;
  createdAt: string;
  completedAt: string | null;
}

export interface ProactiveTargetSelection {
  targetSession: ConversationSession | null;
  suppressionCode: ConversationSession["agentPulse"]["lastDecisionCode"] | null;
}
