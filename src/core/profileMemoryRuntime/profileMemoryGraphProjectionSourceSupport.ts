/**
 * @fileoverview Projection-source pruning helpers for additive profile-memory graph state.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type { ProfileFactRecord } from "../profileMemory";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord
} from "./profileMemoryGraphContracts";
import { normalizeProfileMemoryGraphSourceRecordId } from "./profileMemoryGraphStateSupport";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

/**
 * Prunes duplicate or dangling projection-source refs from retained graph claims and events.
 *
 * @param input - Canonical facts and episodes plus retained graph claims and events.
 * @returns Canonical graph records with bounded projection lineage only.
 */
export function pruneProfileMemoryGraphProjectionSources(input: {
  facts: readonly ProfileFactRecord[];
  episodes: readonly ProfileEpisodeRecord[];
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  const validFactIds = new Set(
    input.facts.flatMap((fact) => {
      const normalizedFactId = normalizeProfileMemoryGraphSourceRecordId(fact.id);
      return normalizedFactId === null ? [] : [normalizedFactId];
    })
  );
  const validEpisodeIds = new Set(
    input.episodes.flatMap((episode) => {
      const normalizedEpisodeId = normalizeProfileMemoryGraphSourceRecordId(episode.id);
      return normalizedEpisodeId === null ? [] : [normalizedEpisodeId];
    })
  );
  const nextClaims = input.claims.map((claim) =>
    pruneClaimProjectionSources(claim, validFactIds, input.recordedAt)
  );
  const nextEvents = input.events.map((event) =>
    pruneEventProjectionSources(event, validEpisodeIds, input.recordedAt)
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
 * Prunes one claim's projection-source refs down to canonical surviving fact ids or retained
 * explicitly forgotten fact ids.
 *
 * @param claim - Canonical claim record to normalize.
 * @param validFactIds - Surviving canonical fact ids.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Original claim when unchanged, otherwise a repaired claim envelope.
 */
function pruneClaimProjectionSources(
  claim: ProfileMemoryGraphClaimRecord,
  validFactIds: ReadonlySet<string>,
  recordedAt: string
): ProfileMemoryGraphClaimRecord {
  const projectionSourceIds = claim.payload.redactionState === "redacted"
    ? pruneRedactedClaimProjectionSourceIds(claim.payload.projectionSourceIds, validFactIds)
    : dedupeSortedStrings(claim.payload.projectionSourceIds, validFactIds);
  if (arraysEqual(projectionSourceIds, claim.payload.projectionSourceIds)) {
    return claim;
  }
  return rebuildProfileMemoryGraphEnvelope({
    record: claim,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...claim.payload,
      projectionSourceIds
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Prunes one event's projection-source refs down to surviving episode ids or retained explicitly
 * forgotten episode ids.
 *
 * @param event - Canonical event record to normalize.
 * @param validEpisodeIds - Surviving canonical episode ids.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Original event when unchanged, otherwise a repaired event envelope.
 */
function pruneEventProjectionSources(
  event: ProfileMemoryGraphEventRecord,
  validEpisodeIds: ReadonlySet<string>,
  recordedAt: string
): ProfileMemoryGraphEventRecord {
  const projectionSourceIds = event.payload.redactionState === "redacted"
    ? pruneRedactedEventProjectionSourceIds(event, validEpisodeIds)
    : dedupeSortedStrings(event.payload.projectionSourceIds, validEpisodeIds);
  if (arraysEqual(projectionSourceIds, event.payload.projectionSourceIds)) {
    return event;
  }
  return rebuildProfileMemoryGraphEnvelope({
    record: event,
    schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payload: {
      ...event.payload,
      projectionSourceIds
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Deduplicates one redacted event's projection-source array while fail-closing still-live episode
 * ids plus unrelated deleted-episode refs that do not match the event's own deterministic lane.
 *
 * @param event - Canonical retained event record.
 * @param validIds - Surviving canonical episode ids.
 * @returns Sorted unique deleted-episode lineage ids for the same event lane only.
 */
function pruneRedactedEventProjectionSourceIds(
  event: ProfileMemoryGraphEventRecord,
  validIds: ReadonlySet<string>
): string[] {
  return [...new Set(event.payload.projectionSourceIds.filter((value) =>
    !validIds.has(value) &&
    buildProfileMemoryGraphEventIdFromProjectionSourceId(value) === event.payload.eventId
  ))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Builds one deterministic graph event id from one retained event projection-source id.
 *
 * @param sourceId - Candidate retained episode projection-source id.
 * @returns Deterministic graph event id for that episode lane.
 */
function buildProfileMemoryGraphEventIdFromProjectionSourceId(sourceId: string): string {
  const normalizedEpisodeId = normalizeProfileMemoryGraphSourceRecordId(sourceId) ?? sourceId;
  return `event_${sha256HexFromCanonicalJson({ episodeId: normalizedEpisodeId }).slice(0, 24)}`;
}

/**
 * Deduplicates one redacted claim's projection-source array while fail-closing still-live fact ids.
 *
 * @param values - Candidate retained source ids.
 * @param validIds - Surviving canonical fact ids.
 * @returns Sorted unique deleted-fact lineage ids only.
 */
function pruneRedactedClaimProjectionSourceIds(
  values: readonly string[],
  validIds: ReadonlySet<string>
): string[] {
  return [...new Set(values.filter((value) => !validIds.has(value)))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Deduplicates and prunes one projection-source array against surviving source ids.
 *
 * @param values - Candidate source ids.
 * @param validIds - Surviving canonical source ids.
 * @returns Sorted unique surviving source ids only.
 */
function dedupeSortedStrings(values: readonly string[], validIds: ReadonlySet<string>): string[] {
  return [...new Set(values.filter((value) => validIds.has(value)))]
    .sort((left, right) => left.localeCompare(right));
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
