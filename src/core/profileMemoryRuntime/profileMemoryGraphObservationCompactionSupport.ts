/**
 * @fileoverview Bounded observation-retention helpers for additive profile-memory graph state.
 */

import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphCompactionStateV1,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";
import { isProfileMemoryGraphEventActiveSurfaceEligible } from "./profileMemoryGraphEventSurfaceEligibilitySupport";

/**
 * Enforces bounded observation retention while preserving replay-safe observations still referenced
 * by retained journal entries or surviving graph claims.
 *
 * @param input - Current observations plus retained claim and journal references.
 * @returns Compacted observation state and any compaction-state update.
 */
export function compactProfileMemoryGraphObservations(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
  mutationJournal: ProfileMemoryMutationJournalStateV1;
  compaction: ProfileMemoryGraphCompactionStateV1;
  recordedAt: string;
  validEpisodeProjectionSourceIds?: ReadonlySet<string>;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  nextCompaction: ProfileMemoryGraphCompactionStateV1;
  changed: boolean;
} {
  const nextObservations = selectRetainedProfileMemoryGraphObservations(input);
  if (nextObservations.length === input.observations.length) {
    return {
      nextObservations,
      nextCompaction: input.compaction,
      changed: false
    };
  }

  return {
    nextObservations,
    nextCompaction: {
      ...input.compaction,
      lastCompactedAt: input.recordedAt
    },
    changed: nextObservations.length !== input.observations.length
  };
}

/**
 * Selects the bounded observation records that should survive current retention rules.
 *
 * @param input - Current observations plus retained claim, event, and journal references.
 * @returns Canonical surviving observation records.
 */
export function selectRetainedProfileMemoryGraphObservations(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
  mutationJournal: ProfileMemoryMutationJournalStateV1;
  compaction: ProfileMemoryGraphCompactionStateV1;
  validEpisodeProjectionSourceIds?: ReadonlySet<string>;
}): ProfileMemoryGraphObservationRecord[] {
  if (input.observations.length <= input.compaction.maxObservationCount) {
    return [...input.observations];
  }

  const protectedObservationIds = collectProtectedObservationIds(
    input.observations,
    input.claims,
    input.events,
    input.mutationJournal,
    input.validEpisodeProjectionSourceIds
  );
  const protectedObservations = input.observations.filter((observation) =>
    protectedObservationIds.has(observation.payload.observationId)
  );
  const removableObservations = input.observations
    .filter((observation) => !protectedObservationIds.has(observation.payload.observationId))
    .sort(compareObservationRecords);

  const targetObservationCount = Math.max(
    input.compaction.maxObservationCount,
    protectedObservations.length
  );
  if (input.observations.length <= targetObservationCount) {
    return [...input.observations];
  }

  const removableCountToKeep = Math.max(0, targetObservationCount - protectedObservations.length);
  const keptRemovableObservations = removableObservations.slice(
    Math.max(0, removableObservations.length - removableCountToKeep)
  );
  return [...protectedObservations, ...keptRemovableObservations]
    .sort(compareObservationRecords);
}

/**
 * Collects observation ids that must remain available because surviving claims or retained journal
 * entries still reference them.
 *
 * @param claims - Canonical graph claims after reconciliation.
 * @param mutationJournal - Retained bounded mutation-journal state.
 * @returns Protected observation identifiers.
 */
function collectProtectedObservationIds(
  observations: readonly ProfileMemoryGraphObservationRecord[],
  claims: readonly ProfileMemoryGraphClaimRecord[],
  events: readonly ProfileMemoryGraphEventRecord[],
  mutationJournal: ProfileMemoryMutationJournalStateV1,
  validEpisodeProjectionSourceIds?: ReadonlySet<string>
): ReadonlySet<string> {
  const observationsById = new Map(
    observations.map((observation) => [observation.payload.observationId, observation] as const)
  );
  return new Set([
    ...claims
      .filter(
        (claim) =>
          claim.payload.redactionState !== "redacted" &&
          isProfileMemoryGraphClaimCurrentSurfaceEligible(claim)
      )
      .flatMap((claim) =>
        claim.payload.derivedFromObservationIds.filter((observationId) =>
          observationsById.get(observationId)?.payload.redactionState !== "redacted"
        )
      ),
    ...events
      .filter((event) =>
        isProfileMemoryGraphEventActiveSurfaceEligible({
          event,
          validEpisodeProjectionSourceIds
        })
      )
      .flatMap((event) =>
        event.payload.derivedFromObservationIds.filter((observationId) =>
          observationsById.get(observationId)?.payload.redactionState !== "redacted"
        )
      ),
    ...mutationJournal.entries.flatMap((entry) => entry.observationIds)
  ]);
}

/**
 * Orders graph observations deterministically for bounded retention.
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
