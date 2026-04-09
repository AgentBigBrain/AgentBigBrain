/**
 * @fileoverview Entity-ref pruning helpers for additive profile-memory graph state.
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
 * Prunes duplicate entity refs from retained graph observations, claims, and events.
 *
 * **Why it exists:**
 * Older retained graph payloads can carry repeated `entityRefIds`, which would otherwise survive in
 * canonical graph state even after index rebuild dedupes its buckets. This helper keeps the
 * payloads themselves canonical so later retention, repair, and audit consumers do not need to
 * special-case duplicate entity refs.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses graph schema-name constants from `./profileMemoryGraphContracts`.
 *
 * @param input - Surviving graph records plus a deterministic repair timestamp.
 * @returns Canonical graph records with sorted unique entity refs only.
 */
export function pruneProfileMemoryGraphEntityRefs(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  nextClaims: ProfileMemoryGraphClaimRecord[];
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  const nextObservations = input.observations.map((observation) =>
    pruneObservationEntityRefs(observation, input.recordedAt)
  );
  const nextClaims = input.claims.map((claim) => pruneClaimEntityRefs(claim, input.recordedAt));
  const nextEvents = input.events.map((event) => pruneEventEntityRefs(event, input.recordedAt));

  return {
    nextObservations,
    nextClaims,
    nextEvents,
    changed:
      nextObservations.some((observation, index) => observation !== input.observations[index]) ||
      nextClaims.some((claim, index) => claim !== input.claims[index]) ||
      nextEvents.some((event, index) => event !== input.events[index])
  };
}

/**
 * Prunes duplicate entity refs from one observation payload.
 *
 * **Why it exists:**
 * Observation payloads are canonical graph records, so duplicate `entityRefIds` should be repaired
 * once here instead of leaking through later inventory or audit readers.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME` from `./profileMemoryGraphContracts`.
 *
 * @param observation - Canonical observation record to normalize.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Original observation when unchanged, otherwise a repaired observation envelope.
 */
function pruneObservationEntityRefs(
  observation: ProfileMemoryGraphObservationRecord,
  recordedAt: string
): ProfileMemoryGraphObservationRecord {
  const entityRefIds = dedupeSortedStrings(observation.payload.entityRefIds);
  if (arraysEqual(entityRefIds, observation.payload.entityRefIds)) {
    return observation;
  }
  return rebuildProfileMemoryGraphEnvelope({
    record: observation,
    schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    payload: {
      ...observation.payload,
      entityRefIds
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Prunes duplicate entity refs from one claim payload.
 *
 * **Why it exists:**
 * Claim payloads are canonical current or historical truth records, so duplicate `entityRefIds`
 * should not survive beyond normalization.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME` from `./profileMemoryGraphContracts`.
 *
 * @param claim - Canonical claim record to normalize.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Original claim when unchanged, otherwise a repaired claim envelope.
 */
function pruneClaimEntityRefs(
  claim: ProfileMemoryGraphClaimRecord,
  recordedAt: string
): ProfileMemoryGraphClaimRecord {
  const entityRefIds = dedupeSortedStrings(claim.payload.entityRefIds);
  if (arraysEqual(entityRefIds, claim.payload.entityRefIds)) {
    return claim;
  }
  return rebuildProfileMemoryGraphEnvelope({
    record: claim,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...claim.payload,
      entityRefIds
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Prunes duplicate entity refs from one event payload.
 *
 * **Why it exists:**
 * Event payloads are canonical graph records too, and repeated `entityRefIds` would otherwise leak
 * malformed lineage into later reads even after index buckets are deduped.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME` from `./profileMemoryGraphContracts`.
 *
 * @param event - Canonical event record to normalize.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Original event when unchanged, otherwise a repaired event envelope.
 */
function pruneEventEntityRefs(
  event: ProfileMemoryGraphEventRecord,
  recordedAt: string
): ProfileMemoryGraphEventRecord {
  const entityRefIds = dedupeSortedStrings(event.payload.entityRefIds);
  if (arraysEqual(entityRefIds, event.payload.entityRefIds)) {
    return event;
  }
  return rebuildProfileMemoryGraphEnvelope({
    record: event,
    schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payload: {
      ...event.payload,
      entityRefIds
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Deduplicates and sorts one string collection.
 *
 * **Why it exists:**
 * The graph state wants canonical ordered payload arrays so downstream readers do not need to
 * reason about repeated refs.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Candidate string values.
 * @returns Sorted unique string values only.
 */
function dedupeSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Checks whether two string arrays already match exactly.
 *
 * **Why it exists:**
 * Normalization should preserve object identity when nothing changed so later change checks stay
 * cheap and deterministic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Left array.
 * @param right - Right array.
 * @returns `true` when both arrays already match exactly.
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
