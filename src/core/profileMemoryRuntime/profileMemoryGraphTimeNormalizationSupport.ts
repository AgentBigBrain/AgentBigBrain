/**
 * @fileoverview Fail-closed graph timestamp and optional-metadata normalization helpers for additive graph state.
 */

import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import { normalizeProfileMemoryGraphClaimLifecycles } from "./profileMemoryGraphClaimLifecycleSupport";
import { normalizeProfileMemoryGraphEventLifecycles } from "./profileMemoryGraphEventLifecycleSupport";
import {
  normalizeProfileMemoryGraphClaimMetadata,
  normalizeProfileMemoryGraphEventMetadata,
  normalizeProfileMemoryGraphObservationMetadata
} from "./profileMemoryGraphMetadataNormalizationSupport";
import {
  normalizeProfileMemoryGraphClaimRecordIdentities,
  normalizeProfileMemoryGraphEventRecordIdentities,
  normalizeProfileMemoryGraphObservationRecordIdentities
} from "./profileMemoryGraphRecordIdentityNormalizationSupport";
import { normalizeProfileMemoryGraphObservationLifecycles } from "./profileMemoryGraphObservationLifecycleSupport";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";

/**
 * Runs bounded observation metadata, timestamp, and lifecycle normalization as one canonical phase.
 *
 * @param input - Canonical observations plus one deterministic fallback timestamp.
 * @returns Repaired observations and whether any payload changed.
 */
export function normalizeProfileMemoryGraphObservationRecords(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  changed: boolean;
} {
  const recordIdentityNormalizationResult = normalizeProfileMemoryGraphObservationRecordIdentities(
    input
  );
  const metadataNormalizationResult = normalizeProfileMemoryGraphObservationMetadata({
    observations: recordIdentityNormalizationResult.nextObservations,
    recordedAt: input.recordedAt
  });
  const timeNormalizationResult = normalizeProfileMemoryGraphObservationTimes({
    observations: metadataNormalizationResult.nextObservations,
    recordedAt: input.recordedAt
  });
  const lifecycleNormalizationResult = normalizeProfileMemoryGraphObservationLifecycles({
    observations: timeNormalizationResult.nextObservations,
    recordedAt: input.recordedAt
  });
  return {
    nextObservations: lifecycleNormalizationResult.nextObservations,
    changed:
      recordIdentityNormalizationResult.changed ||
      metadataNormalizationResult.changed ||
      timeNormalizationResult.changed ||
      lifecycleNormalizationResult.changed
  };
}

/**
 * Runs bounded claim metadata, timestamp, and lifecycle normalization as one canonical phase.
 *
 * @param input - Canonical claims plus one deterministic fallback timestamp.
 * @returns Repaired claims and whether any payload changed.
 */
export function normalizeProfileMemoryGraphClaimRecords(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  const recordIdentityNormalizationResult = normalizeProfileMemoryGraphClaimRecordIdentities(input);
  const metadataNormalizationResult = normalizeProfileMemoryGraphClaimMetadata({
    claims: recordIdentityNormalizationResult.nextClaims,
    recordedAt: input.recordedAt
  });
  const timeNormalizationResult = normalizeProfileMemoryGraphClaimTimes({
    claims: metadataNormalizationResult.nextClaims,
    recordedAt: input.recordedAt
  });
  const lifecycleNormalizationResult = normalizeProfileMemoryGraphClaimLifecycles({
    claims: timeNormalizationResult.nextClaims,
    recordedAt: input.recordedAt
  });
  return {
    nextClaims: lifecycleNormalizationResult.nextClaims,
    changed:
      recordIdentityNormalizationResult.changed ||
      metadataNormalizationResult.changed ||
      timeNormalizationResult.changed ||
      lifecycleNormalizationResult.changed
  };
}

/**
 * Runs bounded event metadata, timestamp, and lifecycle normalization as one canonical phase.
 *
 * @param input - Canonical events plus one deterministic fallback timestamp.
 * @returns Repaired events and whether any payload changed.
 */
