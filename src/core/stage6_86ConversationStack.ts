/**
 * @fileoverview Stable compatibility entrypoint for the canonical Stage 6.86 conversation-stack subsystem.
 */

export {
  applyAssistantTurnToConversationStackV1,
  applyUserTurnToConversationStackV1,
  buildConversationStackFromTurnsV1,
  createEmptyConversationStackV1,
  deriveTopicKeyCandidatesV1,
  isConversationStackV1,
  isOpenLoopV1,
  migrateSessionConversationStackToV2,
  type ApplyConversationTurnOptionsV1,
  type ConversationStackMigrationInputV1,
  type ConversationStackMigrationResultV1,
  type ConversationStackTurnV1
} from "./stage6_86/conversationStack";
