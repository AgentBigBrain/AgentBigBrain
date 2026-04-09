/**
 * @fileoverview Observation-lineage pruning helpers for additive profile-memory graph state.
 */

import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

/**
 * Prunes duplicate or dangling observation-lineage refs from retained graph claims and events.
 *
 * @param input - Surviving observations plus retained claims and events.
 * @returns Canonical graph records with observation lineage limited to surviving observation ids.
 */
export function pruneProfileMemoryGraphObservationLineage(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  const observationsById = new Map(
    input.observations.map((observation) => [observation.payload.observationId, observation] as const)
  );
  const nextClaims = input.claims.map((claim) =>
    pruneClaimObservationLineage(claim, observationsById, input.recordedAt)
  );
  const nextEvents = input.events.map((event) =>
    pruneEventObservationLineage(event, observationsById, input.recordedAt)
  );

  return {
    nextClaims,
    nextEvents,
    changed:
      nextClaims.some((claim, index) => claim !== input.claims[index]) ||
      nextEvents.some((event, index) => event !== input.events[index])
  };
}

/**
 * Prunes one claim's observation lineage down to surviving observation ids.
 *
 * @param claim - Canonical claim record to normalize.
 * @param validObservationIds - Surviving observation ids.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Original claim when unchanged, otherwise a repaired claim envelope.
 */
function pruneClaimObservationLineage(
  claim: ProfileMemoryGraphClaimRecord,
  observationsById: ReadonlyMap<string, ProfileMemoryGraphObservationRecord>,
  recordedAt: string
): ProfileMemoryGraphClaimRecord {
  const nextDerivedFromObservationIds = dedupeSortedObservationIds(
    claim.payload.derivedFromObservationIds,
    observationsById,
    (observation) => shouldDropClaimObservationLineageObservation(claim, observation)
  );
  if (arraysEqual(nextDerivedFromObservationIds, claim.payload.derivedFromObservationIds)) {
    return claim;
  }
  return rebuildProfileMemoryGraphEnvelope({
    record: claim,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...claim.payload,
      derivedFromObservationIds: nextDerivedFromObservationIds
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Prunes one event's observation lineage down to surviving observation ids.
 *
 * @param event - Canonical event record to normalize.
 * @param validObservationIds - Surviving observation ids.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Original event when unchanged, otherwise a repaired event envelope.
 */
function pruneEventObservationLineage(
  event: ProfileMemoryGraphEventRecord,
  observationsById: ReadonlyMap<string, ProfileMemoryGraphObservationRecord>,
  recordedAt: string
): ProfileMemoryGraphEventRecord {
  const nextDerivedFromObservationIds = dedupeSortedObservationIds(
    event.payload.derivedFromObservationIds,
    observationsById,
    shouldDropEventObservationLineageObservation
  );
  if (arraysEqual(nextDerivedFromObservationIds, event.payload.derivedFromObservationIds)) {
    return event;
  }
  return rebuildProfileMemoryGraphEnvelope({
    record: event,
    schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payload: {
      ...event.payload,
      derivedFromObservationIds: nextDerivedFromObservationIds
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Deduplicates and prunes one observation-lineage array against surviving observation ids.
 *
 * @param values - Candidate observation ids.
 * @param validObservationIds - Surviving observation ids.
 * @returns Sorted unique surviving observation ids only.
 */
function dedupeSortedObservationIds(
  values: readonly string[],
  observationsById: ReadonlyMap<string, ProfileMemoryGraphObservationRecord>,
  shouldDropObservation: (observation: ProfileMemoryGraphObservationRecord) => boolean = () => false
): string[] {
  return [...new Set(
    values.filter((value) => {
      const observation = observationsById.get(value);
      return observation !== undefined && !shouldDropObservation(observation);
    })
  )]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Evaluates whether one surviving observation ref stays on the claim semantic lane but disagrees
 * with the claim's normalized current value.
 *
 * @param claim - Canonical retained claim under lineage repair.
 * @param observation - Surviving observation referenced by that claim.
 * @returns `true` when the ref should fail closed out of canonical claim lineage.
 */
function isSemanticallyConflictingClaimObservationLineage(
  claim: ProfileMemoryGraphClaimRecord,
  observation: ProfileMemoryGraphObservationRecord
): boolean {
  return (
    observation.payload.family === claim.payload.family &&
    observation.payload.normalizedKey === claim.payload.normalizedKey &&
    observation.payload.normalizedValue !== claim.payload.normalizedValue
  );
}

/**
 * Evaluates whether one redacted observation still qualifies as deleted-fact-support lineage on a
 * retained redacted claim.
 *
 * @param claim - Canonical retained redacted claim under lineage repair.
 * @param observation - Surviving observation referenced by that claim.
 * @returns `true` when the observation remains valid redacted support lineage.
 */
function isRedactedClaimSupportingObservation(
  claim: ProfileMemoryGraphClaimRecord,
  observation: ProfileMemoryGraphObservationRecord
): boolean {
  return (
    observation.payload.redactionState === "redacted" &&
    observation.payload.family === claim.payload.family &&
    observation.payload.normalizedKey === claim.payload.normalizedKey &&
    observation.payload.normalizedValue === claim.payload.normalizedValue
  );
}

/**
 * Evaluates whether one retained observation ref should fail closed out of claim lineage.
 *
 * @param claim - Canonical retained claim under lineage repair.
 * @param observation - Surviving observation referenced by that claim.
 * @returns `true` when the ref should be removed from canonical claim lineage.
 */
function shouldDropClaimObservationLineageObservation(
  claim: ProfileMemoryGraphClaimRecord,
  observation: ProfileMemoryGraphObservationRecord
): boolean {
  if (claim.payload.redactionState === "redacted") {
    return !isRedactedClaimSupportingObservation(claim, observation);
  }
  if (observation.payload.redactionState === "redacted") {
    return true;
  }
  return isSemanticallyConflictingClaimObservationLineage(claim, observation);
}

/**
 * Evaluates whether one retained observation ref should fail closed out of event lineage.
 *
 * @param observation - Surviving observation referenced by one retained event.
 * @returns `true` when the ref should be removed from canonical event lineage.
 */
function shouldDropEventObservationLineageObservation(
  observation: ProfileMemoryGraphObservationRecord
): boolean {
  return observation.payload.redactionState === "redacted";
}

/**
 * Checks whether two string arrays already match exactly.
 *
 * @param left - Left array.
 * @param right - Right array.
 * @returns `true` when the arrays already match.
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