export function normalizeProfileMemoryGraphEventRecords(input: {
  events: readonly ProfileMemoryGraphEventRecord[];
  recordedAt: string;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  const recordIdentityNormalizationResult = normalizeProfileMemoryGraphEventRecordIdentities(input);
  const metadataNormalizationResult = normalizeProfileMemoryGraphEventMetadata({
    events: recordIdentityNormalizationResult.nextEvents,
    recordedAt: input.recordedAt
  });
  const timeNormalizationResult = normalizeProfileMemoryGraphEventTimes({
    events: metadataNormalizationResult.nextEvents,
    recordedAt: input.recordedAt
  });
  const lifecycleNormalizationResult = normalizeProfileMemoryGraphEventLifecycles({
    events: timeNormalizationResult.nextEvents,
    recordedAt: input.recordedAt
  });
  return {
    nextEvents: lifecycleNormalizationResult.nextEvents,
    changed:
      recordIdentityNormalizationResult.changed ||
      metadataNormalizationResult.changed ||
      timeNormalizationResult.changed ||
      lifecycleNormalizationResult.changed
  };
}

/**
 * Normalizes malformed retained observation timestamps before lifecycle or replay repair.
 *
 * @param input - Canonical observations plus one deterministic fallback timestamp.
 * @returns Repaired observations and whether any timestamp changed.
 */
export function normalizeProfileMemoryGraphObservationTimes(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextObservations = input.observations.map((observation) => {
    const nextObservation = normalizeProfileMemoryGraphObservationTimeRecord({
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
 * Normalizes malformed retained claim timestamps before lifecycle or replay repair.
 *
 * @param input - Canonical claims plus one deterministic fallback timestamp.
 * @returns Repaired claims and whether any timestamp changed.
 */
export function normalizeProfileMemoryGraphClaimTimes(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextClaims = input.claims.map((claim) => {
    const nextClaim = normalizeProfileMemoryGraphClaimTimeRecord({
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
 * Normalizes malformed retained event timestamps before lifecycle or replay repair.
 *
 * @param input - Canonical events plus one deterministic fallback timestamp.
 * @returns Repaired events and whether any timestamp changed.
 */
export function normalizeProfileMemoryGraphEventTimes(input: {
  events: readonly ProfileMemoryGraphEventRecord[];
  recordedAt: string;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextEvents = input.events.map((event) => {
    const nextEvent = normalizeProfileMemoryGraphEventTimeRecord({
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
 * Repairs one retained observation record when required or optional timestamp fields are malformed.
 *
 * @param input - Candidate observation plus deterministic fallback timestamp.
 * @returns Original observation when timestamps are already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphObservationTimeRecord(input: {
  observation: ProfileMemoryGraphObservationRecord;
  recordedAt: string;
}): ProfileMemoryGraphObservationRecord {
  const { payload } = input.observation;
  const nextAssertedAt = normalizeRequiredIsoTimestamp(payload.assertedAt, input.recordedAt);
  const nextObservedAt = normalizeRequiredIsoTimestamp(payload.observedAt, input.recordedAt);
  const nextRedactedAt = normalizeOptionalIsoTimestamp(payload.redactedAt ?? null);

  if (
    nextAssertedAt === payload.assertedAt &&
    nextObservedAt === payload.observedAt &&
    nextRedactedAt === payload.redactedAt
  ) {
    return input.observation;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.observation,
    schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    payload: {
      ...payload,
      assertedAt: nextAssertedAt,
      observedAt: nextObservedAt,
      redactedAt: nextRedactedAt
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Repairs one retained claim record when required or optional timestamp fields are malformed.
 *
 * @param input - Candidate claim plus deterministic fallback timestamp.
 * @returns Original claim when timestamps are already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphClaimTimeRecord(input: {
  claim: ProfileMemoryGraphClaimRecord;
  recordedAt: string;
}): ProfileMemoryGraphClaimRecord {
  const { payload } = input.claim;
  const nextAssertedAt = normalizeRequiredIsoTimestamp(payload.assertedAt, input.recordedAt);
  const nextValidFrom = normalizeOptionalIsoTimestamp(payload.validFrom);
  const nextValidTo = normalizeOptionalIsoTimestamp(payload.validTo);
  const nextEndedAt = normalizeOptionalIsoTimestamp(payload.endedAt);
  const nextRedactedAt = normalizeOptionalIsoTimestamp(payload.redactedAt ?? null);

  if (
    nextAssertedAt === payload.assertedAt &&
    nextValidFrom === payload.validFrom &&
    nextValidTo === payload.validTo &&
    nextEndedAt === payload.endedAt &&
    nextRedactedAt === payload.redactedAt
  ) {
    return input.claim;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.claim,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...payload,
      assertedAt: nextAssertedAt,
      validFrom: nextValidFrom,
      validTo: nextValidTo,
      endedAt: nextEndedAt,
      redactedAt: nextRedactedAt
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Repairs one retained event record when required or optional timestamp fields are malformed.
 *
 * @param input - Candidate event plus deterministic fallback timestamp.
 * @returns Original event when timestamps are already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphEventTimeRecord(input: {
  event: ProfileMemoryGraphEventRecord;
  recordedAt: string;
}): ProfileMemoryGraphEventRecord {
  const { payload } = input.event;
  const nextAssertedAt = normalizeRequiredIsoTimestamp(payload.assertedAt, input.recordedAt);
  const nextObservedAt = normalizeRequiredIsoTimestamp(payload.observedAt, input.recordedAt);
  const nextValidFrom = normalizeOptionalIsoTimestamp(payload.validFrom);
  const nextValidTo = normalizeOptionalIsoTimestamp(payload.validTo);
  const nextRedactedAt = normalizeOptionalIsoTimestamp(payload.redactedAt ?? null);

  if (
    nextAssertedAt === payload.assertedAt &&
    nextObservedAt === payload.observedAt &&
    nextValidFrom === payload.validFrom &&
    nextValidTo === payload.validTo &&
    nextRedactedAt === payload.redactedAt
  ) {
    return input.event;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.event,
    schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payload: {
      ...payload,
      assertedAt: nextAssertedAt,
      observedAt: nextObservedAt,
      validFrom: nextValidFrom,
      validTo: nextValidTo,
      redactedAt: nextRedactedAt
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Coerces one required timestamp field to canonical ISO format with a bounded fallback.
 *
 * @param value - Persisted required timestamp candidate.
 * @param fallback - Deterministic fallback timestamp.
 * @returns Canonical ISO timestamp string.
 */
function normalizeRequiredIsoTimestamp(value: string, fallback: string): string {
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : fallback;
}

/**
 * Coerces one optional timestamp field to canonical ISO format or clears it fail-closed.
 *
 * @param value - Persisted optional timestamp candidate.
 * @returns Canonical ISO timestamp or `null` when the candidate is malformed.
 */
function normalizeOptionalIsoTimestamp(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : null;
}
