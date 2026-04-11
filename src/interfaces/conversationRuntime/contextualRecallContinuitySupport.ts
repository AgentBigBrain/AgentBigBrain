/**
 * @fileoverview Shared continuity-result helpers for bounded contextual recall synthesis.
 */

import type { ProfileFactStatus } from "../../core/profileMemory";
import type { ProfileReadableFact } from "../../core/profileMemoryRuntime/contracts";
import { buildProfileFactContinuityFallbackTemporalSlice } from "../../core/profileMemoryRuntime/profileMemoryFactContinuitySupport";
import { synthesizeProfileMemoryTemporalEvidence } from "../../core/profileMemoryRuntime/profileMemoryTemporalSynthesis";
import type {
  ProfileMemoryTemporalRelevanceScope,
  ProfileMemoryTemporalSemanticMode
} from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import type { MemorySynthesisFactRecord } from "../../organs/memorySynthesis/contracts";
import { toLaneBoundary } from "../../organs/memorySynthesis/temporalSynthesisAdapterCompatibilitySupport";
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
 * Normalizes one continuity fact record into the readable-fact shape used by temporal fallback
 * synthesis.
 *
 * **Why it exists:**
 * Contextual recall still accepts flat continuity arrays from older callers, so fallback temporal
 * synthesis needs one deterministic projection into the core readable-fact contract instead of
 * open-coding that adapter in multiple runtime helpers.
 *
 * **What it talks to:**
 * - Uses local continuity fact fields only.
 *
 * @param fact - Continuity fact under projection.
 * @returns Readable-fact shape suitable for compatibility temporal fallback synthesis.
 */
function toReadableContinuityFact(
  fact: ConversationContinuityFactRecord
): ProfileReadableFact {
  return {
    factId: fact.factId,
    key: fact.key,
    value: fact.value,
    status: normalizeContinuityFactStatus(fact.status),
    sensitive: false,
    observedAt: fact.observedAt,
    lastUpdatedAt: fact.lastUpdatedAt,
    confidence: fact.confidence
  };
}

/**
 * Normalizes one continuity fact status onto the bounded readable-fact contract.
 *
 * **Why it exists:**
 * Continuity fact records use a string surface for transport compatibility, but fallback temporal
 * synthesis expects the stricter profile-fact status union. Unknown values fail closed to
 * `uncertain` instead of widening the core contract.
 *
 * **What it talks to:**
 * - Uses local string guards only.
 *
 * @param status - Continuity fact status under normalization.
 * @returns Canonical bounded fact status.
 */
function normalizeContinuityFactStatus(status: string): ProfileFactStatus {
  if (status === "confirmed" || status === "uncertain" || status === "superseded") {
    return status;
  }
  return "uncertain";
}

/**
 * Ensures contextual recall sees one structured continuity-fact result with typed temporal
 * synthesis, even when an older caller still returned a flat fact array.
 *
 * **Why it exists:**
 * Phase 4 retires live compatibility overloads from recall synthesis, so older continuity callers
 * must be normalized into one structured temporal result before recall rendering decisions happen.
 *
 * **What it talks to:**
 * - Uses `buildProfileFactContinuityFallbackTemporalSlice` (import) from
 *   `../../core/profileMemoryRuntime/profileMemoryFactContinuitySupport`.
 * - Uses `synthesizeProfileMemoryTemporalEvidence` (import) from
 *   `../../core/profileMemoryRuntime/profileMemoryTemporalSynthesis`.
 * - Uses local `isStructuredContinuityFactResult(...)`.
 *
 * @param value - Continuity fact response under normalization.
 * @param fallback - Typed metadata used when the response is still a flat array.
 * @returns Structured continuity fact result with typed temporal synthesis metadata attached.
 */
export function ensureStructuredContinuityFactResult(
  value: readonly ConversationContinuityFactRecord[] | ConversationContinuityFactResult,
  fallback: {
    semanticMode: ProfileMemoryTemporalSemanticMode;
    relevanceScope: ProfileMemoryTemporalRelevanceScope;
    scopedThreadKeys?: readonly string[];
    asOfValidTime?: string;
    asOfObservedTime?: string;
  }
): ConversationContinuityFactResult {
  if (isStructuredContinuityFactResult(value)) {
    return value;
  }

  const readableFacts = value.map(toReadableContinuityFact);
  const temporalSlice = buildProfileFactContinuityFallbackTemporalSlice(readableFacts, {
    semanticMode: fallback.semanticMode,
    relevanceScope: fallback.relevanceScope,
    asOfValidTime: fallback.asOfValidTime,
    asOfObservedTime: fallback.asOfObservedTime
  });
  const temporalSynthesis =
    temporalSlice.focusEntities.length > 0
      ? synthesizeProfileMemoryTemporalEvidence(temporalSlice)
      : null;
  const scopedThreadKeys = [...(fallback.scopedThreadKeys ?? [])];
  const laneBoundaries = temporalSynthesis
    ? temporalSynthesis.laneMetadata.map((lane) =>
        toLaneBoundary(lane, {
          semanticMode: fallback.semanticMode,
          relevanceScope: fallback.relevanceScope,
          scopedThreadKeys
        })
      )
    : [];

  return Object.assign([...value], {
    semanticMode: fallback.semanticMode,
    relevanceScope: fallback.relevanceScope,
    scopedThreadKeys,
    temporalSynthesis,
    laneBoundaries
  }) as unknown as ConversationContinuityFactResult;
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
