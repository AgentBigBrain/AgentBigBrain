/**
 * @fileoverview Retained mutation-journal reference pruning helpers for graph-backed state.
 */

import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryMutationJournalEntryV1,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";
import { buildProfileMemoryMutationJournalCanonicalEntryId } from "./profileMemoryMutationJournalIdentitySupport";
import { normalizeProfileMemoryMutationJournalState } from "./profileMemoryMutationJournal";

const EMPTY_MUTATION_JOURNAL_FALLBACK_RECORDED_AT = "1970-01-01T00:00:00.000Z";

/**
 * Prunes retained journal refs that no longer point at surviving graph records.
 *
 * @param input - Retained journal state plus the surviving graph record ids.
 * @returns Journal state with dangling refs removed and empty ghost entries dropped.
 */
export function pruneProfileMemoryMutationJournalReferences(input: {
  state: ProfileMemoryMutationJournalStateV1;
  validObservationIds: readonly string[];
  validClaimIds: readonly string[];
  validEventIds: readonly string[];
}): {
  nextState: ProfileMemoryMutationJournalStateV1;
  changed: boolean;
} {
  const validObservationIds = new Set(input.validObservationIds);
  const validClaimIds = new Set(input.validClaimIds);
  const validEventIds = new Set(input.validEventIds);
  const nextEntries = input.state.entries.flatMap((entry): ProfileMemoryMutationJournalEntryV1[] => {
    const observationIds = dedupeSortedStrings(
      entry.observationIds.filter((observationId) => validObservationIds.has(observationId))
    );
    const claimIds = dedupeSortedStrings(
      entry.claimIds.filter((claimId) => validClaimIds.has(claimId))
    );
    const eventIds = dedupeSortedStrings(
      entry.eventIds.filter((eventId) => validEventIds.has(eventId))
    );
    if (observationIds.length === 0 && claimIds.length === 0 && eventIds.length === 0) {
      return [];
    }
    if (
      arraysEqual(observationIds, entry.observationIds) &&
      arraysEqual(claimIds, entry.claimIds) &&
      arraysEqual(eventIds, entry.eventIds)
    ) {
      return [entry];
    }
    const nextEntry = {
      ...entry,
      observationIds,
      claimIds,
      eventIds
    };
    return [{
      ...nextEntry,
      journalEntryId: buildProfileMemoryMutationJournalCanonicalEntryId(nextEntry)
    }];
  });

  const changed =
    nextEntries.length !== input.state.entries.length ||
    nextEntries.some((entry, index) => entry !== input.state.entries[index]);
  return {
    nextState: changed
      ? normalizeProfileMemoryMutationJournalState(
        {
          schemaVersion: "v1",
          nextWatermark: input.state.nextWatermark,
          entries: nextEntries
        },
        nextEntries[0]?.recordedAt ??
          input.state.entries[0]?.recordedAt ??
          EMPTY_MUTATION_JOURNAL_FALLBACK_RECORDED_AT
      )
      : input.state,
    changed
  };
}

/**
 * Prunes retained journal refs against one surviving graph state snapshot.
 *
 * @param input - Retained journal state plus surviving graph records.
 * @returns Journal state with dangling refs removed and empty ghost entries dropped.
 */
export function pruneProfileMemoryGraphMutationJournalReferences(input: {
  state: ProfileMemoryMutationJournalStateV1;
  observations: readonly ProfileMemoryGraphObservationRecord[];
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
}): {
  nextState: ProfileMemoryMutationJournalStateV1;
  changed: boolean;
} {
  return pruneProfileMemoryMutationJournalReferences({
    state: input.state,
    validObservationIds: input.observations.map((observation) => observation.payload.observationId),
    validClaimIds: input.claims.map((claim) => claim.payload.claimId),
    validEventIds: input.events.map((event) => event.payload.eventId)
  });
}

/**
 * Deduplicates and sorts one string collection for deterministic journal payloads.
 *
 * @param values - Candidate string values.
 * @returns Sorted unique values.
 */
function dedupeSortedStrings(values: readonly string[]): string[] {
  return [...new Set(
    values.flatMap((value) => {
      if (typeof value !== "string") {
        return [];
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    })
  )]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Checks whether two string arrays are already equal in deterministic order.
 *
 * @param left - Left array.
 * @param right - Right array.
 * @returns `true` when both arrays match exactly.
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
