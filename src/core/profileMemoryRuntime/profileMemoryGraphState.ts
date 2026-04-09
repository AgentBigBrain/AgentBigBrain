/**
 * @fileoverview Canonical additive graph-state creation and normalization helpers.
 */
import type { ProfileFactRecord, ProfileMemoryState } from "../profileMemory";
import { PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, PROFILE_MEMORY_GRAPH_SCHEMA_VERSION, type ProfileMemoryGraphState } from "./profileMemoryGraphContracts";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import { compactProfileMemoryGraphClaims } from "./profileMemoryGraphClaimCompactionSupport";
import { repairProfileMemoryGraphAuthoritativeActiveClaimConflicts } from "./profileMemoryGraphClaimAuthoritativeConflictRepairSupport";
import { repairProfileMemoryGraphSemanticDuplicateClaims } from "./profileMemoryGraphClaimDeduplicationSupport";
import { pruneProfileMemoryGraphClaimSuccessors } from "./profileMemoryGraphClaimSuccessorSupport";
import { collectProfileMemoryGraphReplayBackfillClaimIds } from "./profileMemoryGraphClaimReplaySupport";
import { reconcileProfileMemoryCurrentClaims } from "./profileMemoryGraphClaimSupport";
import { backfillProfileMemoryGraphEventsFromEpisodes, collectProfileMemoryGraphReplayBackfillEventIds, redactProfileMemoryGraphEvents, upsertProfileMemoryGraphEvents } from "./profileMemoryGraphEventSupport";
import { redactProfileMemoryGraphFacts } from "./profileMemoryGraphFactRedactionSupport";
import { compactProfileMemoryGraphEvents } from "./profileMemoryGraphEventCompactionSupport";
import { pruneProfileMemoryGraphEntityRefs } from "./profileMemoryGraphEntityRefSupport";
import { backfillProfileMemoryGraphObservationsFromLegacyClaims } from "./profileMemoryGraphLegacyClaimObservationBackfillSupport";
import { backfillProfileMemoryGraphFromLegacyFacts } from "./profileMemoryGraphLegacyFactBackfillSupport";
import { pruneProfileMemoryGraphMutationJournalReferences } from "./profileMemoryMutationJournalReferenceSupport";
import { buildProfileMemoryGraphIndexState, buildProfileMemoryGraphReadModel, createEmptyProfileMemoryGraphIndexState } from "./profileMemoryGraphIndexing";
import { createDefaultProfileMemoryGraphCompactionState, normalizeGraphEnvelopeArray, normalizeProfileMemoryGraphCompactionState } from "./profileMemoryGraphNormalizationSupport";
import { normalizeProfileMemoryGraphClaimPayloadCandidate, normalizeProfileMemoryGraphEventPayloadCandidate, normalizeProfileMemoryGraphObservationPayloadCandidate } from "./profileMemoryGraphPayloadNormalizationSupport";
import { compactProfileMemoryGraphObservations } from "./profileMemoryGraphObservationCompactionSupport";
import { pruneProfileMemoryGraphObservationLineage } from "./profileMemoryGraphObservationLineageSupport";
import { pruneProfileMemoryGraphProjectionSources } from "./profileMemoryGraphProjectionSourceSupport";
import { collectProfileMemoryGraphReplayBackfillObservationIds } from "./profileMemoryGraphObservationReplaySupport";
import { upsertProfileMemoryGraphObservations } from "./profileMemoryGraphObservationSupport";
import { collectValidProfileMemoryGraphEpisodeProjectionSourceIds, finalizeProfileMemoryGraphState, firstNonEmptyString, safeIsoOrFallback } from "./profileMemoryGraphStateSupport";
import { normalizeProfileMemoryGraphClaimRecords, normalizeProfileMemoryGraphEventRecords, normalizeProfileMemoryGraphObservationRecords } from "./profileMemoryGraphTimeNormalizationSupport";
import { appendProfileMemoryGraphReplayBackfillEntries } from "./profileMemoryMutationJournalReplaySupport";
import { appendProfileMemoryMutationJournalEntry, compactProfileMemoryMutationJournalState, createEmptyProfileMemoryMutationJournalState, normalizeProfileMemoryMutationJournalState } from "./profileMemoryMutationJournal";
import { clampProfileMemoryGraphCompactionSnapshotWatermark, clampProfileMemoryGraphMutationJournalNextWatermark } from "./profileMemoryMutationJournalWindowSupport";
import type { GovernedProfileFactCandidate } from "./profileMemoryTruthGovernanceContracts";
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
  return finalizeProfileMemoryGraphState({
    graph: {
      schemaVersion: PROFILE_MEMORY_GRAPH_SCHEMA_VERSION,
      updatedAt,
      observations: [],
      claims: [],
      events: [],
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
    observations: entityRefPruningResult.nextObservations,
    claims: entityRefPruningResult.nextClaims,
    events: entityRefPruningResult.nextEvents,
    mutationJournal: journalCompactionResult.nextState,
    compaction: eventCompactionResult.nextCompaction
  });
}
/**
 * Applies one bounded graph mutation batch under the stable profile-memory store seam.
 *
 * @param input - Canonical post-mutation state plus governed fact and episode mutations.
 * @returns Updated profile state and whether the additive graph changed.
 */
