/**
 * @fileoverview Dual-write graph mutation helpers for bounded profile-memory ingestion.
 */

import type { ProfileFactRecord, ProfileMemoryState } from "../profileMemory";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import { compactProfileMemoryGraphClaims } from "./profileMemoryGraphClaimCompactionSupport";
import { pruneProfileMemoryGraphClaimSuccessors } from "./profileMemoryGraphClaimSuccessorSupport";
import { reconcileProfileMemoryCurrentClaims } from "./profileMemoryGraphClaimSupport";
import {
  redactProfileMemoryGraphEvents,
  upsertProfileMemoryGraphEvents
} from "./profileMemoryGraphEventSupport";
import { redactProfileMemoryGraphFacts } from "./profileMemoryGraphFactRedactionSupport";
import { compactProfileMemoryGraphEvents } from "./profileMemoryGraphEventCompactionSupport";
import { pruneProfileMemoryGraphEntityRefs } from "./profileMemoryGraphEntityRefSupport";
import {
  compactProfileMemoryGraphObservations
} from "./profileMemoryGraphObservationCompactionSupport";
import { pruneProfileMemoryGraphObservationLineage } from "./profileMemoryGraphObservationLineageSupport";
import { upsertProfileMemoryGraphObservations } from "./profileMemoryGraphObservationSupport";
import { pruneProfileMemoryGraphProjectionSources } from "./profileMemoryGraphProjectionSourceSupport";
import {
  attachProfileMemoryGraphStableRefs,
  resolveProfileMemoryGraphClaimStableRefId,
  resolveProfileMemoryGraphEventStableRefId,
  resolveProfileMemoryGraphObservationStableRefId
} from "./profileMemoryGraphQueries";
import { createEmptyProfileMemoryGraphState } from "./profileMemoryGraphState";
import {
  finalizeProfileMemoryGraphState,
  firstNonEmptyString
} from "./profileMemoryGraphStateSupport";
import { appendProfileMemoryGraphDecisionRecord } from "./profileMemoryGraphDecisionRecordSupport";
import { rekeyProfileMemoryGraphRecords } from "./profileMemoryGraphStableRefRekeySupport";
import {
  normalizeProfileMemoryGraphClaimRecords,
  normalizeProfileMemoryGraphEventRecords,
  normalizeProfileMemoryGraphObservationRecords
} from "./profileMemoryGraphTimeNormalizationSupport";
import {
  appendProfileMemoryMutationJournalEntry,
  compactProfileMemoryMutationJournalState
} from "./profileMemoryMutationJournal";
import { pruneProfileMemoryGraphMutationJournalReferences } from "./profileMemoryMutationJournalReferenceSupport";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import type { GovernedProfileFactCandidate } from "./profileMemoryTruthGovernanceContracts";

export interface ProfileMemoryGraphMutationInput {
  state: ProfileMemoryState;
  factDecisions: readonly GovernedProfileFactCandidate[];
  touchedEpisodes: readonly ProfileEpisodeRecord[];
  redactedEpisodes?: readonly ProfileEpisodeRecord[];
  redactedFacts?: readonly ProfileFactRecord[];
  sourceTaskId?: string | null;
  sourceFingerprint: string;
  mutationEnvelopeHash: string | null;
  recordedAt: string;
}

export interface ProfileMemoryGraphStableRefRekeyInput {
  state: ProfileMemoryState;
  fromStableRefId: string;
  toStableRefId: string;
  sourceTaskId?: string | null;
  sourceFingerprint: string;
  mutationEnvelopeHash: string | null;
  recordedAt: string;
}

/**
 * Applies one bounded graph mutation batch under the stable profile-memory store seam.
 *
 * @param input - Canonical post-mutation state plus governed fact and episode mutations.
 * @returns Updated profile state and whether the additive graph changed.
 */
