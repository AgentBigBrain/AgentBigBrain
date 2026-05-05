/**
 * @fileoverview Tests for exact Source Recall retrieval and bounded audit metadata.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildSourceRecallAuthorityFlags,
  type SourceRecallChunk,
  type SourceRecallRecord
} from "../../src/core/sourceRecall/contracts";
import {
  DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
  retrieveSourceRecall
} from "../../src/core/sourceRecall/sourceRecallRetriever";
import { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";

test("retrieveSourceRecall returns exact quote recall as non-authoritative evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-retrieve-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const record = buildRecord("source_record_quote", "scope-a", "thread-a");

  try {
    await store.upsertSourceRecord(record, [
      buildChunk(
        "chunk_quote_1",
        record.sourceRecordId,
        0,
        "We chose the static HTML path because the user wanted a simple reviewable artifact."
      )
    ]);

    const result = await retrieveSourceRecall(store, {
      scopeId: "scope-a",
      threadId: "thread-a",
      exactQuote: "static HTML path"
    });

    assert.equal(result.bundle.retrievalMode, "exact_quote");
    assert.equal(result.bundle.retrievalAuthority, "strong_recall_evidence");
    assert.equal(result.bundle.excerpts.length, 1);
    assert.match(result.bundle.excerpts[0]?.excerpt ?? "", /static HTML path/);
    assert.deepEqual(result.bundle.authority, buildSourceRecallAuthorityFlags());
    assert.equal(result.bundle.excerpts[0]?.authority.currentTruthAuthority, false);
    assert.equal(result.bundle.excerpts[0]?.authority.approvalAuthority, false);
    assert.equal(result.bundle.excerpts[0]?.authority.completionProofAuthority, false);
    assert.equal(result.auditEvent.totalExcerptsReturned, 1);
    assert.equal(result.auditEvent.returnedSourceRecordIds[0], record.sourceRecordId);
    assert.equal(result.auditEvent.queryHash.includes("static HTML path"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrieveSourceRecall labels exact source refs with exact_source_ref authority", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-source-id-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const record = buildRecord("source_record_exact", "scope-a", "thread-a");

  try {
    await store.upsertSourceRecord(record, [
      buildChunk("chunk_exact_1", record.sourceRecordId, 0, "Exact source record text.")
    ]);

    const result = await retrieveSourceRecall(store, {
      sourceRecordId: record.sourceRecordId
    });

    assert.equal(result.bundle.retrievalMode, "source_id");
    assert.equal(result.bundle.retrievalAuthority, "exact_source_ref");
    assert.equal(result.auditEvent.retrievalMode, "source_id");
    assert.deepEqual(result.auditEvent.returnedChunkIds, ["chunk_exact_1"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrieveSourceRecall enforces output budgets and source-kind allowlists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-budget-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const recordOne = buildRecord("source_record_budget_1", "scope-a", "thread-a");
  const recordTwo = buildRecord("source_record_budget_2", "scope-a", "thread-a", {
    sourceKind: "assistant_turn",
    sourceRole: "assistant",
    captureClass: "assistant_output"
  });

  try {
    await store.upsertSourceRecord(recordOne, [
      buildChunk("chunk_budget_1", recordOne.sourceRecordId, 0, "A".repeat(100))
    ]);
    await store.upsertSourceRecord(recordTwo, [
      buildChunk("chunk_budget_2", recordTwo.sourceRecordId, 0, "B".repeat(100))
    ]);

    const result = await retrieveSourceRecall(
      store,
      {
        scopeId: "scope-a",
        threadId: "thread-a"
      },
      {
        ...DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
        maxRecords: 1,
        maxChunks: 1,
        maxExcerptCharsPerChunk: 12,
        maxTotalExcerptChars: 12,
        sourceKindAllowlist: ["conversation_turn"],
        sensitivityRedactionPolicy: "redact_sensitive"
      }
    );

    assert.equal(result.bundle.excerpts.length, 1);
    assert.equal(result.bundle.excerpts[0]?.excerpt.length, 12);
    assert.equal(result.bundle.excerpts[0]?.sourceRecordId, recordOne.sourceRecordId);
    assert.equal(result.auditEvent.totalCharsReturned, 12);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrieveSourceRecall redacts or excludes sensitive records by budget policy", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-sensitive-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const record = buildRecord("source_record_sensitive", "scope-a", "thread-a", {
    sensitive: true
  });

  try {
    await store.upsertSourceRecord(record, [
      buildChunk("chunk_sensitive_1", record.sourceRecordId, 0, "Sensitive quoted text.")
    ]);

    const redacted = await retrieveSourceRecall(store, {
      sourceRecordId: record.sourceRecordId
    });
    assert.equal(redacted.bundle.excerpts[0]?.redacted, true);
    assert.equal(redacted.bundle.excerpts[0]?.excerpt.includes("Sensitive quoted text"), false);

    const excluded = await retrieveSourceRecall(
      store,
      {
        sourceRecordId: record.sourceRecordId
      },
      {
        ...DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
        sensitivityRedactionPolicy: "exclude_sensitive"
      }
    );
    assert.equal(excluded.bundle.excerpts.length, 0);
    assert.equal(excluded.auditEvent.blockedRedactedCount, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrieveSourceRecall excludes redacted chunks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-redacted-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const record = buildRecord("source_record_redacted", "scope-a", "thread-a");

  try {
    await store.upsertSourceRecord(record, [
      buildChunk("chunk_redacted_1", record.sourceRecordId, 0, "Now hidden text.")
    ]);
    await store.markSourceRecordsByOriginParentRef("origin-parent-redacted", "redacted");
    const result = await retrieveSourceRecall(store, {
      sourceRecordId: record.sourceRecordId
    });

    assert.deepEqual(result.bundle.excerpts, []);
    assert.equal(result.auditEvent.blockedRedactedCount, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrieveSourceRecall ranks keyword matches as weak recall evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-keyword-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const record = buildRecord("source_record_keyword", "scope-a", "thread-a");

  try {
    await store.upsertSourceRecord(record, [
      buildChunk("chunk_keyword_1", record.sourceRecordId, 0, "The launch copy mentions carbon and editorial motion."),
      buildChunk("chunk_keyword_2", record.sourceRecordId, 1, "This unrelated note should not match.")
    ]);

    const result = await retrieveSourceRecall(store, {
      scopeId: "scope-a",
      threadId: "thread-a",
      keywords: ["carbon", "motion"]
    });

    assert.equal(result.bundle.retrievalMode, "keyword");
    assert.equal(result.bundle.retrievalAuthority, "weak_recall_evidence");
    assert.deepEqual(
      result.bundle.excerpts.map((excerpt) => excerpt.chunkId),
      ["chunk_keyword_1"]
    );
    assert.equal(result.bundle.excerpts[0]?.ranking.keywordScore, 2);
    assert.equal(result.bundle.excerpts[0]?.ranking.vectorScore, 0);
    assert.match(result.bundle.excerpts[0]?.ranking.explanation ?? "", /mode=keyword/);
    assert.equal(result.bundle.excerpts[0]?.authority.currentTruthAuthority, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrieveSourceRecall suppresses vector and hybrid false positives outside scope", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-hybrid-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const inScopeRecord = buildRecord("source_record_hybrid_a", "scope-a", "thread-a");
  const outOfScopeRecord = buildRecord("source_record_hybrid_b", "scope-b", "thread-b");

  try {
    await store.upsertSourceRecord(inScopeRecord, [
      buildChunk(
        "chunk_hybrid_in_scope",
        inScopeRecord.sourceRecordId,
        0,
        "The site should use a gallery with studio case studies."
      )
    ]);
    await store.upsertSourceRecord(outOfScopeRecord, [
      buildChunk(
        "chunk_hybrid_out_scope",
        outOfScopeRecord.sourceRecordId,
        0,
        "The gallery note belongs to another workspace."
      )
    ]);

    const vectorOnly = await retrieveSourceRecall(store, {
      scopeId: "scope-a",
      threadId: "thread-a",
      semanticVectorChunkIds: ["chunk_hybrid_in_scope", "chunk_hybrid_out_scope"]
    });
    assert.equal(vectorOnly.bundle.retrievalMode, "semantic_vector");
    assert.equal(vectorOnly.bundle.retrievalAuthority, "weak_recall_evidence");
    assert.deepEqual(
      vectorOnly.bundle.excerpts.map((excerpt) => excerpt.chunkId),
      ["chunk_hybrid_in_scope"]
    );
    assert.equal(vectorOnly.bundle.excerpts[0]?.ranking.vectorScore, 1);

    const hybrid = await retrieveSourceRecall(store, {
      scopeId: "scope-a",
      threadId: "thread-a",
      keywords: ["gallery"],
      semanticVectorChunkIds: ["chunk_hybrid_in_scope", "chunk_hybrid_out_scope"]
    });
    assert.equal(hybrid.bundle.retrievalMode, "hybrid");
    assert.deepEqual(
      hybrid.bundle.excerpts.map((excerpt) => excerpt.chunkId),
      ["chunk_hybrid_in_scope"]
    );
    assert.equal(hybrid.bundle.excerpts[0]?.ranking.keywordScore, 1);
    assert.equal(hybrid.bundle.excerpts[0]?.ranking.vectorScore, 1);
    assert.equal(hybrid.bundle.excerpts[0]?.ranking.retrievalAuthority, "weak_recall_evidence");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrieveSourceRecall reports recent fallback as diagnostic-only evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-recent-"));
  const store = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const olderRecord = buildRecord("source_record_recent_old", "scope-a", "thread-a", {
    capturedAt: "2026-05-03T15:00:00.000Z",
    freshness: "historical"
  });
  const newerRecord = buildRecord("source_record_recent_new", "scope-a", "thread-a", {
    capturedAt: "2026-05-03T16:00:00.000Z",
    freshness: "recent"
  });

  try {
    await store.upsertSourceRecord(olderRecord, [
      buildChunk("chunk_recent_old", olderRecord.sourceRecordId, 0, "Older note.")
    ]);
    await store.upsertSourceRecord(newerRecord, [
      buildChunk("chunk_recent_new", newerRecord.sourceRecordId, 0, "Newer note.")
    ]);

    const result = await retrieveSourceRecall(store, {});

    assert.equal(result.bundle.retrievalMode, "recent_fallback");
    assert.equal(result.bundle.retrievalAuthority, "diagnostic_only");
    assert.equal(result.bundle.excerpts[0]?.chunkId, "chunk_recent_new");
    assert.equal(result.bundle.excerpts[0]?.ranking.freshness, "recent");
    assert.equal(result.bundle.excerpts[0]?.authority.plannerAuthority, "evidence_only");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/**
 * Builds a synthetic Source Recall record.
 *
 * @param sourceRecordId - Source record id.
 * @param scopeId - Scope id.
 * @param threadId - Thread id.
 * @param overrides - Optional field overrides.
 * @returns Source Recall record.
 */
