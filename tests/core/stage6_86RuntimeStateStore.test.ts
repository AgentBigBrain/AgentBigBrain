/**
 * @fileoverview Tests canonical Stage 6.86 runtime-state entrypoints after subsystem extraction.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Stage686RuntimeStateStore as CompatStage686RuntimeStateStore } from "../../src/core/stage6_86RuntimeStateStore";
import { Stage686RuntimeStateStore } from "../../src/core/stage6_86/runtimeState";

test("Stage686RuntimeStateStore compatibility entrypoint matches the canonical runtime module", () => {
  assert.equal(CompatStage686RuntimeStateStore, Stage686RuntimeStateStore);
});

test("Stage686RuntimeStateStore returns the deterministic default snapshot when state is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-stage686-state-"));
  try {
    const store = new Stage686RuntimeStateStore(path.join(tempDir, "runtime_state.json"), {
      backend: "json",
      exportJsonOnWrite: false
    });

    const snapshot = await store.load();

    assert.equal(snapshot.conversationStack.schemaVersion, "v1");
    assert.equal(snapshot.pulseState.schemaVersion, "v1");
    assert.deepEqual(snapshot.pendingBridgeQuestions, []);
    assert.equal(snapshot.lastMemoryMutationReceiptHash, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
