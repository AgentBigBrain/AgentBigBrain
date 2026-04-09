/**
 * @fileoverview Additive graph-backed event persistence and redaction helpers.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import { createSchemaEnvelopeV1 } from "../schemaEnvelope";
import { PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME } from "./profileMemoryGraphContracts";
import type {
  ProfileMemoryGraphCompactionStateV1,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphSourceTier,
  ProfileMemoryGraphTimeSource,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import { isTerminalProfileEpisodeStatus } from "./profileMemoryEpisodeState";
import { isProfileMemoryGraphEventActiveSurfaceEligible } from "./profileMemoryGraphEventSurfaceEligibilitySupport";
import {
  normalizeProfileMemoryGraphSourceRecordId,
  rebuildProfileMemoryGraphEnvelope,
  safeIsoOrFallback
} from "./profileMemoryGraphStateSupport";

/**
 * Upserts deterministic graph event records for the episodes touched by the current mutation batch.
 *
 * @param input - Existing event records plus touched episode records.
 * @returns Updated event collection plus touched ids.
 */
export function upsertProfileMemoryGraphEvents(input: {
  existingEvents: readonly ProfileMemoryGraphEventRecord[];
  touchedEpisodes: readonly ProfileEpisodeRecord[];
  sourceFingerprint: string;
  recordedAt: string;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  touchedEventIds: string[];
  changed: boolean;
} {
  if (input.touchedEpisodes.length === 0) {
    return {
      nextEvents: [...input.existingEvents],
      touchedEventIds: [],
      changed: false
    };
  }

  const eventMap = new Map(input.existingEvents.map((event) => [event.payload.eventId, event]));
  const touchedEventIds = new Set<string>();
  let changed = false;
  for (const episode of input.touchedEpisodes) {
    const desiredEvent = buildProfileMemoryGraphEventEnvelope({
      episode,
      sourceFingerprint: input.sourceFingerprint,
      recordedAt: input.recordedAt
    });
    const existingEvent = eventMap.get(desiredEvent.payload.eventId);
    const nextEvent = existingEvent === undefined
      ? desiredEvent
      : rebuildProfileMemoryGraphEnvelope({
        record: existingEvent,
        schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
        payload: desiredEvent.payload,
        fallbackCreatedAt: input.recordedAt
      });
    if (existingEvent && graphEventRecordsEqual(existingEvent, nextEvent)) {
      continue;
    }
    eventMap.set(desiredEvent.payload.eventId, nextEvent);
    touchedEventIds.add(desiredEvent.payload.eventId);
    changed = true;
  }
  return {
    nextEvents: [...eventMap.values()].sort(compareEventRecords),
    touchedEventIds: [...touchedEventIds].sort((left, right) => left.localeCompare(right)),
    changed
  };
}
/**
 * Backfills missing graph event records from already-persisted episodes during load normalization.
 *
 * @param input - Existing event records plus canonical episodes from legacy persisted state.
 * @returns Updated event collection plus any event ids created by bounded backfill.
 */
export function backfillProfileMemoryGraphEventsFromEpisodes(input: {
  existingEvents: readonly ProfileMemoryGraphEventRecord[];
  episodes: readonly ProfileEpisodeRecord[];
  recordedAt: string;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  backfilledEventIds: string[];
  changed: boolean;
} {
  if (input.episodes.length === 0) {
    return {
      nextEvents: [...input.existingEvents],
      backfilledEventIds: [],
      changed: false
    };
  }
  const existingEventsById = new Map(
    input.existingEvents.map((event) => [event.payload.eventId, event] as const)
  );
  const validEpisodeProjectionSourceIds = new Set(
    input.episodes.flatMap((episode) => {
      const normalizedEpisodeId = normalizeProfileMemoryGraphSourceRecordId(episode.id);
      return normalizedEpisodeId === null ? [] : [normalizedEpisodeId];
    })
  );
  const missingEpisodes = input.episodes.filter(
    (episode) => {
      const episodeIsTerminal = isTerminalProfileEpisodeStatus(episode.status);
      const canonicalProjectionSourceId = normalizeProfileMemoryGraphSourceRecordId(episode.id);
      const existingEvent = existingEventsById.get(buildProfileMemoryGraphEventId(episode.id));
      if (existingEvent === undefined) {
        return !episodeIsTerminal;
      }
      const desiredEvent = existingEvent
        ? buildProfileMemoryGraphEventEnvelope({
          episode,
          sourceFingerprint: existingEvent.payload.sourceFingerprint,
          recordedAt: input.recordedAt
        })
        : undefined;
      return (
        (
          canonicalProjectionSourceId !== null &&
          !existingEvent.payload.projectionSourceIds.includes(canonicalProjectionSourceId)
        ) ||
        (
          desiredEvent !== undefined &&
          JSON.stringify(existingEvent.payload) !== JSON.stringify(desiredEvent.payload)
        ) ||
        (!episodeIsTerminal && !isProfileMemoryGraphEventActiveSurfaceEligible({
          event: existingEvent,
          validEpisodeProjectionSourceIds
        }))
      );
    }
  );
  if (missingEpisodes.length === 0) {
    return {
      nextEvents: [...input.existingEvents],
      backfilledEventIds: [],
    changed: false
    };
  }
  const upsertResult = upsertProfileMemoryGraphEvents({
    existingEvents: input.existingEvents,
    touchedEpisodes: missingEpisodes,
    sourceFingerprint: buildProfileMemoryGraphEventBackfillFingerprint(missingEpisodes),
    recordedAt: input.recordedAt
  });
  return {
    nextEvents: upsertResult.nextEvents,
    backfilledEventIds: upsertResult.touchedEventIds,
    changed: upsertResult.changed
  };
}
/**
 * Collects active graph event ids that still need one synthetic replay marker because the loaded
 * graph state comes from a legacy uncompacted envelope with missing replay coverage.
 *
 * @param input - Canonical graph events plus retained mutation-journal state.
 * @returns Sorted active event ids still missing replay coverage.
 */
export function collectProfileMemoryGraphReplayBackfillEventIds(input: {
  events: readonly ProfileMemoryGraphEventRecord[];
  compaction: ProfileMemoryGraphCompactionStateV1;
  mutationJournal: ProfileMemoryMutationJournalStateV1;
  validEpisodeProjectionSourceIds?: ReadonlySet<string>;
}): string[] {
  if (input.compaction.snapshotWatermark > 0) {
    return [];
  }
  const journalEventIds = new Set(input.mutationJournal.entries.flatMap((entry) => entry.eventIds));
  return input.events
    .filter(
      (event) =>
        isProfileMemoryGraphEventActiveSurfaceEligible({
          event,
          validEpisodeProjectionSourceIds: input.validEpisodeProjectionSourceIds
        }) &&
        !journalEventIds.has(event.payload.eventId)
    )
    .map((event) => event.payload.eventId)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Builds one deterministic source fingerprint for synthetic replay-marker backfill on active
 * graph events already present in persisted state.
 *
 * @param eventIds - Active graph event ids missing retained replay coverage.
 * @returns Deterministic synthetic replay-marker fingerprint.
 */
export function buildProfileMemoryGraphEventReplayBackfillFingerprint(
  eventIds: readonly string[]
): string {
  return `graph_event_replay_backfill_${sha256HexFromCanonicalJson([...eventIds].sort()).slice(0, 24)}`;
}
/**
 * Redacts graph event payloads for explicitly forgotten episodes while retaining one bounded
 * audit marker under the graph-backed persistence seam.
 *
 * @param input - Existing event records plus forgotten episode records.
 * @returns Updated event collection plus touched ids.
 */
export function redactProfileMemoryGraphEvents(input: {
  existingEvents: readonly ProfileMemoryGraphEventRecord[];
  redactedEpisodes: readonly ProfileEpisodeRecord[];
  sourceTaskId: string | null;
  sourceFingerprint: string;
  recordedAt: string;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  touchedEventIds: string[];
  changed: boolean;
} {
  if (input.redactedEpisodes.length === 0) {
    return {
      nextEvents: [...input.existingEvents],
      touchedEventIds: [],
      changed: false
    };
  }
  const eventMap = new Map(input.existingEvents.map((event) => [event.payload.eventId, event]));
  const touchedEventIds = new Set<string>();
  let changed = false;

  for (const episode of input.redactedEpisodes) {
    const existingEvent = eventMap.get(buildProfileMemoryGraphEventId(episode.id));
    const desiredEvent = buildProfileMemoryGraphRedactedEventEnvelope({
      episode,
      existingEvent,
      sourceTaskId: input.sourceTaskId,
      sourceFingerprint: input.sourceFingerprint,
      recordedAt: input.recordedAt
    });
    const nextEvent = existingEvent === undefined
      ? desiredEvent
      : rebuildProfileMemoryGraphEnvelope({
        record: existingEvent,
        schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
        payload: desiredEvent.payload,
        fallbackCreatedAt: input.recordedAt
      });
    if (existingEvent && graphEventRecordsEqual(existingEvent, nextEvent)) {
      continue;
    }
    eventMap.set(desiredEvent.payload.eventId, nextEvent);
    touchedEventIds.add(desiredEvent.payload.eventId);
    changed = true;
  }

  return {
    nextEvents: [...eventMap.values()].sort(compareEventRecords),
    touchedEventIds: [...touchedEventIds].sort((left, right) => left.localeCompare(right)),
    changed
  };
}
/**
 * Builds one deterministic graph event envelope from one canonical episode record.
 *
 * @param input - Canonical episode record plus batch-level mutation identity.
 * @returns Deterministic graph event envelope.
 */
function buildProfileMemoryGraphEventEnvelope(input: {
  episode: ProfileEpisodeRecord;
  sourceFingerprint: string;
  recordedAt: string;
}): ProfileMemoryGraphEventRecord {
  const eventId = buildProfileMemoryGraphEventId(input.episode.id);
  const projectionSourceId = normalizeProfileMemoryGraphSourceRecordId(input.episode.id);
  const validFrom = safeIsoOrFallback(input.episode.observedAt, input.recordedAt);
  const validTo = isTerminalProfileEpisodeStatus(input.episode.status)
    ? safeIsoOrFallback(input.episode.resolvedAt ?? input.episode.lastUpdatedAt, input.recordedAt)
    : null;
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    {
      eventId,
      stableRefId: null,
      family: "episode.candidate",
      title: input.episode.title,
      summary: input.episode.summary,
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: input.episode.sensitive,
      sourceTaskId: input.episode.sourceTaskId,
      sourceFingerprint: input.sourceFingerprint,
      sourceTier: toGraphEventSourceTier(input.episode),
      assertedAt: validFrom,
      observedAt: validFrom,
      validFrom,
      validTo,
      timePrecision: "instant",
      timeSource: toGraphEventTimeSource(input.episode),
      derivedFromObservationIds: [],
      projectionSourceIds: projectionSourceId === null ? [] : [projectionSourceId],
      entityRefIds: [...input.episode.entityRefs]
    },
    input.recordedAt
  );
}
/**
 * Builds one deterministic redacted graph event envelope for an explicitly forgotten episode.
 *
 * @param input - Forgotten episode record plus any existing persisted graph event.
 * @returns Redaction-safe graph event envelope.
 */
function buildProfileMemoryGraphRedactedEventEnvelope(input: {
  episode: ProfileEpisodeRecord;
  existingEvent?: ProfileMemoryGraphEventRecord | undefined;
  sourceTaskId: string | null;
  sourceFingerprint: string;
  recordedAt: string;
}): ProfileMemoryGraphEventRecord {
  const observedAt = safeIsoOrFallback(
    input.existingEvent?.payload.observedAt ?? input.episode.observedAt,
    input.recordedAt
  );
  const projectionSourceId = normalizeProfileMemoryGraphSourceRecordId(input.episode.id);
  const assertedAt = safeIsoOrFallback(
    input.existingEvent?.payload.assertedAt ?? observedAt,
    input.recordedAt
  );
  const validFrom = input.existingEvent?.payload.validFrom ?? observedAt;
  const validTo = input.existingEvent?.payload.validTo ?? input.recordedAt;
  const timePrecision = input.existingEvent?.payload.timePrecision ?? "instant";
  const timeSource = input.existingEvent?.payload.timeSource ?? toGraphEventTimeSource(input.episode);
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    {
      eventId: buildProfileMemoryGraphEventId(input.episode.id),
      stableRefId: null,
      family: input.existingEvent?.payload.family ?? "episode.candidate",
      title: "[redacted episode]",
      summary: "[redacted episode details]",
      redactionState: "redacted",
      redactedAt: input.recordedAt,
      sensitive: true,
      sourceTaskId: input.sourceTaskId,
      sourceFingerprint: input.sourceFingerprint,
      sourceTier: input.existingEvent?.payload.sourceTier ?? "explicit_user_statement",
      assertedAt,
      observedAt,
      validFrom,
      validTo,
      timePrecision,
      timeSource,
      derivedFromObservationIds: [],
      projectionSourceIds: projectionSourceId === null ? [] : [projectionSourceId],
      entityRefIds: []
    },
    input.recordedAt
  );
}
/**
 * Builds one deterministic event id from one canonical episode identifier.
 *
 * @param episodeId - Canonical episode identifier.
 * @returns Deterministic graph event id.
 */
function buildProfileMemoryGraphEventId(episodeId: string): string {
  const normalizedEpisodeId = normalizeProfileMemoryGraphSourceRecordId(episodeId) ?? episodeId;
  return `event_${sha256HexFromCanonicalJson({ episodeId: normalizedEpisodeId }).slice(0, 24)}`;
}

/**
 * Builds one deterministic synthetic source fingerprint for load-time event backfill.
 *
 * @param episodes - Legacy canonical episodes missing graph event state.
 * @returns Deterministic synthetic fingerprint for bounded backfill.
 */
function buildProfileMemoryGraphEventBackfillFingerprint(
  episodes: readonly ProfileEpisodeRecord[]
): string {
  return `graph_event_backfill_${sha256HexFromCanonicalJson(
    episodes.map((episode) => ({
      episodeId: normalizeProfileMemoryGraphSourceRecordId(episode.id) ?? episode.id,
      sourceTaskId: episode.sourceTaskId,
      observedAt: episode.observedAt,
      lastUpdatedAt: episode.lastUpdatedAt
    }))
  ).slice(0, 24)}`;
}
/**
 * Maps one canonical episode record onto the bounded graph-backed source tier.
 *
 * @param episode - Canonical episode record.
 * @returns Graph-backed source tier.
 */
function toGraphEventSourceTier(episode: ProfileEpisodeRecord): ProfileMemoryGraphSourceTier {
  const normalizedSource = episode.source.trim().toLowerCase();
  if (normalizedSource.startsWith("conversation.")) {
    return "validated_structured_candidate";
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return "reconciliation_or_projection";
  }
  if (
    episode.sourceKind === "assistant_inference" ||
    normalizedSource.startsWith("language_understanding.") ||
    normalizedSource.startsWith("assistant.") ||
    normalizedSource.startsWith("semantic_memory.")
  ) {
    return "assistant_inference";
  }
  return "explicit_user_statement";
}

/**
 * Maps one canonical episode record onto the bounded graph-backed time source.
 *
 * @param episode - Canonical episode record.
 * @returns Graph-backed time source.
 */
function toGraphEventTimeSource(episode: ProfileEpisodeRecord): ProfileMemoryGraphTimeSource {
  const normalizedSource = episode.source.trim().toLowerCase();
  if (normalizedSource.startsWith("conversation.")) {
    return "asserted_at";
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return "system_generated";
  }
  if (episode.sourceKind === "assistant_inference") {
    return "inferred";
  }
  return "user_stated";
}

/** @returns `true` when two event records are equivalent. */
function graphEventRecordsEqual(
  left: ProfileMemoryGraphEventRecord,
  right: ProfileMemoryGraphEventRecord
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
/** @returns Stable ordering result for deterministic event persistence. */
function compareEventRecords(
  left: ProfileMemoryGraphEventRecord,
  right: ProfileMemoryGraphEventRecord
): number {
  if (left.payload.observedAt !== right.payload.observedAt) {
    return left.payload.observedAt.localeCompare(right.payload.observedAt);
  }
  return left.payload.eventId.localeCompare(right.payload.eventId);
}
