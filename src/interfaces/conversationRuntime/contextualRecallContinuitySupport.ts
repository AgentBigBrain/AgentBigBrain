/**
 * @fileoverview Shared continuity-result helpers for bounded contextual recall synthesis.
 */

import type { MemorySynthesisFactRecord } from "../../organs/memorySynthesis/contracts";
import type {
  ConversationContinuityFactRecord,
  ConversationContinuityFactResult
} from "./continuityContracts";

/**
 * Checks whether one continuity-fact response carries the Phase 6.5 structured temporal metadata.
 *
 * **Why it exists:**
 * Contextual recall still accepts both legacy flat arrays and Phase 6.5 structured results, so
 * the narrowing logic stays centralized instead of being repeated across recall helpers.
 *
 * **What it talks to:**
 * - Uses continuity contracts from `./continuityContracts`.
 *
 * @param value - Continuity-fact response under evaluation.
 * @returns `true` when structured continuity metadata is present.
 */
export function isStructuredContinuityFactResult(
  value: readonly ConversationContinuityFactRecord[] | ConversationContinuityFactResult
): value is ConversationContinuityFactResult {
  return "temporalSynthesis" in value;
}

/**
 * Converts one continuity fact into the bounded memory-synthesis fact shape.
 *
 * **Why it exists:**
 * Contextual recall adapts continuity facts into the synthesis contract, so this projection stays
 * deterministic and shared across recall entrypoints.
 *
 * **What it talks to:**
 * - Uses `MemorySynthesisFactRecord` (import type) from `../../organs/memorySynthesis/contracts`.
 *
 * @param fact - Continuity fact under projection.
 * @returns Memory-synthesis fact record.
 */
export function toMemorySynthesisFactRecord(
  fact: ConversationContinuityFactRecord
): MemorySynthesisFactRecord {
  return {
    factId: fact.factId,
    key: fact.key,
    value: fact.value,
    status: fact.status,
    observedAt: fact.observedAt,
    lastUpdatedAt: fact.lastUpdatedAt,
    confidence: fact.confidence
  };
}

/**
 * Deduplicates resolved recall hints while preserving their original order.
 *
 * **Why it exists:**
 * Several contextual-recall hint sources feed one bounded query, so normalization and dedupe need
 * to stay consistent before ranking and synthesis.
 *
 * **What it talks to:**
 * - Uses local string normalization only.
 *
 * @param hints - Candidate recall hints from reference resolution or media continuity.
 * @returns Lowercased ordered hint list with duplicates removed.
 */
export function dedupeRecallHints(hints: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const hint of hints) {
    const normalized = hint.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}
