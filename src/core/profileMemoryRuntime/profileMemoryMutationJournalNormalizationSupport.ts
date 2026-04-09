/**
 * @fileoverview Shared retained mutation-journal metadata and timestamp normalization helpers.
 */

import type { ProfileMemoryMutationJournalEntryV1 } from "./profileMemoryGraphContracts";

/**
 * Trims one raw mutation-journal redaction-state candidate into the bounded canonical vocabulary.
 *
 * @param value - Unknown candidate.
 * @returns Canonical redaction state, or `null` when invalid.
 */
export function normalizeJournalRedactionStateCandidate(
  value: unknown
): ProfileMemoryMutationJournalEntryV1["redactionState"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "not_requested" || trimmed === "requested" || trimmed === "redacted"
    ? trimmed
    : null;
}

/**
 * Repairs one required retained journal timestamp into canonical ISO format with a deterministic
 * fallback.
 *
 * @param value - Persisted required timestamp candidate.
 * @param fallbackRecordedAt - Deterministic fallback timestamp from graph normalization.
 * @returns Canonical journal timestamp.
 */
export function normalizeRequiredRecordedAt(value: unknown, fallbackRecordedAt: string): string {
  const fallback = normalizeRecordedAtForComparison(fallbackRecordedAt);
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : fallback;
}

/**
 * Trims one required metadata string and clears whitespace-only values fail-closed.
 *
 * @param value - Unknown metadata candidate.
 * @returns Trimmed string or `null` when the candidate is blank or malformed.
 */
export function normalizeRequiredMetadataString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Trims one optional metadata string and clears whitespace-only values fail-closed.
 *
 * @param value - Optional metadata candidate.
 * @returns Trimmed string or `null` when the candidate is blank or malformed.
 */
export function normalizeOptionalMetadataString(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes one recorded-at timestamp so malformed persisted journal entries still compare
 * deterministically during fail-closed repair.
 *
 * @param value - Persisted recorded-at timestamp.
 * @returns Comparable timestamp string.
 */
export function normalizeRecordedAtForComparison(value: string): string {
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : trimmed;
}
