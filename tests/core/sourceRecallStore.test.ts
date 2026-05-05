/**
 * @fileoverview Tests for the S1 Source Recall store skeleton.
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
import { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";
import { withSqliteDatabase } from "../../src/core/sqliteStore";

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 17);

test("SourceRecallStore requires the S1 test-only plaintext latch", () => {
  assert.throws(
    () => new SourceRecallStore({ sqlitePath: "runtime/source_recall.sqlite" }),
    /encrypted production storage/
  );
});

test("SourceRecallStore rejects mixed plaintext and encrypted modes", () => {
  assert.throws(
    () => new SourceRecallStore({
      sqlitePath: "runtime/source_recall.sqlite",
      testOnlyAllowPlaintextStorage: true,
      encryptionKey: TEST_ENCRYPTION_KEY
    }),
    /cannot mix/
  );
});

test("SourceRecallStore round-trips manually constructed records and chunks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-store-"));
  const sqlitePath = path.join(tempDir, "source_recall.sqlite");
  const store = new SourceRecallStore({
    sqlitePath,
    testOnlyAllowPlaintextStorage: true
  });
  const record = buildRecord("source_record_alpha", "scope_one", "thread_one");
  const chunks = [
    buildChunk("chunk_alpha_2", record.sourceRecordId, 1, "Second bounded excerpt."),
    buildChunk("chunk_alpha_1", record.sourceRecordId, 0, "First bounded excerpt.")
  ];

  try {
    await store.upsertSourceRecord(record, chunks);

    const persistedRecord = await store.getSourceRecord(record.sourceRecordId);
    const listedRecords = await store.listSourceRecords({
      scopeId: "scope_one",
      threadId: "thread_one"
    });
    const listedChunks = await store.listChunksForRecord(record.sourceRecordId);

    assert.equal(persistedRecord?.sourceRecordId, "source_record_alpha");
    assert.equal(persistedRecord?.recallAuthority, "quoted_evidence_only");
    assert.equal(persistedRecord?.sourceAuthority, "explicit_user_statement");
    assert.equal(listedRecords.length, 1);
    assert.deepEqual(
      listedChunks.map((chunk) => chunk.chunkId),
      ["chunk_alpha_1", "chunk_alpha_2"]
    );
    assert.deepEqual(listedChunks[0].authority, buildSourceRecallAuthorityFlags());
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SourceRecallStore encrypts production records and chunks at rest", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-encrypted-"));
  const sqlitePath = path.join(tempDir, "source_recall.sqlite");
  const store = new SourceRecallStore({
    sqlitePath,
    encryptionKey: TEST_ENCRYPTION_KEY
  });
  const record = buildRecord("source_record_encrypted", "scope_encrypted", "thread_encrypted");
  const syntheticSourceText = "Synthetic encrypted user-turn text for Source Recall testing.";

  try {
    await store.upsertSourceRecord(record, [
      buildChunk("chunk_encrypted_1", record.sourceRecordId, 0, syntheticSourceText)
    ]);

    const rawRow = await readRawSourceRecallRow(sqlitePath);
    assert.equal(rawRow.storage_mode, "encrypted_v1");
    assert.match(rawRow.document_json, /ciphertextBase64/);
    assert.doesNotMatch(rawRow.document_json, /Synthetic encrypted user-turn text/);

    const persistedRecord = await store.getSourceRecord(record.sourceRecordId);
    const listedChunks = await store.listChunksForRecord(record.sourceRecordId);
    assert.equal(persistedRecord?.sourceRecordId, record.sourceRecordId);
    assert.equal(listedChunks[0]?.text, syntheticSourceText);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SourceRecallStore rejects plaintext rows in production mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-plaintext-"));
  const sqlitePath = path.join(tempDir, "source_recall.sqlite");
  const plaintextStore = new SourceRecallStore({
    sqlitePath,
    testOnlyAllowPlaintextStorage: true
  });
  const record = buildRecord("source_record_plaintext", "scope_plaintext", "thread_plaintext");

  try {
    await plaintextStore.upsertSourceRecord(record, [
      buildChunk("chunk_plaintext_1", record.sourceRecordId, 0, "Synthetic plaintext legacy text.")
    ]);
    const productionStore = new SourceRecallStore({
      sqlitePath,
      encryptionKey: TEST_ENCRYPTION_KEY
    });

    await assert.rejects(
      () => productionStore.getSourceRecord(record.sourceRecordId),
      /Plaintext Source Recall rows require explicit migration/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SourceRecallStore production callsites cannot use the test-only plaintext latch", async () => {
  const sourceHits = await listSourceFilesWithTestOnlyPlaintextTrue();
  assert.deepEqual(sourceHits, []);
});

test("SourceRecallStore hides forgotten records and chunks by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-delete-"));
  const sqlitePath = path.join(tempDir, "source_recall.sqlite");
  const store = new SourceRecallStore({
    sqlitePath,
    testOnlyAllowPlaintextStorage: true
  });
  const record = buildRecord("source_record_delete", "scope_delete", "thread_delete");

  try {
    await store.upsertSourceRecord(record, [
      buildChunk("chunk_delete_1", record.sourceRecordId, 0, "Temporary excerpt.")
    ]);
    await store.markSourceRecordForgotten(record.sourceRecordId);

    assert.equal(await store.getSourceRecord(record.sourceRecordId), null);
    assert.deepEqual(await store.listChunksForRecord(record.sourceRecordId), []);

    const inactiveRecord = await store.getSourceRecord(record.sourceRecordId, true);
    const inactiveChunks = await store.listChunksForRecord(record.sourceRecordId, {
      includeInactive: true
    });
    assert.equal(inactiveRecord?.lifecycleState, "forgotten");
    assert.equal(inactiveChunks[0]?.lifecycleState, "forgotten");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/**
 * Builds a synthetic Source Recall record for store tests.
 *
 * @param sourceRecordId - Synthetic source record id.
 * @param scopeId - Synthetic scope id.
 * @param threadId - Synthetic thread id.
 * @returns Source Recall record.
 */