function buildRecord(
  sourceRecordId: string,
  scopeId: string,
  threadId: string,
  overrides: Partial<SourceRecallRecord> = {}
): SourceRecallRecord {
  return {
    sourceRecordId,
    scopeId,
    threadId,
    sourceKind: "conversation_turn",
    sourceRole: "user",
    sourceAuthority: "explicit_user_statement",
    captureClass: "ordinary_source",
    recallAuthority: "quoted_evidence_only",
    lifecycleState: "active",
    originRef: {
      surface: "test",
      refId: `${sourceRecordId}_origin`,
      parentRefId: "origin-parent-redacted"
    },
    sourceRecordHash: `${sourceRecordId}_hash`,
    observedAt: "2026-05-03T16:00:00.000Z",
    capturedAt: "2026-05-03T16:00:01.000Z",
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
 * @param chunkIndex - Chunk index.
 * @param text - Chunk text.
 * @returns Source Recall chunk.
 */
function buildChunk(
  chunkId: string,
  sourceRecordId: string,
  chunkIndex: number,
  text: string
): SourceRecallChunk {
  return {
    chunkId,
    sourceRecordId,
    chunkIndex,
    text,
    chunkHash: `${chunkId}_hash`,
    lifecycleState: "active",
    recallAuthority: "quoted_evidence_only",
    authority: buildSourceRecallAuthorityFlags()
  };
}
