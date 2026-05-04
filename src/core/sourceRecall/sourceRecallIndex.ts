/**
 * @fileoverview Index lifecycle helpers for Source Recall chunk retrieval metadata.
 */

import {
  isSourceRecallLifecycleVisible
} from "./sourceRecallPersistence";
import type {
  SourceRecallLifecycleState
} from "./contracts";
import {
  decideSourceRecallIndexing,
  type SourceRecallRetentionPolicy
} from "./sourceRecallRetention";

export const SOURCE_RECALL_INDEX_NAMESPACE = "source_recall_chunks";

export interface SourceRecallIndexEntry {
  namespace: typeof SOURCE_RECALL_INDEX_NAMESPACE;
  chunkId: string;
  sourceRecordId: string;
  lifecycleState: SourceRecallLifecycleState;
  vectorRef: string | null;
}

/**
 * Builds one Source Recall index entry when indexing policy allows it.
 *
 * **Why it exists:**
 * Index entries should be tied only to chunk ids and the Source Recall namespace, never raw text or
 * semantic-memory lesson ids.
 *
 * **What it talks to:**
 * - Uses `decideSourceRecallIndexing` from `./sourceRecallRetention`.
 *
 * @param policy - Current retention/indexing policy.
 * @param input - Chunk id, source record id, lifecycle state, and optional vector ref.
 * @returns Index entry, or `null` when indexing is disabled.
 */
export function buildSourceRecallIndexEntry(
  policy: SourceRecallRetentionPolicy,
  input: {
    chunkId: string;
    sourceRecordId: string;
    lifecycleState?: SourceRecallLifecycleState;
    vectorRef?: string | null;
  }
): SourceRecallIndexEntry | null {
  if (!decideSourceRecallIndexing(policy).allowed) {
    return null;
  }
  return {
    namespace: SOURCE_RECALL_INDEX_NAMESPACE,
    chunkId: input.chunkId,
    sourceRecordId: input.sourceRecordId,
    lifecycleState: input.lifecycleState ?? "active",
    vectorRef: input.vectorRef ?? null
  };
}

/**
 * Filters index entries to entries still visible for normal retrieval.
 *
 * **Why it exists:**
 * Forgotten, redacted, expired, quarantined, or projection-only removed chunks must not stay
 * retrievable through an index after the underlying chunk lifecycle changes.
 *
 * **What it talks to:**
 * - Uses `isSourceRecallLifecycleVisible` from `./sourceRecallPersistence`.
 *
 * @param entries - Candidate Source Recall index entries.
 * @returns Visible index entries only.
 */
export function filterVisibleSourceRecallIndexEntries(
  entries: readonly SourceRecallIndexEntry[]
): SourceRecallIndexEntry[] {
  return entries.filter((entry) => isSourceRecallLifecycleVisible(entry.lifecycleState));
}

/**
 * Updates lifecycle metadata for index entries attached to hidden chunks.
 *
 * **Why it exists:**
 * Delete/redaction cascades need a deterministic way to invalidate index entries without leaving
 * vector references reachable.
 *
 * **What it talks to:**
 * - Uses local type contracts within this module.
 *
 * @param entries - Existing Source Recall index entries.
 * @param chunkIds - Chunk ids whose lifecycle changed.
 * @param lifecycleState - New lifecycle state.
 * @returns Updated entries with vector refs removed for hidden chunks.
 */
export function updateSourceRecallIndexLifecycle(
  entries: readonly SourceRecallIndexEntry[],
  chunkIds: readonly string[],
  lifecycleState: SourceRecallLifecycleState
): SourceRecallIndexEntry[] {
  const chunkIdSet = new Set(chunkIds);
  return entries.map((entry) => {
    if (!chunkIdSet.has(entry.chunkId)) {
      return entry;
    }
    return {
      ...entry,
      lifecycleState,
      vectorRef: isSourceRecallLifecycleVisible(lifecycleState) ? entry.vectorRef : null
    };
  });
}
