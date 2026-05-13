/**
 * @fileoverview Normalizes persisted conversation-turn metadata records.
 */

import type {
  ConversationAssistantTurnKind,
  ConversationTurn,
  ConversationTurnMetadata,
  ConversationTurnMetadataSource
} from "./sessionStateContracts";
import { normalizeConversationTurnActorMetadata } from "./sessionNormalizationTurnActorMetadata";
import { normalizeConversationTurnSourceRecallMetadata } from "./sessionNormalizationSourceRecallRecords";

/**
 * Implements `normalizeAssistantTurnKind` behavior within this module.
 */
function normalizeAssistantTurnKind(value: unknown): ConversationAssistantTurnKind | null {
  return value === "clarification" ||
    value === "informational_answer" ||
    value === "workflow_progress" ||
    value === "other"
    ? value
    : null;
}

/**
 * Implements `normalizeConversationTurnMetadataSource` behavior within this module.
 */
function normalizeConversationTurnMetadataSource(
  value: unknown
): ConversationTurnMetadataSource | null {
  return value === "runtime_metadata" || value === "legacy_text_inference"
    ? value
    : null;
}

/**
 * Normalizes optional turn metadata without allowing malformed legacy payloads to poison turns.
 */
export function normalizeConversationTurnMetadata(
  turn: Partial<ConversationTurn>
): ConversationTurnMetadata | undefined {
  const metadata = turn.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const assistantTurnKind = normalizeAssistantTurnKind(metadata.assistantTurnKind);
  const assistantTurnKindSource = normalizeConversationTurnMetadataSource(
    metadata.assistantTurnKindSource
  );
  const actor = normalizeConversationTurnActorMetadata(metadata.actor);
  const sourceRecall = normalizeConversationTurnSourceRecallMetadata(metadata.sourceRecall);
  if (!sourceRecall && !actor && (!assistantTurnKind || !assistantTurnKindSource)) {
    return undefined;
  }
  return {
    ...(assistantTurnKind && assistantTurnKindSource
      ? { assistantTurnKind, assistantTurnKindSource }
      : {}),
    ...(actor ? { actor } : {}),
    ...(sourceRecall ? { sourceRecall } : {})
  };
}
