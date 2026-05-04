/**
 * @fileoverview Tests for projection-safe Source Recall read models.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSourceRecallAuthorityFlags,
  type SourceRecallChunk,
  type SourceRecallRecord
} from "../../src/core/sourceRecall/contracts";
import type { SourceRecallDocument } from "../../src/core/sourceRecall/sourceRecallPersistence";
import { buildSourceRecallProjectionEntries } from "../../src/core/sourceRecall/sourceRecallProjection";

test("Source Recall review-safe projection shows bounded excerpts and authority notice", () => {
  const document = buildDocument(
    buildRecord("source_record_projection"),
    [
      buildChunk(
        "chunk_projection",
        "source_record_projection",
        "This source chunk is intentionally longer than the review-safe projection excerpt budget."
      )
    ]
  );

  const entries = buildSourceRecallProjectionEntries(document, {
    mode: "review_safe",
    maxReviewSafeExcerptChars: 24
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.excerpt, "This source chunk is int");
  assert.equal(entries[0]?.redacted, true);
  assert.equal(entries[0]?.operatorFullEnabled, false);
  assert.match(entries[0]?.authorityNotice ?? "", /not runtime truth/i);
  assert.match(entries[0]?.authorityNotice ?? "", /not .*approval/i);
});

test("Source Recall operator-full projection requires an explicit latch", () => {
  const fullText = "Full source chunk text should appear only when operator-full is latched.";
  const document = buildDocument(
    buildRecord("source_record_full"),
    [buildChunk("chunk_full", "source_record_full", fullText)]
  );

  const unlatched = buildSourceRecallProjectionEntries(document, {
    mode: "operator_full",
    maxReviewSafeExcerptChars: 12
  });
  const latched = buildSourceRecallProjectionEntries(document, {
    mode: "operator_full",
    operatorFullSourceRecallProjectionEnabled: true,
    maxReviewSafeExcerptChars: 12
  });

  assert.equal(unlatched[0]?.excerpt, "Full source ");
  assert.equal(unlatched[0]?.operatorFullEnabled, false);
  assert.equal(latched[0]?.excerpt, fullText);
  assert.equal(latched[0]?.operatorFullEnabled, true);
});

test("Source Recall projection hides inactive lifecycle states and sensitive text", () => {
  const document = buildDocument(
    buildRecord("source_record_sensitive", { sensitive: true }),
    [
      buildChunk("chunk_sensitive", "source_record_sensitive", "Sensitive source text."),
      buildChunk("chunk_hidden", "source_record_hidden", "Hidden text.")
    ],
    [buildRecord("source_record_hidden", { lifecycleState: "forgotten" })]
  );

  const entries = buildSourceRecallProjectionEntries(document, {
    mode: "operator_full",
    operatorFullSourceRecallProjectionEnabled: true
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.sourceRecordId, "source_record_sensitive");
  assert.equal(entries[0]?.excerpt.includes("Sensitive source text"), false);
  assert.equal(entries[0]?.excerpt, "[redacted sensitive source chunk]");
});

/**
 * Builds a Source Recall document.
 *
 * @param record - Primary record.
 * @param chunks - Chunks to include.
 * @param extraRecords - Additional records.
 * @returns Source Recall document.
 */
function buildDocument(
  record: SourceRecallRecord,
  chunks: readonly SourceRecallChunk[],
  extraRecords: readonly SourceRecallRecord[] = []
): SourceRecallDocument {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-05-03T20:00:00.000Z",
    records: [record, ...extraRecords],
    chunks: [...chunks]
  };
}

/**
 * Builds a synthetic Source Recall record.
 *
 * @param sourceRecordId - Source record id.
 * @param overrides - Optional field overrides.
 * @returns Source Recall record.
 */
function buildRecord(
  sourceRecordId: string,
  overrides: Partial<SourceRecallRecord> = {}
): SourceRecallRecord {
  return {
    sourceRecordId,
    scopeId: "scope-projection",
    threadId: "thread-projection",
    sourceKind: "conversation_turn",
    sourceRole: "user",
    sourceAuthority: "explicit_user_statement",
    captureClass: "ordinary_source",
    recallAuthority: "quoted_evidence_only",
    lifecycleState: "active",
    originRef: {
      surface: "test",
      refId: `${sourceRecordId}_origin`
    },
    sourceRecordHash: `${sourceRecordId}_hash`,
    observedAt: "2026-05-03T20:00:00.000Z",
    capturedAt: "2026-05-03T20:00:01.000Z",
    sourceTimeKind: "observed_event",
    freshness: "recent",
    sensitive: false,
    ...overrides
  };
}

/**
 * Builds a synthetic Source Recall chunk.
 *
 * @param chunkId - Chunk id.
 * @param sourceRecordId - Source record id.
 * @param text - Chunk text.
 * @returns Source Recall chunk.
 */
function buildChunk(
  chunkId: string,
  sourceRecordId: string,
  text: string
): SourceRecallChunk {
  return {
    chunkId,
    sourceRecordId,
    chunkIndex: 0,
    text,
    chunkHash: `${chunkId}_hash`,
    lifecycleState: "active",
    recallAuthority: "quoted_evidence_only",
    authority: buildSourceRecallAuthorityFlags()
  };
}
