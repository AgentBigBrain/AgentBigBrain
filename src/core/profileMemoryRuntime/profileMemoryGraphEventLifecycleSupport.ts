/**
 * @fileoverview Fail-closed event lifecycle normalization helpers for additive graph state.
 */

import type { ProfileMemoryGraphEventRecord } from "./profileMemoryGraphContracts";
import { PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME } from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

const REDACTED_EVENT_TITLE = "[redacted episode]";
const REDACTED_EVENT_SUMMARY = "[redacted episode details]";

/**
 * Normalizes malformed active or redacted event lifecycle boundaries during load normalization and
 * live graph writes.
 *
 * @param input - Canonical event records plus one deterministic repair timestamp.
 * @returns Repaired event records and whether any lifecycle payload changed.
 */
export function normalizeProfileMemoryGraphEventLifecycles(input: {
  events: readonly ProfileMemoryGraphEventRecord[];
  recordedAt: string;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextEvents = input.events
    .map((event) => {
      const nextEvent = normalizeProfileMemoryGraphEventLifecycleRecord({
        event,
        recordedAt: input.recordedAt
      });
      if (nextEvent !== event) {
        changed = true;
      }
      return nextEvent;
    })
    .sort(compareEventRecords);

  return {
    nextEvents,
    changed
  };
}

/**
 * Repairs one event record when redaction state and closure timestamps disagree.
 *
 * @param input - Candidate event plus repair timestamp.
 * @returns Original event when already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphEventLifecycleRecord(input: {
  event: ProfileMemoryGraphEventRecord;
  recordedAt: string;
}): ProfileMemoryGraphEventRecord {
  const { payload } = input.event;
  const isRedacted = payload.redactionState === "redacted";
  const nextStableRefId = isRedacted ? null : payload.stableRefId;
  const nextValidTo = isRedacted
    ? selectEventClosureBoundary({
        validTo: payload.validTo,
        redactedAt: payload.redactedAt ?? null,
        fallback: input.recordedAt
      })
    : payload.validTo;
  const nextRedactedAt = isRedacted ? payload.redactedAt ?? nextValidTo : null;
  const nextTitle = isRedacted ? REDACTED_EVENT_TITLE : payload.title;
  const nextSummary = isRedacted ? REDACTED_EVENT_SUMMARY : payload.summary;
  const nextSensitive = isRedacted ? true : payload.sensitive;
  const nextDerivedFromObservationIds = isRedacted ? [] : payload.derivedFromObservationIds;
  const nextEntityRefIds = isRedacted ? [] : payload.entityRefIds;

  if (
    nextStableRefId === payload.stableRefId &&
    nextValidTo === payload.validTo &&
    nextRedactedAt === payload.redactedAt &&
    nextTitle === payload.title &&
    nextSummary === payload.summary &&
    nextSensitive === payload.sensitive &&
    arrayEquals(nextDerivedFromObservationIds, payload.derivedFromObservationIds) &&
    arrayEquals(nextEntityRefIds, payload.entityRefIds)
  ) {
    return input.event;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.event,
    schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payload: {
      ...payload,
      stableRefId: nextStableRefId,
      title: nextTitle,
      summary: nextSummary,
      redactedAt: nextRedactedAt,
      sensitive: nextSensitive,
      validTo: nextValidTo,
      derivedFromObservationIds: nextDerivedFromObservationIds,
      entityRefIds: nextEntityRefIds
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Selects one canonical closure boundary for redacted events.
 *
 * @param input - Candidate closure timestamps plus deterministic fallback.
 * @returns Earliest surviving closure timestamp, or the fallback when none exist.
 */
function selectEventClosureBoundary(input: {
  validTo: string | null;
  redactedAt: string | null;
  fallback: string;
}): string {
  const candidates = [input.validTo, input.redactedAt]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return candidates[0] ?? input.fallback;
}

/**
 * Checks whether two bounded string arrays already match.
 *
 * @param left - Left candidate array.
 * @param right - Right candidate array.
 * @returns `true` when both arrays are equal.
 */
function arrayEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Orders graph events deterministically after lifecycle repair.
 *
 * @param left - Left event record.
 * @param right - Right event record.
 * @returns Stable ordering result.
 */
function compareEventRecords(
  left: ProfileMemoryGraphEventRecord,
  right: ProfileMemoryGraphEventRecord
): number {
  if (left.payload.observedAt !== right.payload.observedAt) {
    return left.payload.observedAt.localeCompare(right.payload.observedAt);
  }
  return left.payload.eventId.localeCompare(right.payload.eventId);
}
