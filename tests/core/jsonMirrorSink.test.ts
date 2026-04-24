/**
 * @fileoverview Tests the JSON projection sink used to prove sink swapability.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { JsonMirrorSink } from "../../src/core/projections/targets/jsonMirrorSink";
import { buildProjectionSnapshotFixture } from "./projectionTestSupport";

test("JsonMirrorSink rebuild writes the full projection snapshot to disk", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-json-mirror-"));
  try {
    const outputPath = path.join(tempDir, "projection_snapshot.json");
    const sink = new JsonMirrorSink({ outputPath });

    await sink.rebuild(buildProjectionSnapshotFixture());

    const snapshot = JSON.parse(await readFile(outputPath, "utf8")) as {
      generatedAt: string;
      entityGraph: { entities: Array<{ canonicalName: string }> };
      runtimeState: { conversationStack: { threads: Array<{ threadKey: string }> } };
    };
    assert.equal(snapshot.generatedAt, "2026-04-12T12:00:00.000Z");
    assert.deepEqual(
      snapshot.entityGraph.entities.map((entity) => entity.canonicalName),
      ["Detroit", "Owen"]
    );
    assert.deepEqual(
      snapshot.runtimeState.conversationStack.threads.map((thread) => thread.threadKey),
      ["thread_detroit"]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
