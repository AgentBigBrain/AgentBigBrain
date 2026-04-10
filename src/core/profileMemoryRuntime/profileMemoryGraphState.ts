/**
 * @fileoverview Canonical additive graph-state creation and normalization helpers.
 */
import type { ProfileFactRecord } from "../profileMemory";
import { PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, PROFILE_MEMORY_GRAPH_SCHEMA_VERSION, type ProfileMemoryGraphState } from "./profileMemoryGraphContracts";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import { compactProfileMemoryGraphClaims } from "./profileMemoryGraphClaimCompactionSupport";
import { repairProfileMemoryGraphAuthoritativeActiveClaimConflicts } from "./profileMemoryGraphClaimAuthoritativeConflictRepairSupport";
import { repairProfileMemoryGraphSemanticDuplicateClaims } from "./profileMemoryGraphClaimDeduplicationSupport";
import { pruneProfileMemoryGraphClaimSuccessors } from "./profileMemoryGraphClaimSuccessorSupport";
import { collectProfileMemoryGraphReplayBackfillClaimIds } from "./profileMemoryGraphClaimReplaySupport";
import { backfillProfileMemoryGraphEventsFromEpisodes, collectProfileMemoryGraphReplayBackfillEventIds } from "./profileMemoryGraphEventSupport";
import { compactProfileMemoryGraphEvents } from "./profileMemoryGraphEventCompactionSupport";
import { pruneProfileMemoryGraphEntityRefs } from "./profileMemoryGraphEntityRefSupport";
import { backfillProfileMemoryGraphObservationsFromLegacyClaims } from "./profileMemoryGraphLegacyClaimObservationBackfillSupport";
import { backfillProfileMemoryGraphFromLegacyFacts } from "./profileMemoryGraphLegacyFactBackfillSupport";
import { pruneProfileMemoryGraphMutationJournalReferences } from "./profileMemoryMutationJournalReferenceSupport";
import { buildProfileMemoryGraphReadModel, createEmptyProfileMemoryGraphIndexState } from "./profileMemoryGraphIndexing";
import { createDefaultProfileMemoryGraphCompactionState, normalizeGraphEnvelopeArray, normalizeProfileMemoryGraphCompactionState } from "./profileMemoryGraphNormalizationSupport";
import { normalizeProfileMemoryGraphClaimPayloadCandidate, normalizeProfileMemoryGraphEventPayloadCandidate, normalizeProfileMemoryGraphObservationPayloadCandidate } from "./profileMemoryGraphPayloadNormalizationSupport";
import { compactProfileMemoryGraphObservations } from "./profileMemoryGraphObservationCompactionSupport";
import { pruneProfileMemoryGraphObservationLineage } from "./profileMemoryGraphObservationLineageSupport";
import { pruneProfileMemoryGraphProjectionSources } from "./profileMemoryGraphProjectionSourceSupport";
import { attachProfileMemoryGraphStableRefs } from "./profileMemoryGraphQueries";
import { collectProfileMemoryGraphReplayBackfillObservationIds } from "./profileMemoryGraphObservationReplaySupport";
import { collectValidProfileMemoryGraphEpisodeProjectionSourceIds, finalizeProfileMemoryGraphState, safeIsoOrFallback } from "./profileMemoryGraphStateSupport";
import { normalizeProfileMemoryGraphClaimRecords, normalizeProfileMemoryGraphEventRecords, normalizeProfileMemoryGraphObservationRecords } from "./profileMemoryGraphTimeNormalizationSupport";
import { appendProfileMemoryGraphReplayBackfillEntries } from "./profileMemoryMutationJournalReplaySupport";
import { compactProfileMemoryMutationJournalState, createEmptyProfileMemoryMutationJournalState, normalizeProfileMemoryMutationJournalState } from "./profileMemoryMutationJournal";
import { clampProfileMemoryGraphCompactionSnapshotWatermark, clampProfileMemoryGraphMutationJournalNextWatermark } from "./profileMemoryMutationJournalWindowSupport";
import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
/**
 * Creates an empty additive graph-backed profile-memory state.
 *
 * @param updatedAt - Deterministic timestamp for the graph state envelope.
 * @returns Empty graph-backed state plus derived index and read-model surfaces.
 */
