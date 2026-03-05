/**
 * @fileoverview Tests Stage 6.75 evidence-store append-only behavior, deterministic artifact envelopes, and fail-closed linkage validation.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EvidenceStore } from "../../src/core/evidenceStore";

/**
 * Implements `withTempDir` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempDir<T>(callback: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-evidence-store-"));
  try {
    return await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("evidence store returns empty document when storage file does not exist", async () => {
  await withTempDir(async (tempDir) => {
    const store = new EvidenceStore(path.join(tempDir, "runtime", "evidence_store.json"));
    const document = await store.load();
    assert.equal(document.schemaVersion, "v1");
    assert.equal(document.artifacts.length, 0);
  });
});

test("evidence store appends deterministic schema envelope artifact", async () => {
  await withTempDir(async (tempDir) => {
    const storePath = path.join(tempDir, "runtime", "evidence_store.json");
    const store = new EvidenceStore(storePath);

    const artifact = await store.appendArtifact({
      schemaName: "DistilledPacketV1",
      payload: {
        source: "https://example.com/post",
        summary: "distilled summary"
      },
      createdAt: "2026-02-27T20:10:00.000Z",
      linkedFrom: {
        traceId: "trace_6_75_A_001"
      }
    });

    assert.ok(artifact.artifactId.startsWith("evidence_"));
    assert.ok(artifact.artifactHash.length > 0);
    assert.equal(artifact.schemaEnvelope.schemaVersion, "v1");
    assert.equal(artifact.schemaEnvelope.schemaName, "DistilledPacketV1");

    const reloaded = await store.load();
    assert.equal(reloaded.artifacts.length, 1);
    assert.equal(reloaded.artifacts[0].artifactId, artifact.artifactId);
    assert.equal(reloaded.artifacts[0].linkedFrom.traceId, "trace_6_75_A_001");
  });
});

test("evidence store fails closed when linkage metadata is missing", async () => {
  await withTempDir(async (tempDir) => {
    const store = new EvidenceStore(path.join(tempDir, "runtime", "evidence_store.json"));
    await assert.rejects(
      () =>
        store.appendArtifact({
          schemaName: "DistilledPacketV1",
          payload: { summary: "missing linkage" },
          createdAt: "2026-02-27T20:10:00.000Z",
          linkedFrom: {}
        }),
      /linkage requires either/
    );
  });
});