export function applyProfileMemoryGraphMutations(input: {
  state: ProfileMemoryState;
  factDecisions: readonly GovernedProfileFactCandidate[];
  touchedEpisodes: readonly ProfileEpisodeRecord[];
  redactedEpisodes?: readonly ProfileEpisodeRecord[];
  redactedFacts?: readonly ProfileFactRecord[];
  sourceTaskId?: string | null;
  sourceFingerprint: string;
  mutationEnvelopeHash: string | null;
  recordedAt: string;
}): { nextState: ProfileMemoryState; changed: boolean } {
  const observationDecisions = input.factDecisions.filter(
    (entry) => entry.decision.action !== "quarantine"
  );
  const redactedEpisodes = input.redactedEpisodes ?? [];
  const redactedFacts = input.redactedFacts ?? [];
  if (observationDecisions.length === 0 &&
    input.touchedEpisodes.length === 0 &&
    redactedEpisodes.length === 0 &&
    redactedFacts.length === 0) {
    return {
      nextState: input.state,
      changed: false
    };
  }

  const graph = input.state.graph ?? createEmptyProfileMemoryGraphState(input.recordedAt);
  const observationResult = upsertProfileMemoryGraphObservations({
    existingObservations: graph.observations,
    factDecisions: observationDecisions,
    sourceFingerprint: input.sourceFingerprint,
    recordedAt: input.recordedAt
  });
  const claimResult = reconcileProfileMemoryCurrentClaims({
    existingClaims: graph.claims,
    observations: observationResult.nextObservations,
    facts: input.state.facts,
    factDecisions: input.factDecisions,
    recordedAt: input.recordedAt
  });
  const eventResult = upsertProfileMemoryGraphEvents({
    existingEvents: graph.events,
    touchedEpisodes: input.touchedEpisodes,
    sourceFingerprint: input.sourceFingerprint,
    recordedAt: input.recordedAt
  });
  const factRedactionResult = redactProfileMemoryGraphFacts({
    existingObservations: observationResult.nextObservations,
    existingClaims: claimResult.nextClaims,
    redactedFacts,
    sourceTaskId: input.sourceTaskId ?? null,
    sourceFingerprint: input.sourceFingerprint,
    recordedAt: input.recordedAt
  });
  const redactionResult = redactProfileMemoryGraphEvents({
    existingEvents: eventResult.nextEvents,
    redactedEpisodes,
    sourceTaskId: input.sourceTaskId ?? null,
    sourceFingerprint: input.sourceFingerprint,
    recordedAt: input.recordedAt
  });
  const observationNormalizationResult = normalizeProfileMemoryGraphObservationRecords({
    observations: factRedactionResult.nextObservations,
    recordedAt: input.recordedAt
  });
  const claimNormalizationResult = normalizeProfileMemoryGraphClaimRecords({
    claims: factRedactionResult.nextClaims,
    recordedAt: input.recordedAt
  });
  const eventNormalizationResult = normalizeProfileMemoryGraphEventRecords({
    events: redactionResult.nextEvents,
    recordedAt: input.recordedAt
  });
  const journalResult = appendProfileMemoryMutationJournalEntry(graph.mutationJournal, {
    recordedAt: input.recordedAt,
    sourceTaskId: firstNonEmptyString([
      input.sourceTaskId ?? "",
      ...observationDecisions.map((entry) => entry.candidate.sourceTaskId),
      ...input.touchedEpisodes.map((episode) => episode.sourceTaskId),
      ...redactedEpisodes.map((episode) => episode.sourceTaskId),
      ...redactedFacts.map((fact) => fact.sourceTaskId)
    ]),
    sourceFingerprint: input.sourceFingerprint,
    mutationEnvelopeHash: input.mutationEnvelopeHash,
    observationIds: [
      ...observationResult.touchedObservationIds,
      ...factRedactionResult.touchedObservationIds
    ],
    claimIds: [
      ...claimResult.touchedClaimIds,
      ...factRedactionResult.touchedClaimIds
    ],
    eventIds: [...eventResult.touchedEventIds, ...redactionResult.touchedEventIds],
    redactionState: redactionResult.changed || factRedactionResult.changed
      ? "redacted"
      : "not_requested"
  });
  const prunedJournalResult = pruneProfileMemoryGraphMutationJournalReferences({
    state: journalResult.nextState,
    observations: observationNormalizationResult.nextObservations,
    claims: claimNormalizationResult.nextClaims,
    events: eventNormalizationResult.nextEvents
  });
  const journalCompactionResult = compactProfileMemoryMutationJournalState({
    state: prunedJournalResult.nextState,
    compaction: graph.compaction,
    recordedAt: input.recordedAt
  });
  const claimCompactionResult = compactProfileMemoryGraphClaims({
    claims: claimNormalizationResult.nextClaims,
    mutationJournal: journalCompactionResult.nextState,
    compaction: journalCompactionResult.nextCompaction,
    recordedAt: input.recordedAt
  });
  const claimSuccessorPruningResult = pruneProfileMemoryGraphClaimSuccessors({
    claims: claimCompactionResult.nextClaims,
    recordedAt: input.recordedAt
  });
  const observationCompactionResult = compactProfileMemoryGraphObservations({
    observations: observationNormalizationResult.nextObservations,
    claims: claimSuccessorPruningResult.nextClaims,
    events: eventNormalizationResult.nextEvents,
    mutationJournal: journalCompactionResult.nextState,
    compaction: claimCompactionResult.nextCompaction,
    recordedAt: input.recordedAt
  });
  const observationLineagePruningResult = pruneProfileMemoryGraphObservationLineage({
    observations: observationCompactionResult.nextObservations,
    claims: claimSuccessorPruningResult.nextClaims,
    events: eventNormalizationResult.nextEvents,
    recordedAt: input.recordedAt
  });
  const projectionSourcePruningResult = pruneProfileMemoryGraphProjectionSources({
    facts: input.state.facts,
    episodes: input.state.episodes.filter(
      (episode) => !redactedEpisodes.some((redactedEpisode) => redactedEpisode.id === episode.id)
    ),
    claims: observationLineagePruningResult.nextClaims,
    events: observationLineagePruningResult.nextEvents,
    recordedAt: input.recordedAt
  });
  const eventCompactionResult = compactProfileMemoryGraphEvents({
    events: projectionSourcePruningResult.nextEvents,
    mutationJournal: journalCompactionResult.nextState,
    compaction: observationCompactionResult.nextCompaction,
    recordedAt: input.recordedAt
  });
  const entityRefPruningResult = pruneProfileMemoryGraphEntityRefs({
    observations: observationCompactionResult.nextObservations,
    claims: projectionSourcePruningResult.nextClaims,
    events: eventCompactionResult.nextEvents,
    recordedAt: input.recordedAt
  });
  if (
    !observationResult.changed &&
    !claimResult.changed &&
    !eventResult.changed &&
    !factRedactionResult.changed &&
    !observationNormalizationResult.changed &&
    !redactionResult.changed &&
    !eventNormalizationResult.changed &&
    !claimNormalizationResult.changed &&
    !journalResult.appended &&
    !prunedJournalResult.changed &&
    !journalCompactionResult.changed &&
    !claimCompactionResult.changed &&
    !claimSuccessorPruningResult.changed &&
    !observationCompactionResult.changed &&
    !observationLineagePruningResult.changed &&
    !projectionSourcePruningResult.changed &&
    !eventCompactionResult.changed &&
    !entityRefPruningResult.changed
  ) {
    return {
      nextState: input.state,
      changed: false
    };
  }
  return {
    nextState: {
      ...input.state,
      updatedAt: input.recordedAt,
      graph: finalizeProfileMemoryGraphState({
        graph,
        updatedAt: input.recordedAt,
        observations: entityRefPruningResult.nextObservations,
        claims: entityRefPruningResult.nextClaims,
        events: entityRefPruningResult.nextEvents,
        mutationJournal: journalCompactionResult.nextState,
        compaction: eventCompactionResult.nextCompaction
      })
    },
    changed: true
  };
}