export function createEmptyProfileMemoryGraphState(updatedAt: string = new Date().toISOString()): ProfileMemoryGraphState {
  const mutationJournal = createEmptyProfileMemoryMutationJournalState();
  return {
    schemaVersion: PROFILE_MEMORY_GRAPH_SCHEMA_VERSION,
    updatedAt,
    observations: [],
    claims: [],
    events: [],
    decisionRecords: [],
    mutationJournal,
    indexes: createEmptyProfileMemoryGraphIndexState(),
    readModel: buildProfileMemoryGraphReadModel({
      claims: [],
      mutationJournal,
      rebuiltAt: updatedAt
    }),
    compaction: createDefaultProfileMemoryGraphCompactionState()
  };
}
/**
 * Normalizes unknown persisted graph payloads into one stable additive graph state.
 *
 * @param raw - Unknown graph payload from persisted profile-memory state.
 * @param fallbackUpdatedAt - Fallback timestamp for rebuilt derived surfaces.
 * @returns Stable graph-backed state with rebuilt indexes and read model.
 */
export function normalizeProfileMemoryGraphState(
  raw: unknown,
  fallbackUpdatedAt: string,
  episodesForBackfill: readonly ProfileEpisodeRecord[] = [],
  factsForBackfill: readonly ProfileFactRecord[] = []
): ProfileMemoryGraphState {
  const empty = createEmptyProfileMemoryGraphState(fallbackUpdatedAt);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return episodesForBackfill.length === 0 ? empty : normalizeProfileMemoryGraphState({ updatedAt: fallbackUpdatedAt }, fallbackUpdatedAt, episodesForBackfill, factsForBackfill);
  }
  const candidate = raw as Partial<ProfileMemoryGraphState>;
  const updatedAt = safeIsoOrFallback(candidate.updatedAt, fallbackUpdatedAt);
  const observations = normalizeGraphEnvelopeArray({
    raw: candidate.observations,
    expectedSchemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    payloadNormalizer: normalizeProfileMemoryGraphObservationPayloadCandidate,
    recordId: (payload) => payload.observationId,
    fallbackCreatedAt: updatedAt
  });
  const claims = normalizeGraphEnvelopeArray({
    raw: candidate.claims,
    expectedSchemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payloadNormalizer: normalizeProfileMemoryGraphClaimPayloadCandidate,
    recordId: (payload) => payload.claimId,
    fallbackCreatedAt: updatedAt
  });
  const events = normalizeGraphEnvelopeArray({
    raw: candidate.events,
    expectedSchemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payloadNormalizer: normalizeProfileMemoryGraphEventPayloadCandidate,
    recordId: (payload) => payload.eventId,
    fallbackCreatedAt: updatedAt
  });
  const legacyFactBackfillResult = backfillProfileMemoryGraphFromLegacyFacts({
    existingObservations: observations,
    existingClaims: claims,
    facts: factsForBackfill,
    recordedAt: updatedAt
  });
  const preBackfillObservationNormalizationResult = normalizeProfileMemoryGraphObservationRecords({
    observations: legacyFactBackfillResult.nextObservations,
    recordedAt: updatedAt
  });
  const normalizedCompaction = normalizeProfileMemoryGraphCompactionState(candidate.compaction);
  const legacyClaimObservationBackfillResult = backfillProfileMemoryGraphObservationsFromLegacyClaims({
    existingObservations: preBackfillObservationNormalizationResult.nextObservations,
    existingClaims: legacyFactBackfillResult.nextClaims,
    recordedAt: updatedAt
  });
  const observationNormalizationResult = normalizeProfileMemoryGraphObservationRecords({
    observations: legacyClaimObservationBackfillResult.nextObservations,
    recordedAt: updatedAt
  });
  const semanticDuplicateClaimRepairResult = repairProfileMemoryGraphSemanticDuplicateClaims({
    claims: legacyClaimObservationBackfillResult.nextClaims,
    recordedAt: updatedAt
  });
  const claimNormalizationResult = normalizeProfileMemoryGraphClaimRecords({
    claims: semanticDuplicateClaimRepairResult.nextClaims,
    recordedAt: updatedAt
  });
  const authoritativeClaimConflictRepairResult = repairProfileMemoryGraphAuthoritativeActiveClaimConflicts({
    claims: claimNormalizationResult.nextClaims,
    recordedAt: updatedAt
  });
  const eventBackfillResult = backfillProfileMemoryGraphEventsFromEpisodes({
    existingEvents: events,
    episodes: episodesForBackfill,
    recordedAt: updatedAt
  });
  const eventNormalizationResult = normalizeProfileMemoryGraphEventRecords({
    events: eventBackfillResult.nextEvents,
    recordedAt: updatedAt
  });
  const decisionRecords = normalizeProfileMemoryGraphDecisionRecords(
    candidate.decisionRecords,
    updatedAt
  );
  const validEpisodeProjectionSourceIds = collectValidProfileMemoryGraphEpisodeProjectionSourceIds(episodesForBackfill);
  let mutationJournal = normalizeProfileMemoryMutationJournalState(candidate.mutationJournal, updatedAt);
  const replaySafeCompaction = clampProfileMemoryGraphCompactionSnapshotWatermark({ compaction: normalizedCompaction, state: mutationJournal });
  mutationJournal = clampProfileMemoryGraphMutationJournalNextWatermark({ compaction: replaySafeCompaction, state: mutationJournal });
  const replayBackfillObservationIds = collectProfileMemoryGraphReplayBackfillObservationIds({
    observations: observationNormalizationResult.nextObservations,
    claims: authoritativeClaimConflictRepairResult.nextClaims,
    events: eventNormalizationResult.nextEvents,
    compaction: replaySafeCompaction,
    mutationJournal,
    validEpisodeProjectionSourceIds
  });
  const replayBackfillClaimIds = collectProfileMemoryGraphReplayBackfillClaimIds({
    claims: authoritativeClaimConflictRepairResult.nextClaims,
    compaction: replaySafeCompaction,
    mutationJournal
  });
  const replayBackfillEventIds = collectProfileMemoryGraphReplayBackfillEventIds({
    events: eventNormalizationResult.nextEvents,
    compaction: replaySafeCompaction,
    mutationJournal,
    validEpisodeProjectionSourceIds
  });
  mutationJournal = appendProfileMemoryGraphReplayBackfillEntries({
    state: mutationJournal,
    recordedAt: updatedAt,
    observationIds: replayBackfillObservationIds,
    claimIds: replayBackfillClaimIds,
    eventIds: replayBackfillEventIds
  });
  const prunedMutationJournal = pruneProfileMemoryGraphMutationJournalReferences({
    state: mutationJournal,
    observations: observationNormalizationResult.nextObservations,
    claims: authoritativeClaimConflictRepairResult.nextClaims,
    events: eventNormalizationResult.nextEvents
  });
  const journalCompactionResult = compactProfileMemoryMutationJournalState({
    state: prunedMutationJournal.nextState,
    compaction: replaySafeCompaction,
    recordedAt: updatedAt
  });
  const claimCompactionResult = compactProfileMemoryGraphClaims({
    claims: authoritativeClaimConflictRepairResult.nextClaims,
    mutationJournal: journalCompactionResult.nextState,
    compaction: journalCompactionResult.nextCompaction,
    recordedAt: updatedAt
  });
  const claimSuccessorPruningResult = pruneProfileMemoryGraphClaimSuccessors({
    claims: claimCompactionResult.nextClaims,
    recordedAt: updatedAt
  });
  const observationCompactionResult = compactProfileMemoryGraphObservations({
    observations: observationNormalizationResult.nextObservations,
    claims: claimSuccessorPruningResult.nextClaims,
    events: eventNormalizationResult.nextEvents,
    mutationJournal: journalCompactionResult.nextState,
    compaction: claimCompactionResult.nextCompaction,
    recordedAt: updatedAt,
    validEpisodeProjectionSourceIds
  });
  const observationLineagePruningResult = pruneProfileMemoryGraphObservationLineage({
    observations: observationCompactionResult.nextObservations,
    claims: claimSuccessorPruningResult.nextClaims,
    events: eventNormalizationResult.nextEvents,
    recordedAt: updatedAt
  });
  const eventCompactionResult = compactProfileMemoryGraphEvents({
    events: observationLineagePruningResult.nextEvents,
    mutationJournal: journalCompactionResult.nextState,
    compaction: observationCompactionResult.nextCompaction,
    recordedAt: updatedAt,
    validEpisodeProjectionSourceIds
  });
  const projectionSourcePruningResult = pruneProfileMemoryGraphProjectionSources({
    facts: factsForBackfill,
    episodes: episodesForBackfill,
    claims: observationLineagePruningResult.nextClaims,
    events: eventCompactionResult.nextEvents,
    recordedAt: updatedAt
  });
  const entityRefPruningResult = pruneProfileMemoryGraphEntityRefs({
    observations: observationCompactionResult.nextObservations,
    claims: projectionSourcePruningResult.nextClaims,
    events: projectionSourcePruningResult.nextEvents,
    recordedAt: updatedAt
  });
  const stableRefAttachmentResult = attachProfileMemoryGraphStableRefs({
    observations: entityRefPruningResult.nextObservations,
    claims: entityRefPruningResult.nextClaims,
    events: entityRefPruningResult.nextEvents,
    touchedObservationIds: entityRefPruningResult.nextObservations.map(
      (observation) => observation.payload.observationId
    ),
    touchedClaimIds: entityRefPruningResult.nextClaims.map((claim) => claim.payload.claimId),
    touchedEventIds: entityRefPruningResult.nextEvents.map((event) => event.payload.eventId),
    recordedAt: updatedAt
  });
  return finalizeProfileMemoryGraphState({
    graph: {
      schemaVersion: PROFILE_MEMORY_GRAPH_SCHEMA_VERSION,
      updatedAt,
      observations: [],
      claims: [],
      events: [],
      decisionRecords,
      mutationJournal: createEmptyProfileMemoryMutationJournalState(),
      indexes: createEmptyProfileMemoryGraphIndexState(),
      readModel: buildProfileMemoryGraphReadModel({
        claims: [],
        mutationJournal: createEmptyProfileMemoryMutationJournalState(),
        rebuiltAt: updatedAt
      }),
      compaction: createDefaultProfileMemoryGraphCompactionState()
    },
    updatedAt,
    observations: stableRefAttachmentResult.nextObservations,
    claims: stableRefAttachmentResult.nextClaims,
    events: stableRefAttachmentResult.nextEvents,
    mutationJournal: journalCompactionResult.nextState,
    compaction: eventCompactionResult.nextCompaction
  });
}

