/**
 * @fileoverview Fail-closed observation redaction normalization helpers for additive graph state.
 */

import type { ProfileMemoryGraphObservationRecord } from "./profileMemoryGraphContracts";
import { PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME } from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

/**
 * Normalizes malformed redaction boundaries on retained graph observations during load
 * normalization and live graph writes.
 *
 * @param input - Canonical observation records plus one deterministic repair timestamp.
 * @returns Repaired observation records and whether any payload changed.
 */
export function normalizeProfileMemoryGraphObservationLifecycles(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextObservations = input.observations
    .map((observation) => {
      const nextObservation = normalizeProfileMemoryGraphObservationLifecycleRecord({
        observation,
        recordedAt: input.recordedAt
      });
      if (nextObservation !== observation) {
        changed = true;
      }
      return nextObservation;
    })
    .sort(compareObservationRecords);

  return {
    nextObservations,
    changed
  };
}

/**
 * Repairs one observation record when retained redaction metadata disagrees with the payload.
 *
 * @param input - Candidate observation plus repair timestamp.
 * @returns Original observation when already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphObservationLifecycleRecord(input: {
  observation: ProfileMemoryGraphObservationRecord;
  recordedAt: string;
}): ProfileMemoryGraphObservationRecord {
  const { payload } = input.observation;
  const isRedacted = payload.redactionState === "redacted";
  const nextStableRefId = isRedacted ? null : payload.stableRefId;
  const nextNormalizedValue = isRedacted ? null : payload.normalizedValue;
  const nextRedactedAt = isRedacted ? payload.redactedAt ?? input.recordedAt : null;
  const nextSensitive = isRedacted ? true : payload.sensitive;
  const nextEntityRefIds = isRedacted ? [] : payload.entityRefIds;

  if (
    nextStableRefId === payload.stableRefId &&
    nextNormalizedValue === payload.normalizedValue &&
    nextRedactedAt === payload.redactedAt &&
    nextSensitive === payload.sensitive &&
    arraysEqual(nextEntityRefIds, payload.entityRefIds)
  ) {
    return input.observation;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.observation,
    schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    payload: {
      ...payload,
      stableRefId: nextStableRefId,
      normalizedValue: nextNormalizedValue,
      redactedAt: nextRedactedAt,
      sensitive: nextSensitive,
      entityRefIds: nextEntityRefIds
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Checks whether two bounded string arrays already match.
 *
 * @param left - Left candidate array.
 * @param right - Right candidate array.
 * @returns `true` when both arrays already match.
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Orders graph observations deterministically after lifecycle repair.
 *
 * @param left - Left observation record.
 * @param right - Right observation record.
 * @returns Stable ordering result.
 */
function compareObservationRecords(
  left: ProfileMemoryGraphObservationRecord,
  right: ProfileMemoryGraphObservationRecord
): number {
  if (left.payload.observedAt !== right.payload.observedAt) {
    return left.payload.observedAt.localeCompare(right.payload.observedAt);
  }
  return left.payload.observationId.localeCompare(right.payload.observationId);
}
