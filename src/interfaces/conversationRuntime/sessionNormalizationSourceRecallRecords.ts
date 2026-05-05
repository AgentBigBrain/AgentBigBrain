/**
 * @fileoverview Source Recall metadata normalization for persisted conversation turns.
 */

import type { ConversationTurnSourceRecallMetadata } from "./sessionStateContracts";

/**
 * Normalizes Source Recall metadata attached to persisted conversation turns.
 *
 * @param value - Persisted Source Recall metadata candidate.
 * @returns Canonical Source Recall metadata or `null` when malformed.
 */
export function normalizeConversationTurnSourceRecallMetadata(
  value: unknown
): ConversationTurnSourceRecallMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<ConversationTurnSourceRecallMetadata>;
  if (
    (candidate.status !== "captured" &&
      candidate.status !== "blocked" &&
      candidate.status !== "failed") ||
    (candidate.sourceKind !== "conversation_turn" &&
      candidate.sourceKind !== "assistant_turn" &&
      candidate.sourceKind !== "task_input" &&
      candidate.sourceKind !== "task_summary") ||
    (candidate.sourceRole !== "user" &&
      candidate.sourceRole !== "assistant" &&
      candidate.sourceRole !== "runtime") ||
    (candidate.captureClass !== "ordinary_source" &&
      candidate.captureClass !== "assistant_output" &&
      candidate.captureClass !== "operational_output") ||
    (candidate.sourceTimeKind !== "observed_event" &&
      candidate.sourceTimeKind !== "captured_record" &&
      candidate.sourceTimeKind !== "generated_summary" &&
      candidate.sourceTimeKind !== "unknown") ||
    typeof candidate.sourceRefAvailable !== "boolean"
  ) {
    return null;
  }
  return {
    status: candidate.status,
    sourceKind: candidate.sourceKind,
    sourceRole: candidate.sourceRole,
    captureClass: candidate.captureClass,
    sourceTimeKind: candidate.sourceTimeKind,
    sourceRefAvailable: candidate.sourceRefAvailable,
    sourceRecordId:
      typeof candidate.sourceRecordId === "string" && candidate.sourceRecordId.trim().length > 0
        ? candidate.sourceRecordId.trim()
        : undefined,
    capturedAt:
      typeof candidate.capturedAt === "string" && candidate.capturedAt.trim().length > 0
        ? candidate.capturedAt
        : undefined,
    diagnosticErrorCode:
      typeof candidate.diagnosticErrorCode === "string" &&
      candidate.diagnosticErrorCode.trim().length > 0
        ? candidate.diagnosticErrorCode
        : undefined
  };
}
