/**
 * @fileoverview Bounded event-retention helpers for additive profile-memory graph state.
 */

import type {
  ProfileMemoryGraphCompactionStateV1,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";
import { isProfileMemoryGraphEventActiveSurfaceEligible } from "./profileMemoryGraphEventSurfaceEligibilitySupport";

/**
 * Enforces bounded event retention while preserving active or replay-retained graph events.
 *
 * @param input - Current graph events plus retained journal references.
 * @returns Compacted event state and any compaction-state update.
 */
export function compactProfileMemoryGraphEvents(input: {
  events: readonly ProfileMemoryGraphEventRecord[];
  mutationJournal: ProfileMemoryMutationJournalStateV1;
  compaction: ProfileMemoryGraphCompactionStateV1;
  recordedAt: string;
  validEpisodeProjectionSourceIds?: ReadonlySet<string>;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  nextCompaction: ProfileMemoryGraphCompactionStateV1;
  changed: boolean;
} {
  if (input.events.length <= input.compaction.maxEventCount) {
    return {
      nextEvents: [...input.events],
      nextCompaction: input.compaction,
      changed: false
    };
  }

  const protectedEventIds = collectProtectedEventIds(
    input.events,
    input.mutationJournal,
    input.validEpisodeProjectionSourceIds
  );
  const protectedEvents = input.events.filter((event) =>
    protectedEventIds.has(event.payload.eventId)
  );
  const removableEvents = input.events
    .filter((event) => !protectedEventIds.has(event.payload.eventId))
    .sort(compareEventRecords);
  const targetEventCount = Math.max(input.compaction.maxEventCount, protectedEvents.length);
  if (input.events.length <= targetEventCount) {
    return {
      nextEvents: [...input.events],
      nextCompaction: input.compaction,
      changed: false
    };
  }

  const removableCountToKeep = Math.max(0, targetEventCount - protectedEvents.length);
  const keptRemovableEvents = removableEvents.slice(
    Math.max(0, removableEvents.length - removableCountToKeep)
  );
  const nextEvents = [...protectedEvents, ...keptRemovableEvents].sort(compareEventRecords);

  return {
    nextEvents,
    nextCompaction: {
      ...input.compaction,
      lastCompactedAt: input.recordedAt
    },
    changed: nextEvents.length !== input.events.length
  };
}

/**
 * Collects event ids that must remain available because they are still active or retained by the
 * bounded replay window.
 *
 * @param events - Canonical graph events after the current mutation batch.
 * @param mutationJournal - Retained bounded mutation-journal state.
 * @returns Protected event identifiers.
 */
function collectProtectedEventIds(
  events: readonly ProfileMemoryGraphEventRecord[],
  mutationJournal: ProfileMemoryMutationJournalStateV1,
  validEpisodeProjectionSourceIds?: ReadonlySet<string>
): ReadonlySet<string> {
  return new Set([
    ...events
      .filter((event) =>
        isProfileMemoryGraphEventActiveSurfaceEligible({
          event,
          validEpisodeProjectionSourceIds
        })
      )
      .map((event) => event.payload.eventId),
    ...mutationJournal.entries.flatMap((entry) => entry.eventIds)
  ]);
}

/**
 * Orders graph events deterministically for bounded retention.
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