export function applyProfileMemoryGraphMutations(
  input: ProfileMemoryGraphMutationInput
): { nextState: ProfileMemoryState; changed: boolean } {
  const observationDecisions = input.factDecisions.filter(
    (entry) => entry.decision.action !== "quarantine"
  );
  const redactedEpisodes = input.redactedEpisodes ?? [];
  const redactedFacts = input.redactedFacts ?? [];
  if (
    observationDecisions.length === 0 &&
    input.touchedEpisodes.length === 0 &&
    redactedEpisodes.length === 0 &&
    redactedFacts.length === 0
  ) {
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
    redactionState:
      redactionResult.changed || factRedactionResult.changed
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
  const stableRefAttachmentResult = attachProfileMemoryGraphStableRefs({
    observations: entityRefPruningResult.nextObservations,
    claims: entityRefPruningResult.nextClaims,
    events: entityRefPruningResult.nextEvents,
    touchedObservationIds: [
      ...observationResult.touchedObservationIds,
      ...factRedactionResult.touchedObservationIds
    ],
    touchedClaimIds: [
      ...claimResult.touchedClaimIds,
      ...factRedactionResult.touchedClaimIds
    ],
    touchedEventIds: [...eventResult.touchedEventIds, ...redactionResult.touchedEventIds],
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
    !entityRefPruningResult.changed &&
    !stableRefAttachmentResult.changed
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
        observations: stableRefAttachmentResult.nextObservations,
        claims: stableRefAttachmentResult.nextClaims,
        events: stableRefAttachmentResult.nextEvents,
        mutationJournal: journalCompactionResult.nextState,
        compaction: eventCompactionResult.nextCompaction
      })
    },
    changed: true
  };
}

/**
 * Rekeys one bounded personal-memory stable-ref lane without invoking Stage 6.86 alignment.
 *
 * @param input - Canonical graph state plus the explicit from/to stable ref rewrite request.
 * @returns Updated profile state and whether any graph-backed records changed.
 */
export function applyProfileMemoryGraphStableRefRekey(
  input: ProfileMemoryGraphStableRefRekeyInput
): { nextState: ProfileMemoryState; changed: boolean } {
  const graph = input.state.graph ?? createEmptyProfileMemoryGraphState(input.recordedAt);
  const observationResult = rekeyProfileMemoryGraphRecords({
    observations: graph.observations,
    fromStableRefId: input.fromStableRefId,
    toStableRefId: input.toStableRefId,
    recordedAt: input.recordedAt,
    getRecordId: (observation) => observation.payload.observationId,
    resolveStableRefId: resolveProfileMemoryGraphObservationStableRefId,
    schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
  });
  const claimResult = rekeyProfileMemoryGraphRecords({
    observations: graph.claims,
    fromStableRefId: input.fromStableRefId,
    toStableRefId: input.toStableRefId,
    recordedAt: input.recordedAt,
    getRecordId: (claim) => claim.payload.claimId,
    resolveStableRefId: resolveProfileMemoryGraphClaimStableRefId,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME
  });
  const eventResult = rekeyProfileMemoryGraphRecords({
    observations: graph.events,
    fromStableRefId: input.fromStableRefId,
    toStableRefId: input.toStableRefId,
    recordedAt: input.recordedAt,
    getRecordId: (event) => event.payload.eventId,
    resolveStableRefId: resolveProfileMemoryGraphEventStableRefId,
    schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME
  });
  if (!observationResult.changed && !claimResult.changed && !eventResult.changed) {
    return {
      nextState: input.state,
      changed: false
    };
  }
  const journalResult = appendProfileMemoryMutationJournalEntry(graph.mutationJournal, {
    recordedAt: input.recordedAt,
    sourceTaskId: input.sourceTaskId ?? null,
    sourceFingerprint: input.sourceFingerprint,
    mutationEnvelopeHash: input.mutationEnvelopeHash,
    observationIds: observationResult.touchedRecordIds,
    claimIds: claimResult.touchedRecordIds,
    eventIds: eventResult.touchedRecordIds,
    redactionState: "not_requested"
  });
  const journalCompactionResult = compactProfileMemoryMutationJournalState({
    state: journalResult.nextState,
    compaction: graph.compaction,
    recordedAt: input.recordedAt
  });
  const nextDecisionRecords = appendProfileMemoryGraphDecisionRecord(
    graph.decisionRecords ?? [],
    {
      action: "rekey",
      recordedAt: input.recordedAt,
      fromStableRefId: input.fromStableRefId,
      toStableRefId: input.toStableRefId,
      sourceTaskId: input.sourceTaskId ?? null,
      sourceFingerprint: input.sourceFingerprint,
      mutationEnvelopeHash: input.mutationEnvelopeHash,
      observationIds: observationResult.touchedRecordIds,
      claimIds: claimResult.touchedRecordIds,
      eventIds: eventResult.touchedRecordIds
    }
  );
  return {
    nextState: {
      ...input.state,
      updatedAt: input.recordedAt,
      graph: finalizeProfileMemoryGraphState({
        graph: {
          ...graph,
          decisionRecords: nextDecisionRecords
        },
        updatedAt: input.recordedAt,
        observations: observationResult.nextRecords,
        claims: claimResult.nextRecords,
        events: eventResult.nextRecords,
        mutationJournal: journalCompactionResult.nextState,
        compaction: journalCompactionResult.nextCompaction
      })
    },
    changed: true
  };
}
