/**
 * @fileoverview Canonical mutation-journal replay-id helpers.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type { ProfileMemoryMutationJournalEntryV1 } from "./profileMemoryGraphContracts";

type ProfileMemoryMutationJournalReplayIdPayload = Pick<
  ProfileMemoryMutationJournalEntryV1,
  "recordedAt" |
  "sourceTaskId" |
  "sourceFingerprint" |
  "mutationEnvelopeHash" |
  "observationIds" |
  "claimIds" |
  "eventIds" |
  "redactionState"
>;

/**
 * Builds one deterministic mutation-journal entry id from the bounded replay payload.
 *
 * @param payload - Replay-stable journal payload.
 * @returns Deterministic journal entry id.
 */
export function buildProfileMemoryMutationJournalEntryId(
  payload: ProfileMemoryMutationJournalReplayIdPayload
): string {
  return `journal_${sha256HexFromCanonicalJson(payload).slice(0, 24)}`;
}

/**
 * Builds the canonical replay id for one existing retained journal entry.
 *
 * @param entry - Existing retained journal entry.
 * @returns Canonical replay id for the entry payload.
 */
export function buildProfileMemoryMutationJournalCanonicalEntryId(
  entry: ProfileMemoryMutationJournalReplayIdPayload
): string {
  return buildProfileMemoryMutationJournalEntryId({
    recordedAt: entry.recordedAt,
    sourceTaskId: entry.sourceTaskId,
    sourceFingerprint: entry.sourceFingerprint,
    mutationEnvelopeHash: entry.mutationEnvelopeHash,
    observationIds: entry.observationIds,
    claimIds: entry.claimIds,
    eventIds: entry.eventIds,
    redactionState: entry.redactionState
  });
}
