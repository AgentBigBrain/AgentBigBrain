/**
 * @fileoverview Replay-window clamp helpers shared by graph-state normalization and mutation-journal repair.
 */

import type {
  ProfileMemoryGraphCompactionStateV1,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";

/**
 * Clamps one retained graph compaction snapshot watermark against the actual retained journal
 * prefix before replay repair decides whether legacy coverage is already present.
 *
 * **Why it exists:**
 * Persisted compaction metadata is normalized independently from the retained mutation journal, so
 * an impossible high `snapshotWatermark` can otherwise suppress legacy replay-marker repair before
 * later compaction logic gets a chance to clamp it back down.
 *
 * **What it talks to:**
 * - Uses graph compaction and mutation-journal contracts from `./profileMemoryGraphContracts`.
 * - Uses local retained-journal window calculations within this module.
 *
 * @param input - Canonical retained compaction metadata plus canonical retained journal state.
 * @returns Compaction metadata with a replay-safe snapshot watermark.
 */
export function clampProfileMemoryGraphCompactionSnapshotWatermark(input: {
  compaction: ProfileMemoryGraphCompactionStateV1;
  state: ProfileMemoryMutationJournalStateV1;
}): ProfileMemoryGraphCompactionStateV1 {
  const highestPersistedWatermark = Math.max(0, input.state.nextWatermark - 1);
  const firstRetainedWatermark = input.state.entries.reduce<number | null>(
    (lowest, entry) => lowest === null || entry.watermark < lowest ? entry.watermark : lowest,
    null
  );
  const maxSnapshotWatermark = firstRetainedWatermark === null
    ? highestPersistedWatermark
    : Math.max(0, firstRetainedWatermark - 1);
  const snapshotWatermark = Math.min(input.compaction.snapshotWatermark, maxSnapshotWatermark);
  return snapshotWatermark === input.compaction.snapshotWatermark
    ? input.compaction
    : {
      ...input.compaction,
      snapshotWatermark
    };
}

/**
 * Clamps one retained mutation-journal `nextWatermark` against the retained replay window after
 * compaction metadata is repaired.
 *
 * **Why it exists:**
 * Persisted replay metadata can carry impossible future watermarks even when the retained journal
 * is empty or only keeps a small suffix, so load normalization needs one deterministic clamp
 * before synthetic replay-marker repair or read-model rebuild consume that ghost replay state.
 *
 * **What it talks to:**
 * - Uses graph compaction and mutation-journal contracts from `./profileMemoryGraphContracts`.
 * - Uses local retained-journal window calculations within this module.
 *
 * @param input - Replay-safe compaction metadata plus canonical retained journal state.
 * @returns Mutation-journal state with one replay-safe `nextWatermark`.
 */
export function clampProfileMemoryGraphMutationJournalNextWatermark(input: {
  compaction: ProfileMemoryGraphCompactionStateV1;
  state: ProfileMemoryMutationJournalStateV1;
}): ProfileMemoryMutationJournalStateV1 {
  const highestRetainedWatermark = input.state.entries.reduce(
    (highest, entry) => Math.max(highest, entry.watermark),
    0
  );
  const nextWatermark = Math.max(
    highestRetainedWatermark,
    input.compaction.snapshotWatermark
  ) + 1;
  return nextWatermark === input.state.nextWatermark
    ? input.state
    : {
      ...input.state,
      nextWatermark
    };
}
