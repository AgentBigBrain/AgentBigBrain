/**
 * @fileoverview Normalization, payload-salvage, and guard helpers for additive profile-memory
 * graph state.
 */

import {
  createSchemaEnvelopeV1,
  isSchemaEnvelopeV1,
  verifySchemaEnvelopeV1
} from "../schemaEnvelope";
import type { SchemaEnvelopeV1 } from "../types";
import type { ProfileMemoryGraphCompactionStateV1 } from "./profileMemoryGraphContracts";

/**
 * Normalizes one array of schema-enveloped graph records with fail-closed payload validation and
 * bounded enum-like payload salvage.
 *
 * @param input - Raw persisted envelope array plus the expected schema contract.
 * @returns Verified graph record envelopes only.
 */
export function normalizeGraphEnvelopeArray<TPayload>(input: {
  raw: unknown;
  expectedSchemaName: string;
  payloadNormalizer: (value: unknown) => TPayload | null;
  recordId: (payload: TPayload) => string | null;
  fallbackCreatedAt: string;
}): SchemaEnvelopeV1<TPayload>[] {
  if (!Array.isArray(input.raw)) {
    return [];
  }
  const deduped = new Map<string, SchemaEnvelopeV1<TPayload>>();
  for (const value of input.raw) {
    if (!isSchemaEnvelopeV1<TPayload>(value) || !verifySchemaEnvelopeV1(value)) {
      continue;
    }
    if (value.schemaName !== input.expectedSchemaName) {
      continue;
    }
    const normalizedPayload = input.payloadNormalizer(value.payload);
    if (normalizedPayload === null) {
      continue;
    }
    const recordId = input.recordId(normalizedPayload);
    if (typeof recordId !== "string") {
      continue;
    }
    const canonicalRecordId = recordId.trim();
    if (canonicalRecordId.length === 0) {
      continue;
    }
    const normalizedEnvelope = createSchemaEnvelopeV1(
      input.expectedSchemaName,
      normalizedPayload,
      normalizeEnvelopeCreatedAt(value.createdAt, input.fallbackCreatedAt)
    );
    const existing = deduped.get(canonicalRecordId);
    if (!existing || compareEnvelopeFreshness(existing, normalizedEnvelope) < 0) {
      deduped.set(canonicalRecordId, normalizedEnvelope);
    }
  }
  return [...deduped.values()];
}

/**
 * Normalizes persisted graph compaction settings into a bounded deterministic shape.
 *
 * @param raw - Unknown persisted compaction payload.
 * @returns Stable compaction settings.
 */
export function normalizeProfileMemoryGraphCompactionState(
  raw: unknown
): ProfileMemoryGraphCompactionStateV1 {
  const empty = createDefaultProfileMemoryGraphCompactionState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return empty;
  }
  const candidate = raw as Partial<ProfileMemoryGraphCompactionStateV1>;
  return {
    schemaVersion: "v1",
    snapshotWatermark:
      typeof candidate.snapshotWatermark === "number" &&
      Number.isInteger(candidate.snapshotWatermark) &&
      candidate.snapshotWatermark >= 0
        ? candidate.snapshotWatermark
        : empty.snapshotWatermark,
    lastCompactedAt: normalizeOptionalIsoTimestamp(candidate.lastCompactedAt),
    maxObservationCount: normalizePositiveInteger(
      candidate.maxObservationCount,
      empty.maxObservationCount
    ),
    maxClaimCount: normalizePositiveInteger(candidate.maxClaimCount, empty.maxClaimCount),
    maxEventCount: normalizePositiveInteger(candidate.maxEventCount, empty.maxEventCount),
    maxJournalEntries: normalizePositiveInteger(
      candidate.maxJournalEntries,
      empty.maxJournalEntries
    )
  };
}

/**
 * Creates default bounded graph compaction settings for early persistence.
 *
 * @returns Default compaction settings.
 */
export function createDefaultProfileMemoryGraphCompactionState(): ProfileMemoryGraphCompactionStateV1 {
  return {
    schemaVersion: "v1",
    snapshotWatermark: 0,
    lastCompactedAt: null,
    maxObservationCount: 2048,
    maxClaimCount: 2048,
    maxEventCount: 1024,
    maxJournalEntries: 4096
  };
}

/**
 * Normalizes one positive-integer config candidate with a bounded fallback.
 *
 * @param value - Unknown integer candidate.
 * @param fallback - Fallback integer when the candidate is invalid.
 * @returns Stable positive integer.
 */
function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Coerces one retained graph-envelope timestamp to canonical ISO format with a deterministic
 * fallback.
 *
 * @param value - Persisted envelope timestamp candidate.
 * @param fallbackCreatedAt - Fallback timestamp from graph normalization.
 * @returns Canonical ISO timestamp string.
 */
function normalizeEnvelopeCreatedAt(value: string, fallbackCreatedAt: string): string {
  const fallback = normalizeComparableEnvelopeTimestamp(fallbackCreatedAt);
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : fallback;
}

/**
 * Coerces one optional persisted compaction timestamp to canonical ISO format or clears it
 * fail-closed.
 *
 * @param value - Persisted optional timestamp candidate.
 * @returns Canonical ISO timestamp or `null` when invalid.
 */
function normalizeOptionalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : null;
}

/**
 * Compares two schema envelopes so normalization can keep one deterministic winner for duplicate
 * canonical record ids.
 *
 * @param left - Existing normalized envelope.
 * @param right - Incoming normalized envelope.
 * @returns Positive when `left` is fresher, negative when `right` is fresher.
 */
function compareEnvelopeFreshness<TPayload>(
  left: SchemaEnvelopeV1<TPayload>,
  right: SchemaEnvelopeV1<TPayload>
): number {
  const leftTimestamp = normalizeComparableEnvelopeTimestamp(left.createdAt);
  const rightTimestamp = normalizeComparableEnvelopeTimestamp(right.createdAt);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp.localeCompare(rightTimestamp);
  }
  return left.hash.localeCompare(right.hash);
}

/**
 * Normalizes one graph-envelope timestamp so duplicate-id freshness comparisons stay deterministic
 * even when retained timestamps are malformed.
 *
 * @param value - Persisted envelope timestamp.
 * @returns Comparable timestamp string.
 */
function normalizeComparableEnvelopeTimestamp(value: string): string {
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : trimmed;
}
