import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  applyEntityExtractionToGraph,
  createEmptyEntityGraphV1,
  extractEntityCandidates
} from "../../src/core/stage6_86EntityGraph";
import {
  buildSourceRecallAuthorityFlags,
  type SourceRecallChunk,
  type SourceRecallRecord
} from "../../src/core/sourceRecall/contracts";
import type { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";

test("createSharedBrainRuntimeDependencies keeps sqlite bootstrap imports inside the configured runtime root", async () => {
  const buildBrainModule = await import("../../src/core/buildBrain");
  const { createSharedBrainRuntimeDependencies } = buildBrainModule as {
    createSharedBrainRuntimeDependencies: (env: NodeJS.ProcessEnv) => {
      entityGraphStore: { getGraph(): Promise<{ entities: readonly unknown[]; edges: readonly unknown[] }> };
      sourceRecallStore?: unknown;
    };
  };
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "abb-buildbrain-"));
  const cwdRoot = path.join(tempRoot, "cwd-root");
  const isolatedRuntimeRoot = path.join(tempRoot, "isolated-runtime");
  const observedAt = "2026-04-12T16:00:00.000Z";

  await mkdir(path.join(cwdRoot, "runtime"), { recursive: true });
  await mkdir(isolatedRuntimeRoot, { recursive: true });

  const contaminatedGraph = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extractEntityCandidates({
      text: "Billy met Garrett about the Harbor project.",
      observedAt,
      evidenceRef: "test:cwd",
      domainHint: "relationship"
    }),
    observedAt,
    "test:cwd"
  ).graph;

  await writeFile(
    path.join(cwdRoot, "runtime", "entity_graph.json"),
    `${JSON.stringify(contaminatedGraph, null, 2)}\n`,
    "utf8"
  );

  const previousCwd = process.cwd();
  process.chdir(cwdRoot);
  try {
    const shared = createSharedBrainRuntimeDependencies({
      ...process.env,
      BRAIN_ENABLE_EMBEDDINGS: "false",
      BRAIN_LEDGER_BACKEND: "sqlite",
      BRAIN_LEDGER_SQLITE_PATH: path.join(isolatedRuntimeRoot, "ledgers.sqlite"),
      BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
      BRAIN_STATE_JSON_PATH: path.join(isolatedRuntimeRoot, "state.json"),
      BRAIN_PROFILE_MEMORY_ENABLED: "false",
      BRAIN_PROJECTION_SINKS: ""
    });

    assert.equal(shared.sourceRecallStore, undefined);
    const graph = await shared.entityGraphStore.getGraph();
    assert.equal(graph.entities.length, 0);
    assert.equal(graph.edges.length, 0);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createSharedBrainRuntimeDependencies projects Source Recall only through the projection latch", async () => {
  const buildBrainModule = await import("../../src/core/buildBrain");
  const { createSharedBrainRuntimeDependencies } = buildBrainModule as {
    createSharedBrainRuntimeDependencies: (env: NodeJS.ProcessEnv) => {
      sourceRecallStore?: SourceRecallStore;
      projectionService: { rebuild(reason: string): Promise<void> };
    };
  };
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "abb-buildbrain-source-recall-"));
  try {
    const runtimeRoot = path.join(tempRoot, "runtime");
    const mirrorPath = path.join(tempRoot, "json_mirror.json");
    const key = Buffer.alloc(32, 41).toString("base64");
    const shared = createSharedBrainRuntimeDependencies({
      ...process.env,
      BRAIN_ENABLE_EMBEDDINGS: "false",
      BRAIN_LEDGER_BACKEND: "sqlite",
      BRAIN_LEDGER_SQLITE_PATH: path.join(runtimeRoot, "ledgers.sqlite"),
      BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
      BRAIN_STATE_JSON_PATH: path.join(runtimeRoot, "state.json"),
      BRAIN_PROFILE_MEMORY_ENABLED: "false",
      BRAIN_PROJECTION_SINKS: "json",
      BRAIN_JSON_MIRROR_PATH: mirrorPath,
      BRAIN_SOURCE_RECALL_ENABLED: "true",
      BRAIN_SOURCE_RECALL_SQLITE_PATH: path.join(runtimeRoot, "source_recall.sqlite"),
      BRAIN_SOURCE_RECALL_ENCRYPTION_KEY: key,
      BRAIN_SOURCE_RECALL_PROJECTION_ENABLED: "true",
      BRAIN_SOURCE_RECALL_OPERATOR_FULL_PROJECTION_ENABLED: "false"
    });
    assert.ok(shared.sourceRecallStore);
    const record = buildSourceRecallProjectionRecord("source_record_json_projection");
    await shared.sourceRecallStore.upsertSourceRecord(record, [
      buildSourceRecallProjectionChunk(
        "chunk_json_projection",
        record.sourceRecordId,
        "Synthetic Source Recall projection text that should remain bounded review evidence only."
      )
    ]);

    await shared.projectionService.rebuild("test_source_recall_projection");

    const mirror = JSON.parse(await readFile(mirrorPath, "utf8")) as {
      sourceRecallProjectionEntries?: Array<{
        sourceRecordId?: string;
        recallAuthority?: string;
        authority?: { approvalAuthority?: boolean; completionProofAuthority?: boolean };
        operatorFullEnabled?: boolean;
      }>;
    };
    assert.equal(mirror.sourceRecallProjectionEntries?.length, 1);
    assert.equal(
      mirror.sourceRecallProjectionEntries?.[0]?.sourceRecordId,
      "source_record_json_projection"
    );
    assert.equal(mirror.sourceRecallProjectionEntries?.[0]?.recallAuthority, "quoted_evidence_only");
    assert.equal(mirror.sourceRecallProjectionEntries?.[0]?.operatorFullEnabled, false);
    assert.equal(mirror.sourceRecallProjectionEntries?.[0]?.authority?.approvalAuthority, false);
    assert.equal(
      mirror.sourceRecallProjectionEntries?.[0]?.authority?.completionProofAuthority,
      false
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Builds one synthetic Source Recall record for projection wiring tests.
 *
 * @param sourceRecordId - Synthetic source record id.
 * @returns Source Recall record.
 */
function buildSourceRecallProjectionRecord(sourceRecordId: string): SourceRecallRecord {
  return {
    sourceRecordId,
    scopeId: "scope_projection_wiring",
    threadId: "thread_projection_wiring",
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
    observedAt: "2026-05-05T12:00:00.000Z",
    capturedAt: "2026-05-05T12:00:01.000Z",
    sourceTimeKind: "observed_event",
    freshness: "recent",
    sensitive: false
  };
}

/**
 * Builds one synthetic Source Recall chunk for projection wiring tests.
 *
 * @param chunkId - Synthetic chunk id.
 * @param sourceRecordId - Owning source record id.
 * @param text - Synthetic source text.
 * @returns Source Recall chunk.
 */
function buildSourceRecallProjectionChunk(
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
