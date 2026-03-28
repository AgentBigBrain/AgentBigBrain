/**
 * @fileoverview Shared Stage 6.86 conversation-stack contracts for the extracted subsystem.
 */

import type { ConversationStackV1, SessionSchemaVersionV1 } from "../types";

export interface ConversationStackTurnV1 {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export type TopicKeyInterpretationKindV1 =
  | "retain_active_thread"
  | "resume_paused_thread"
  | "switch_topic_candidate"
  | "non_topic_turn"
  | "uncertain";

export interface TopicKeyInterpretationSignalV1 {
  kind: TopicKeyInterpretationKindV1;
  selectedTopicKey: string | null;
  selectedThreadKey: string | null;
  confidence: "low" | "medium" | "high";
}

export interface ApplyConversationTurnOptionsV1 {
  activeMissionThreadKey?: string | null;
  maxThreads?: number;
  topicSwitchThreshold?: number;
  topicKeyInterpretation?: TopicKeyInterpretationSignalV1 | null;
}

export interface ConversationStackMigrationInputV1 {
  sessionSchemaVersion: SessionSchemaVersionV1 | null;
  updatedAt: string;
  conversationTurns: readonly ConversationStackTurnV1[];
  conversationStack: ConversationStackV1 | null;
  activeMissionThreadKey?: string | null;
  maxThreads?: number;
}

export interface ConversationStackMigrationResultV1 {
  sessionSchemaVersion: "v2";
  conversationStack: ConversationStackV1;
  migrationApplied: boolean;
  migrationReason: "ALREADY_V2" | "REFRESHED_FROM_TURNS" | "LEGACY_SCHEMA" | "MISSING_STACK";
}
