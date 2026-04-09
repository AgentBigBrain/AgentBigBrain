/**
 * @fileoverview Synthetic replay-backfill journal append helpers for graph-backed state.
 */

import { buildProfileMemoryGraphClaimReplayBackfillFingerprint } from "./profileMemoryGraphClaimReplaySupport";
import { buildProfileMemoryGraphEventReplayBackfillFingerprint } from "./profileMemoryGraphEventSupport";
import { buildProfileMemoryGraphObservationReplayBackfillFingerprint } from "./profileMemoryGraphObservationReplaySupport";
import type { ProfileMemoryMutationJournalStateV1 } from "./profileMemoryGraphContracts";
import { appendProfileMemoryMutationJournalEntry } from "./profileMemoryMutationJournal";

/**
 * Appends any needed synthetic replay-backfill journal entries in deterministic order.
 *
 * @param input - Current journal state plus missing replay coverage ids.
 * @returns Journal state after synthetic replay-entry append.
 */
export function appendProfileMemoryGraphReplayBackfillEntries(input: {
  state: ProfileMemoryMutationJournalStateV1;
  recordedAt: string;
  observationIds: readonly string[];
  claimIds: readonly string[];
  eventIds: readonly string[];
}): ProfileMemoryMutationJournalStateV1 {
  let state = input.state;
  if (input.eventIds.length > 0) {
    state = appendProfileMemoryMutationJournalEntry(state, {
      recordedAt: input.recordedAt,
      sourceTaskId: null,
      sourceFingerprint: buildProfileMemoryGraphEventReplayBackfillFingerprint(input.eventIds),
      mutationEnvelopeHash: null,
      observationIds: [],
      claimIds: [],
      eventIds: input.eventIds,
      redactionState: "not_requested"
    }).nextState;
  }
  if (input.observationIds.length > 0) {
    state = appendProfileMemoryMutationJournalEntry(state, {
      recordedAt: input.recordedAt,
      sourceTaskId: null,
      sourceFingerprint: buildProfileMemoryGraphObservationReplayBackfillFingerprint(
        input.observationIds
      ),
      mutationEnvelopeHash: null,
      observationIds: input.observationIds,
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).nextState;
  }
  if (input.claimIds.length > 0) {
    state = appendProfileMemoryMutationJournalEntry(state, {
      recordedAt: input.recordedAt,
      sourceTaskId: null,
      sourceFingerprint: buildProfileMemoryGraphClaimReplayBackfillFingerprint(input.claimIds),
      mutationEnvelopeHash: null,
      observationIds: [],
      claimIds: input.claimIds,
      eventIds: [],
      redactionState: "not_requested"
    }).nextState;
  }
  return state;
}
