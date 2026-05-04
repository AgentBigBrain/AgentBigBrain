/**
 * @fileoverview Tests for Source Recall index lifecycle helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSourceRecallIndexEntry,
  filterVisibleSourceRecallIndexEntries,
  SOURCE_RECALL_INDEX_NAMESPACE,
  updateSourceRecallIndexLifecycle,
  type SourceRecallIndexEntry
} from "../../src/core/sourceRecall/sourceRecallIndex";
import { createSourceRecallRetentionPolicyFromEnv } from "../../src/core/sourceRecall/sourceRecallRetention";

test("Source Recall index entries require explicit indexing policy", () => {
  const disabledPolicy = createSourceRecallRetentionPolicyFromEnv({});
  const enabledPolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_INDEX_ENABLED: "true"
  });

  assert.equal(
    buildSourceRecallIndexEntry(disabledPolicy, {
      chunkId: "chunk_1",
      sourceRecordId: "source_record_1"
    }),
    null
  );
  assert.deepEqual(
    buildSourceRecallIndexEntry(enabledPolicy, {
      chunkId: "chunk_1",
      sourceRecordId: "source_record_1",
      vectorRef: "vector_ref_1"
    }),
    {
      namespace: SOURCE_RECALL_INDEX_NAMESPACE,
      chunkId: "chunk_1",
      sourceRecordId: "source_record_1",
      lifecycleState: "active",
      vectorRef: "vector_ref_1"
    }
  );
});

test("Source Recall index entries hide non-active lifecycle states", () => {
  const entries: SourceRecallIndexEntry[] = [
    {
      namespace: SOURCE_RECALL_INDEX_NAMESPACE,
      chunkId: "chunk_active",
      sourceRecordId: "source_record",
      lifecycleState: "active" as const,
      vectorRef: "vector_active"
    },
    {
      namespace: SOURCE_RECALL_INDEX_NAMESPACE,
      chunkId: "chunk_forgotten",
      sourceRecordId: "source_record",
      lifecycleState: "forgotten" as const,
      vectorRef: "vector_forgotten"
    }
  ];

  assert.deepEqual(
    filterVisibleSourceRecallIndexEntries(entries).map((entry) => entry.chunkId),
    ["chunk_active"]
  );
});

test("Source Recall index lifecycle invalidation removes vector refs for hidden chunks", () => {
  const entries: SourceRecallIndexEntry[] = [
    {
      namespace: SOURCE_RECALL_INDEX_NAMESPACE,
      chunkId: "chunk_1",
      sourceRecordId: "source_record_1",
      lifecycleState: "active" as const,
      vectorRef: "vector_1"
    }
  ];

  const updated = updateSourceRecallIndexLifecycle(entries, ["chunk_1"], "redacted");

  assert.deepEqual(updated, [
    {
      namespace: SOURCE_RECALL_INDEX_NAMESPACE,
      chunkId: "chunk_1",
      sourceRecordId: "source_record_1",
      lifecycleState: "redacted",
      vectorRef: null
    }
  ]);
});
