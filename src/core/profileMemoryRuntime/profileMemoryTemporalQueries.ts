/**
 * @fileoverview Bounded graph-backed retrieval for temporal profile-memory synthesis.
 */

import type { ProfileMemoryState } from "../profileMemory";
import {
  type ProfileMemoryGraphClaimRecord,
  type ProfileMemoryGraphEventRecord,
  type ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import {
  queryProfileMemoryGraphStableRefGroups,
  resolveProfileMemoryGraphClaimStableRefId,
  resolveProfileMemoryGraphEventStableRefIds,
  resolveProfileMemoryGraphObservationStableRefId
} from "./profileMemoryGraphQueries";
import {
  type ProfileMemoryTemporalClaimFamilySlice,
  type ProfileMemoryTemporalEvidenceSlice,
  type ProfileMemoryTemporalFocusEntitySlice,
  type ProfileMemoryTemporalObservationEvidence,
  type ProfileMemoryTemporalQueryRequest
} from "./profileMemoryTemporalQueryContracts";
import {
  buildSupportingObservationSelection,
  classifyClaimLifecycle,
  classifyEventLifecycle,
  compareRankedTuple,
  isRecordVisibleAtObservedBoundary,
  normalizeTemporalCaps,
  scoreClaimForRetrieval,
  scoreEventForRetrieval,
  toClaimEvidence,
  toEventEvidence,
  toLifecycleBuckets,
  toObservationEvidence
} from "./profileMemoryTemporalQueryEvidenceSupport";
import { selectFocusGroups } from "./profileMemoryTemporalQuerySupport";

/**
 * Fetches a bounded graph-backed evidence slice for one task-conditioned temporal query without
 * choosing a winner.
 */
export function queryProfileMemoryTemporalEvidence(
  state: ProfileMemoryState,
  request: ProfileMemoryTemporalQueryRequest
): ProfileMemoryTemporalEvidenceSlice {
  const caps = normalizeTemporalCaps(request.caps);
  const degradedNotes: string[] = [];
  const allGroups = queryProfileMemoryGraphStableRefGroups(state.graph);
  const allObservationsById = new Map(
    state.graph.observations.map((observation) => [observation.payload.observationId, observation])
  );
  const claimsByStableRefId = new Map<string, ProfileMemoryGraphClaimRecord[]>();
  const eventsByStableRefId = new Map<string, ProfileMemoryGraphEventRecord[]>();
  const observationsByStableRefId = new Map<string, ProfileMemoryGraphObservationRecord[]>();

  for (const observation of state.graph.observations) {
    if (!isRecordVisibleAtObservedBoundary(observation.payload.observedAt, request.asOfObservedTime ?? null)) {
      continue;
    }
    const stableRefId = resolveProfileMemoryGraphObservationStableRefId(observation);
    if (!stableRefId) {
      continue;
    }
    const bucket = observationsByStableRefId.get(stableRefId) ?? [];
    bucket.push(observation);
    observationsByStableRefId.set(stableRefId, bucket);
  }

  for (const claim of state.graph.claims) {
    if (!isRecordVisibleAtObservedBoundary(claim.payload.assertedAt, request.asOfObservedTime ?? null)) {
      continue;
    }
    const stableRefId = resolveProfileMemoryGraphClaimStableRefId(claim);
    if (!stableRefId) {
      continue;
    }
    const bucket = claimsByStableRefId.get(stableRefId) ?? [];
    bucket.push(claim);
    claimsByStableRefId.set(stableRefId, bucket);
  }

  for (const event of state.graph.events) {
    if (!isRecordVisibleAtObservedBoundary(event.payload.observedAt, request.asOfObservedTime ?? null)) {
      continue;
    }
    for (const stableRefId of resolveProfileMemoryGraphEventStableRefIds(event)) {
      const bucket = eventsByStableRefId.get(stableRefId) ?? [];
      bucket.push(event);
      eventsByStableRefId.set(stableRefId, bucket);
    }
  }

  const focusGroups = selectFocusGroups(
    request,
    allGroups,
    claimsByStableRefId,
    eventsByStableRefId,
    observationsByStableRefId,
    caps,
    degradedNotes
  );

  const focusEntities: ProfileMemoryTemporalFocusEntitySlice[] = focusGroups.map(
    ({ group, matchedHintTerms }) => {
      const focusDegradedNotes: string[] = [];
      const focusObservationsById = new Map<string, ProfileMemoryTemporalObservationEvidence>();
      const claimFamilies = new Map<string, ProfileMemoryGraphClaimRecord[]>();
      const groupedClaims = (claimsByStableRefId.get(group.stableRefId) ?? [])
        .slice()
        .sort((left, right) => compareRankedTuple(scoreClaimForRetrieval(left), scoreClaimForRetrieval(right)));

      for (const claim of groupedClaims) {
        const familyClaims = claimFamilies.get(claim.payload.family) ?? [];
        familyClaims.push(claim);
        claimFamilies.set(claim.payload.family, familyClaims);
      }

      const selectedClaimFamilies: ProfileMemoryTemporalClaimFamilySlice[] = [...claimFamilies.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .slice(0, caps.maxClaimFamiliesPerFocusEntity)
        .map(([family, familyClaims]) => {
          const lifecycleIds = {
            current: [] as string[],
            historical: [] as string[],
            ended: [] as string[]
          };
          const selectedClaims = familyClaims
            .slice(0, caps.maxCandidateClaimsPerFamily)
            .map((claim) => {
              const lifecycle = classifyClaimLifecycle(claim, request.asOfValidTime ?? null);
              lifecycleIds[lifecycle].push(claim.payload.claimId);
              const supportingSelection = buildSupportingObservationSelection(
                claim.payload.derivedFromObservationIds,
                allObservationsById,
                caps,
                focusDegradedNotes
              );
              for (const observation of supportingSelection.selectedObservations) {
                focusObservationsById.set(
                  observation.payload.observationId,
                  toObservationEvidence(observation)
                );
              }
              return toClaimEvidence(claim, supportingSelection.supportingObservationIds);
            });
          if (familyClaims.length > caps.maxCandidateClaimsPerFamily) {
            focusDegradedNotes.push(
              `bounded_overflow:${familyClaims.length - caps.maxCandidateClaimsPerFamily} claims omitted for ${family}`
            );
          }
          return {
            family: family as ProfileMemoryTemporalClaimFamilySlice["family"],
            claims: selectedClaims,
            lifecycleBuckets: toLifecycleBuckets(lifecycleIds, caps.maxCandidateClaimsPerFamily)
          };
        });

      if (claimFamilies.size > caps.maxClaimFamiliesPerFocusEntity) {
        focusDegradedNotes.push(
          `bounded_overflow:${claimFamilies.size - caps.maxClaimFamiliesPerFocusEntity} claim families omitted`
        );
      }

      const lifecycleEventIds = {
        current: [] as string[],
        historical: [] as string[],
        ended: [] as string[]
      };
      const selectedEvents = (eventsByStableRefId.get(group.stableRefId) ?? [])
        .slice()
        .sort((left, right) => compareRankedTuple(scoreEventForRetrieval(left), scoreEventForRetrieval(right)))
        .slice(0, caps.maxEventsPerFocusEntity)
        .map((event) => {
          const lifecycle = classifyEventLifecycle(event, request.asOfValidTime ?? null);
          lifecycleEventIds[lifecycle].push(event.payload.eventId);
          const supportingSelection = buildSupportingObservationSelection(
            event.payload.derivedFromObservationIds,
            allObservationsById,
            caps,
            focusDegradedNotes
          );
          for (const observation of supportingSelection.selectedObservations) {
            focusObservationsById.set(
              observation.payload.observationId,
              toObservationEvidence(observation)
            );
          }
          return toEventEvidence(event, supportingSelection.supportingObservationIds);
        });

      const allEvents = eventsByStableRefId.get(group.stableRefId) ?? [];
      for (const event of allEvents.slice(caps.maxEventsPerFocusEntity)) {
        const lifecycle = classifyEventLifecycle(event, request.asOfValidTime ?? null);
        lifecycleEventIds[lifecycle].push(event.payload.eventId);
      }
      if (allEvents.length > caps.maxEventsPerFocusEntity) {
        focusDegradedNotes.push(
          `bounded_overflow:${allEvents.length - caps.maxEventsPerFocusEntity} events omitted`
        );
      }

      return {
        stableRefId: group.stableRefId,
        resolution: group.resolution,
        matchedHintTerms,
        claimFamilies: selectedClaimFamilies,
        eventSlice: {
          events: selectedEvents,
          lifecycleBuckets: toLifecycleBuckets(lifecycleEventIds, caps.maxEventsPerFocusEntity)
        },
        observationsById: Object.fromEntries(focusObservationsById.entries()),
        degradedNotes: focusDegradedNotes
      } satisfies ProfileMemoryTemporalFocusEntitySlice;
    }
  );

  return {
    semanticMode: request.semanticMode,
    relevanceScope: request.relevanceScope,
    asOfValidTime: request.asOfValidTime ?? null,
    asOfObservedTime: request.asOfObservedTime ?? null,
    caps,
    focusEntities,
    degradedNotes
  };
}