function buildRecord(
  sourceRecordId: string,
  scopeId: string,
  threadId: string
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
      surface: "test_conversation",
      refId: `${sourceRecordId}_origin`
    },
    sourceRecordHash: `${sourceRecordId}_hash`,
    observedAt: "2026-05-03T12:00:00.000Z",
    capturedAt: "2026-05-03T12:00:01.000Z",
    sourceTimeKind: "observed_event",
    freshness: "current_turn",
    sensitive: false
  };
}

/**
 * Builds a synthetic Source Recall chunk for store tests.
 *
 * @param chunkId - Synthetic chunk id.
 * @param sourceRecordId - Owning source record id.
 * @param chunkIndex - Chunk order.
 * @param text - Synthetic source text.
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

/**
 * Reads the raw persisted Source Recall state row from SQLite.
 *
 * @param sqlitePath - Test SQLite path.
 * @returns Raw document JSON and storage mode fields.
 */
async function readRawSourceRecallRow(sqlitePath: string): Promise<{
  document_json: string;
  storage_mode: string;
}> {
  return withSqliteDatabase(sqlitePath, (db) =>
    db.prepare(
      `SELECT document_json, storage_mode
         FROM source_recall_state
        WHERE id = ?`
    ).get("source_recall_document") as {
      document_json: string;
      storage_mode: string;
    }
  );
}

/**
 * Lists production source files that pass the test-only plaintext latch.
 *
 * @returns Source file paths containing forbidden production plaintext test latch usage.
 */
async function listSourceFilesWithTestOnlyPlaintextTrue(): Promise<string[]> {
  const root = path.resolve("src");
  const matches: string[] = [];
  await scanDirectory(root, matches);
  return matches;
}

/**
 * Recursively scans one directory for forbidden production latch usage.
 *
 * @param directory - Directory to scan.
 * @param matches - Mutable match list.
 */
async function scanDirectory(directory: string, matches: string[]): Promise<void> {
  const { readdir, readFile } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(fullPath, matches);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const source = await readFile(fullPath, "utf8");
    if (source.includes("testOnlyAllowPlaintextStorage: true")) {
      matches.push(path.relative(process.cwd(), fullPath));
    }
  }
}
