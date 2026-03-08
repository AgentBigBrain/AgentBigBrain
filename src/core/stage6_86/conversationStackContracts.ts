/**
 * @fileoverview Shared Stage 6.86 conversation-stack contracts for the extracted subsystem.
 */

import type { ConversationStackV1, SessionSchemaVersionV1 } from "../types";

export interface ConversationStackTurnV1 {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface ApplyConversationTurnOptionsV1 {
  activeMissionThreadKey?: string | null;
  maxThreads?: number;
  topicSwitchThreshold?: number;
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
