/**
 * @fileoverview Fail-closed graph record-id and retained-reference normalization helpers.
 */

import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

/**
 * Repairs retained observation ids and id-like refs so padded persisted payloads do not survive as
 * canonical graph identity.
 *
 * @param input - Canonical observations plus one deterministic fallback timestamp.
 * @returns Repaired observations and whether any record identity changed.
 */
export function normalizeProfileMemoryGraphObservationRecordIdentities(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextObservations = input.observations.map((observation) => {
    const nextObservation = normalizeProfileMemoryGraphObservationRecordIdentity({
      observation,
      recordedAt: input.recordedAt
    });
    if (nextObservation !== observation) {
      changed = true;
    }
    return nextObservation;
  });
  return {
    nextObservations,
    changed
  };
}

/**
 * Repairs retained claim ids and id-like refs so padded persisted payloads do not survive as
 * canonical graph identity.
 *
 * @param input - Canonical claims plus one deterministic fallback timestamp.
 * @returns Repaired claims and whether any record identity changed.
 */
export function normalizeProfileMemoryGraphClaimRecordIdentities(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextClaims = input.claims.map((claim) => {
    const nextClaim = normalizeProfileMemoryGraphClaimRecordIdentity({
      claim,
      recordedAt: input.recordedAt
    });
    if (nextClaim !== claim) {
      changed = true;
    }
    return nextClaim;
  });
  return {
    nextClaims,
    changed
  };
}

/**
 * Repairs retained event ids and id-like refs so padded persisted payloads do not survive as
 * canonical graph identity.
 *
 * @param input - Canonical events plus one deterministic fallback timestamp.
 * @returns Repaired events and whether any record identity changed.
 */
export function normalizeProfileMemoryGraphEventRecordIdentities(input: {
  events: readonly ProfileMemoryGraphEventRecord[];
  recordedAt: string;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextEvents = input.events.map((event) => {
    const nextEvent = normalizeProfileMemoryGraphEventRecordIdentity({
      event,
      recordedAt: input.recordedAt
    });
    if (nextEvent !== event) {
      changed = true;
    }
    return nextEvent;
  });
  return {
    nextEvents,
    changed
  };
}

/**
 * Trims one required graph record or reference id and fails closed on blank payloads.
 *
 * @param value - Required graph id candidate.
 * @returns Trimmed canonical id or `null` when the candidate is blank or malformed.
 */
export function normalizeRequiredProfileMemoryGraphId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Trims one optional graph record or reference id and fails closed on blank payloads.
 *
 * @param value - Optional graph id candidate.
 * @returns Trimmed canonical id or `null` when the candidate is blank or malformed.
 */
export function normalizeOptionalProfileMemoryGraphId(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return normalizeRequiredProfileMemoryGraphId(value);
}

/**
 * Trims, deduplicates, and sorts one graph-id array so padded retained refs cannot survive as
 * canonical graph lineage.
 *
 * @param values - Candidate graph ids.
 * @returns Sorted unique canonical graph ids only.
 */
export function normalizeProfileMemoryGraphIdArray(values: readonly string[]): string[] {
  return [...new Set(
    values.flatMap((value) => {
      if (typeof value !== "string") {
        return [];
      }
      const normalizedValue = normalizeRequiredProfileMemoryGraphId(value);
      return normalizedValue === null ? [] : [normalizedValue];
    })
  )].sort((left, right) => left.localeCompare(right));
}

/**
 * Repairs one retained observation record when canonical graph identity or retained refs are padded.
 *
 * @param input - Candidate observation plus deterministic fallback timestamp.
 * @returns Original observation when canonical ids are already trimmed, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphObservationRecordIdentity(input: {
  observation: ProfileMemoryGraphObservationRecord;
  recordedAt: string;
}): ProfileMemoryGraphObservationRecord {
  const { payload } = input.observation;
  const nextObservationId =
    normalizeRequiredProfileMemoryGraphId(payload.observationId) ?? payload.observationId;
  const nextEntityRefIds = normalizeProfileMemoryGraphIdArray(payload.entityRefIds);

  if (
    nextObservationId === payload.observationId &&
    arraysEqual(nextEntityRefIds, payload.entityRefIds)
  ) {
    return input.observation;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.observation,
    schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    payload: {
      ...payload,
      observationId: nextObservationId,
      entityRefIds: nextEntityRefIds
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Repairs one retained claim record when canonical graph identity or retained refs are padded.
 *
 * @param input - Candidate claim plus deterministic fallback timestamp.
 * @returns Original claim when canonical ids are already trimmed, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphClaimRecordIdentity(input: {
  claim: ProfileMemoryGraphClaimRecord;
  recordedAt: string;
}): ProfileMemoryGraphClaimRecord {
  const { payload } = input.claim;
  const nextClaimId =
    normalizeRequiredProfileMemoryGraphId(payload.claimId) ?? payload.claimId;
  const nextEndedByClaimId = normalizeOptionalProfileMemoryGraphId(payload.endedByClaimId);
  const nextDerivedFromObservationIds = normalizeProfileMemoryGraphIdArray(
    payload.derivedFromObservationIds
  );
  const nextProjectionSourceIds = normalizeProfileMemoryGraphIdArray(payload.projectionSourceIds);
  const nextEntityRefIds = normalizeProfileMemoryGraphIdArray(payload.entityRefIds);

  if (
    nextClaimId === payload.claimId &&
    nextEndedByClaimId === payload.endedByClaimId &&
    arraysEqual(nextDerivedFromObservationIds, payload.derivedFromObservationIds) &&
    arraysEqual(nextProjectionSourceIds, payload.projectionSourceIds) &&
    arraysEqual(nextEntityRefIds, payload.entityRefIds)
  ) {
    return input.claim;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.claim,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...payload,
      claimId: nextClaimId,
      endedByClaimId: nextEndedByClaimId,
      derivedFromObservationIds: nextDerivedFromObservationIds,
      projectionSourceIds: nextProjectionSourceIds,
      entityRefIds: nextEntityRefIds
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Repairs one retained event record when canonical graph identity or retained refs are padded.
 *
 * @param input - Candidate event plus deterministic fallback timestamp.
 * @returns Original event when canonical ids are already trimmed, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphEventRecordIdentity(input: {
  event: ProfileMemoryGraphEventRecord;
  recordedAt: string;
}): ProfileMemoryGraphEventRecord {
  const { payload } = input.event;
  const nextEventId =
    normalizeRequiredProfileMemoryGraphId(payload.eventId) ?? payload.eventId;
  const nextDerivedFromObservationIds = normalizeProfileMemoryGraphIdArray(
    payload.derivedFromObservationIds
  );
  const nextProjectionSourceIds = normalizeProfileMemoryGraphIdArray(payload.projectionSourceIds);
  const nextEntityRefIds = normalizeProfileMemoryGraphIdArray(payload.entityRefIds);

  if (
    nextEventId === payload.eventId &&
    arraysEqual(nextDerivedFromObservationIds, payload.derivedFromObservationIds) &&
    arraysEqual(nextProjectionSourceIds, payload.projectionSourceIds) &&
    arraysEqual(nextEntityRefIds, payload.entityRefIds)
  ) {
    return input.event;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.event,
    schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payload: {
      ...payload,
      eventId: nextEventId,
      derivedFromObservationIds: nextDerivedFromObservationIds,
      projectionSourceIds: nextProjectionSourceIds,
      entityRefIds: nextEntityRefIds
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Checks whether two string arrays already match exactly in deterministic order.
 *
 * @param left - Left array.
 * @param right - Right array.
 * @returns `true` when both arrays already match.
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
