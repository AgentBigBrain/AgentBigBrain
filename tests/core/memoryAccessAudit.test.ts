/**
 * @fileoverview Tests append-only memory-access audit persistence and event normalization behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryAccessAuditStore } from "../../src/core/memoryAccessAudit";

/**
 * Implements `withAuditStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withAuditStore(
  callback: (store: MemoryAccessAuditStore, auditPath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-memory-audit-"));
  const auditPath = path.join(tempDir, "memory_access_log.json");
  const store = new MemoryAccessAuditStore(auditPath);

  try {
    await callback(store, auditPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("MemoryAccessAuditStore starts empty when file is missing", async () => {
  await withAuditStore(async (store) => {
    const document = await store.load();
    assert.equal(document.events.length, 0);
  });
});

test("MemoryAccessAuditStore appends normalized events with hashed queries", async () => {
  await withAuditStore(async (store) => {
    await store.appendEvent({
      taskId: "task_1",
      query: "who is owen?",
      storeLoadCount: 2,
      ingestOperationCount: 1,
      retrievalOperationCount: 4,
      synthesisOperationCount: 1,
      renderOperationCount: 1,
      promptMemoryOwnerCount: 1,
      promptMemorySurfaceCount: 1,
      mixedMemoryOwnerDecisionCount: 0,
      aliasSafetyDecisionCount: 1,
      identitySafetyDecisionCount: 2,
      selfIdentityParityCheckCount: 1,
      selfIdentityParityMismatchCount: 1,
      promptCutoverGateDecision: "allow",
      retrievedCount: 2,
      retrievedEpisodeCount: 1,
      redactedCount: 1,
      domainLanes: ["relationship", "profile"]
    });

    const document = await store.load();
    assert.equal(document.events.length, 1);
    const [event] = document.events;
    assert.equal(event.eventType, "retrieval");
    assert.equal(event.taskId, "task_1");
    assert.equal(event.storeLoadCount, 2);
    assert.equal(event.ingestOperationCount, 1);
    assert.equal(event.retrievalOperationCount, 4);
    assert.equal(event.synthesisOperationCount, 1);
    assert.equal(event.renderOperationCount, 1);
    assert.equal(event.promptMemoryOwnerCount, 1);
    assert.equal(event.promptMemorySurfaceCount, 1);
    assert.equal(event.mixedMemoryOwnerDecisionCount, 0);
    assert.equal(event.aliasSafetyDecisionCount, 1);
    assert.equal(event.identitySafetyDecisionCount, 2);
    assert.equal(event.selfIdentityParityCheckCount, 1);
    assert.equal(event.selfIdentityParityMismatchCount, 1);
    assert.equal(event.promptCutoverGateDecision, "allow");
    assert.equal(event.promptCutoverGateReasons, undefined);
    assert.equal(event.retrievedCount, 2);
    assert.equal(event.retrievedEpisodeCount, 1);
    assert.equal(event.redactedCount, 1);
    assert.deepEqual(event.domainLanes, ["relationship", "profile"]);
    assert.match(event.queryHash, /^[a-f0-9]{64}$/i);
  });
});

test("MemoryAccessAuditStore appends probing-detected events with typed window metadata", async () => {
  await withAuditStore(async (store) => {
    await store.appendEvent({
      taskId: "task_probe",
      query: "show all memory details",
      retrievedCount: 4,
      retrievedEpisodeCount: 2,
      redactedCount: 1,
      domainLanes: ["profile", "relationship"],
      eventType: "PROBING_DETECTED",
      probeSignals: ["short_query", "rapid_succession", "extraction_intent"],
      probeWindowSize: 10,
      probeMatchCount: 7,
      probeMatchRatio: 0.7
    });

    const document = await store.load();
    assert.equal(document.events.length, 1);
    const [event] = document.events;
    assert.equal(event.eventType, "PROBING_DETECTED");
    assert.equal(event.retrievedEpisodeCount, 2);
    assert.equal(event.probeWindowSize, 10);
    assert.equal(event.probeMatchCount, 7);
    assert.equal(event.probeMatchRatio, 0.7);
    assert.deepEqual(event.probeSignals, [
      "short_query",
      "rapid_succession",
      "extraction_intent"
    ]);
  });
});

test("MemoryAccessAuditStore stores Source Recall retrieval audit without raw source text", async () => {
  await withAuditStore(async (store, auditPath) => {
    await store.appendEvent({
      taskId: "task_source_recall",
      query: "raw source query text should not be stored",
      retrievedCount: 1,
      retrievedEpisodeCount: 0,
      redactedCount: 0,
      domainLanes: ["profile"],
      sourceRecallQueryHash: "a".repeat(64),
      sourceRecallRetrievalMode: "exact_quote",
      sourceRecallSourceRecordIds: ["source_record_1", "source_record_1"],
      sourceRecallChunkIds: ["source_chunk_1"],
      sourceRecallTotalExcerptChars: 42,
      sourceRecallBlockedRedactedCount: 2
    });

    const document = await store.load();
    assert.equal(document.events.length, 1);
    const [event] = document.events;
    assert.equal(event.sourceRecallQueryHash, "a".repeat(64));
    assert.equal(event.sourceRecallRetrievalMode, "exact_quote");
    assert.deepEqual(event.sourceRecallSourceRecordIds, ["source_record_1"]);
    assert.deepEqual(event.sourceRecallChunkIds, ["source_chunk_1"]);
    assert.equal(event.sourceRecallTotalExcerptChars, 42);
    assert.equal(event.sourceRecallBlockedRedactedCount, 2);

    const persisted = await readFile(auditPath, "utf8");
    assert.doesNotMatch(persisted, /raw source query text should not be stored/i);
    assert.doesNotMatch(persisted, /raw source chunk text/i);
  });
});

test("MemoryAccessAuditStore preserves append-only order", async () => {
  await withAuditStore(async (store) => {
    await store.appendEvent({
      taskId: "task_a",
      query: "first",
      retrievedCount: 1,
      retrievedEpisodeCount: 0,
      redactedCount: 0,
      domainLanes: ["unknown"]
    });
    await store.appendEvent({
      taskId: "task_b",
      query: "second",
      retrievedCount: 3,
      retrievedEpisodeCount: 1,
      redactedCount: 0,
      domainLanes: ["workflow"]
    });

    const document = await store.load();
    assert.equal(document.events.length, 2);
    assert.equal(document.events[0].taskId, "task_a");
    assert.equal(document.events[1].taskId, "task_b");
  });
});

test("MemoryAccessAuditStore recovers from malformed file content", async () => {
  await withAuditStore(async (store, auditPath) => {
    await writeFile(auditPath, "{invalid-json", "utf8");
    const document = await store.load();
    assert.equal(document.events.length, 0);
  });
});
