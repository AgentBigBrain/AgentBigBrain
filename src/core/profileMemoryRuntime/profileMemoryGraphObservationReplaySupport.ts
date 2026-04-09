/**
 * @fileoverview Synthetic replay-marker helpers for legacy graph observations.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphCompactionStateV1,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";
import { selectRetainedProfileMemoryGraphObservations } from "./profileMemoryGraphObservationCompactionSupport";

/**
 * Collects observation ids that still need one synthetic replay marker because the loaded graph
 * state comes from a legacy uncompacted envelope with missing replay coverage.
 *
 * **Why it exists:**
 * Phase 3 already repairs legacy replay coverage for active graph records, but older persisted
 * states can still carry one non-compacted journal with only partial retained coverage. This
 * helper keeps that repair bounded and centralized so graph normalization can mint one
 * deterministic observation-side replay marker without changing ordinary live ingest behavior.
 *
 * **What it talks to:**
 * - Uses graph observation, compaction, and mutation-journal contracts from
 *   `./profileMemoryGraphContracts`.
 *
 * @param input - Canonical graph observations plus retained mutation-journal state.
 * @returns Sorted non-redacted observation ids still missing replay coverage.
 */
export function collectProfileMemoryGraphReplayBackfillObservationIds(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
  compaction: ProfileMemoryGraphCompactionStateV1;
  mutationJournal: ProfileMemoryMutationJournalStateV1;
  validEpisodeProjectionSourceIds?: ReadonlySet<string>;
}): string[] {
  if (input.compaction.snapshotWatermark > 0) {
    return [];
  }
  const journalObservationIds = new Set(
    input.mutationJournal.entries.flatMap((entry) => entry.observationIds)
  );
  return selectRetainedProfileMemoryGraphObservations({
    observations: input.observations,
    claims: input.claims,
    events: input.events,
    mutationJournal: input.mutationJournal,
    compaction: input.compaction,
    validEpisodeProjectionSourceIds: input.validEpisodeProjectionSourceIds
  })
    .filter(
      (observation) =>
        observation.payload.redactionState !== "redacted" &&
        !journalObservationIds.has(observation.payload.observationId)
    )
    .map((observation) => observation.payload.observationId)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Builds one deterministic source fingerprint for synthetic replay-marker backfill on graph
 * observations already present in persisted state.
 *
 * **Why it exists:**
 * Empty-journal legacy observation repair should remain replay-safe and idempotent, so the
 * normalization path needs one stable synthetic source identity instead of generating ad hoc
 * per-load fingerprints.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from
 *   `../normalizers/canonicalizationRules`.
 *
 * @param observationIds - Graph observation ids missing retained replay coverage.
 * @returns Deterministic synthetic replay-marker fingerprint.
 */
export function buildProfileMemoryGraphObservationReplayBackfillFingerprint(
  observationIds: readonly string[]
): string {
  return `graph_observation_replay_backfill_${sha256HexFromCanonicalJson(
    [...observationIds].sort()
  ).slice(0, 24)}`;
}