/**
 * Normalizes persisted profile-memory graph decision records into one canonical durable shape.
 *
 * @param raw - Candidate persisted decision-record array.
 * @param fallbackRecordedAt - Fallback timestamp for malformed decision records.
 * @returns Stable ordered durable decision records.
 */
function normalizeProfileMemoryGraphDecisionRecords(
  raw: unknown,
  fallbackRecordedAt: string
): ProfileMemoryGraphState["decisionRecords"] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .flatMap((value) => {
      const normalized = normalizeProfileMemoryGraphDecisionRecord(value, fallbackRecordedAt);
      return normalized ? [normalized] : [];
    })
    .sort((left, right) =>
      left.recordedAt === right.recordedAt
        ? left.decisionId.localeCompare(right.decisionId)
        : left.recordedAt.localeCompare(right.recordedAt)
    );
}

/**
 * Normalizes one persisted profile-memory graph decision record or drops malformed entries.
 *
 * @param value - Candidate persisted decision record.
 * @param fallbackRecordedAt - Fallback timestamp for malformed timestamps.
 * @returns Canonical durable decision record or `null`.
 */
function normalizeProfileMemoryGraphDecisionRecord(
  value: unknown,
  fallbackRecordedAt: string
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<NonNullable<ProfileMemoryGraphState["decisionRecords"]>[number]>;
  if (
    typeof candidate.action !== "string" ||
    !["merge", "quarantine", "unquarantine", "rekey", "rollback"].includes(candidate.action)
  ) {
    return null;
  }
  const recordedAt = safeIsoOrFallback(candidate.recordedAt, fallbackRecordedAt);
  const decisionPayload = {
    action: candidate.action,
    recordedAt,
    fromStableRefId: normalizeDecisionRecordString(candidate.fromStableRefId),
    toStableRefId: normalizeDecisionRecordString(candidate.toStableRefId),
    sourceTaskId: normalizeDecisionRecordString(candidate.sourceTaskId),
    sourceFingerprint: normalizeDecisionRecordString(candidate.sourceFingerprint),
    mutationEnvelopeHash: normalizeDecisionRecordString(candidate.mutationEnvelopeHash),
    observationIds: normalizeDecisionRecordStringArray(candidate.observationIds),
    claimIds: normalizeDecisionRecordStringArray(candidate.claimIds),
    eventIds: normalizeDecisionRecordStringArray(candidate.eventIds)
  };
  return {
    decisionId:
      normalizeDecisionRecordString(candidate.decisionId) ??
      `profile_memory_graph_decision_${sha256HexFromCanonicalJson(decisionPayload).slice(0, 24)}`,
    ...decisionPayload
  };
}

/** Normalizes one optional decision-record string field. */
function normalizeDecisionRecordString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Deduplicates and orders decision-record id lists. */
function normalizeDecisionRecordStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter(
              (entry): entry is string =>
                typeof entry === "string" && Boolean(entry.trim())
            )
            .map((entry) => entry.trim())
        )
      ].sort((left, right) => left.localeCompare(right))
    : [];
}
