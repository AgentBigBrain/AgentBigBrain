/**
 * @fileoverview Deterministic temporal synthesis over bounded graph-backed evidence slices.
 */

import type {
  ProfileMemoryTemporalAnswerMode,
  ProfileMemoryTemporalEvidenceSlice,
  ProfileMemoryTemporalLaneKind,
  ProfileMemoryTemporalLaneMetadata,
  TemporalMemorySynthesis
} from "./profileMemoryTemporalQueryContracts";
import {
  formatEventLine,
  inferLaneAnswerMode,
  synthesizeFamilyLane
} from "./profileMemoryTemporalSynthesisSupport";

/**
 * Builds bounded contradiction notes when one user hint resolves to multiple focus entities.
 *
 * @param slice - Temporal evidence slice under synthesis.
 * @returns Deterministic contradiction notes for cross-focus ambiguity.
 */
function buildCrossFocusAmbiguityNotes(
  slice: ProfileMemoryTemporalEvidenceSlice
): readonly string[] {
  if (slice.focusEntities.length <= 1) {
    return [];
  }
  const overlappingTerms = new Map<string, number>();
  for (const focusEntity of slice.focusEntities) {
    for (const term of new Set(focusEntity.matchedHintTerms)) {
      overlappingTerms.set(term, (overlappingTerms.get(term) ?? 0) + 1);
    }
  }
  return [...overlappingTerms.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([term]) => `multiple people match ${term}`)
    .slice(0, slice.caps.maxContradictionNotes);
}

/**
 * Derives compact current, historical, and contradiction surfaces from one bounded temporal slice.
 */
export function synthesizeProfileMemoryTemporalEvidence(
  slice: ProfileMemoryTemporalEvidenceSlice
): TemporalMemorySynthesis {
  const currentState: string[] = [];
  const historicalContext: string[] = [];
  const contradictionNotes: string[] = [...buildCrossFocusAmbiguityNotes(slice)];
  const laneMetadata: ProfileMemoryTemporalLaneMetadata[] = [];
  const proofDegradedNotes = [...slice.degradedNotes];

  for (const focusEntity of slice.focusEntities) {
    for (const familySlice of focusEntity.claimFamilies) {
      const synthesizedFamily = synthesizeFamilyLane(
        focusEntity.stableRefId,
        focusEntity.resolution,
        familySlice
      );
      currentState.push(...synthesizedFamily.currentStateLines);
      historicalContext.push(...synthesizedFamily.historicalLines);
      contradictionNotes.push(...synthesizedFamily.contradictionLines);
      laneMetadata.push({
        ...synthesizedFamily.laneMetadata,
        degradedNotes: [...focusEntity.degradedNotes]
      });
    }

    const eventLaneId = `${focusEntity.stableRefId}:event_history`;
    const eventCurrent = focusEntity.eventSlice.events.filter((event) =>
      focusEntity.eventSlice.lifecycleBuckets.current.includes(event.eventId)
    );
    const eventHistorical = focusEntity.eventSlice.events.filter((event) =>
      focusEntity.eventSlice.lifecycleBuckets.historical.includes(event.eventId) ||
      focusEntity.eventSlice.lifecycleBuckets.ended.includes(event.eventId)
    );
    const eventObservationIds = [...new Set(
      focusEntity.eventSlice.events.flatMap((event) => event.supportingObservationIds)
    )].sort((left, right) => left.localeCompare(right));
    const eventDominantLane: ProfileMemoryTemporalLaneKind =
      focusEntity.resolution === "quarantined"
        ? "quarantined_identity"
        : eventCurrent.length > 0
          ? "current_state"
          : eventHistorical.length > 0
            ? "historical_context"
            : "insufficient_evidence";

    if (slice.semanticMode === "event_history" || eventCurrent.length > 0) {
      currentState.push(...eventCurrent.map((event) => formatEventLine(event.title, event.summary)));
    }
    historicalContext.push(...eventHistorical.map((event) => formatEventLine(event.title, event.summary)));
    laneMetadata.push({
      laneId: eventLaneId,
      focusStableRefId: focusEntity.stableRefId,
      family: null,
      answerMode: inferLaneAnswerMode(eventDominantLane),
      dominantLane: eventDominantLane,
      supportingLanes: eventHistorical.length > 0 ? ["historical_context"] : [],
      chosenClaimId: null,
      supportingObservationIds: eventObservationIds,
      rejectedClaims: [],
      lifecycleBuckets: focusEntity.eventSlice.lifecycleBuckets,
      degradedNotes: [...focusEntity.degradedNotes]
    });
    proofDegradedNotes.push(...focusEntity.degradedNotes);
  }

  const boundedContradictionNotes = contradictionNotes.slice(0, slice.caps.maxContradictionNotes);
  let answerMode: ProfileMemoryTemporalAnswerMode = "insufficient_evidence";
  if (slice.focusEntities.length > 0 && slice.focusEntities.every((focusEntity) => focusEntity.resolution === "quarantined")) {
    answerMode = "quarantined_identity";
  } else if (currentState.length > 0) {
    answerMode = boundedContradictionNotes.length > 0 ? "ambiguous" : "current";
  } else if (historicalContext.length > 0) {
    answerMode = "historical";
  } else if (boundedContradictionNotes.length > 0) {
    answerMode = "ambiguous";
  }

  return {
    currentState,
    historicalContext,
    contradictionNotes: boundedContradictionNotes,
    answerMode,
    proof: {
      synthesisVersion: "v1",
      semanticMode: slice.semanticMode,
      relevanceScope: slice.relevanceScope,
      asOfValidTime: slice.asOfValidTime,
      asOfObservedTime: slice.asOfObservedTime,
      focusStableRefIds: slice.focusEntities.map((focusEntity) => focusEntity.stableRefId),
      degradedNotes: [...new Set(proofDegradedNotes)].sort((left, right) => left.localeCompare(right))
    },
    laneMetadata
  };
}
