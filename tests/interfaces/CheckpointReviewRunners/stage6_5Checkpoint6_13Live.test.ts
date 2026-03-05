/**
 * @fileoverview Tests deterministic Stage 6.5 checkpoint 6.13 live-check artifact generation and linkage metadata.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCheckpoint613LiveReview } from "../../../src/interfaces/CheckpointReviewRunners/stage6_5Checkpoint6_13Live";

/**
 * Removes temporary directories created during deterministic artifact tests.
 */
async function removeTempDir(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

test("checkpoint 6.13 live review emits deterministic pass artifact with linkage metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_5_6_13-"));
  const artifactPath = path.join(tempDir, "artifact.json");

  try {
    const review = await runCheckpoint613LiveReview({ artifactPath });
    assert.equal(review.checkpointId, "6.13");
    assert.equal(review.overallPass, true);
    assert.equal(review.artifactPath, artifactPath);

    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
      artifactHash?: string;
      linkedFrom?: { traceId?: string };
      passCriteria?: { overallPass?: boolean };
    };
    assert.equal(artifact.passCriteria?.overallPass, true);
    assert.equal(typeof artifact.artifactHash, "string");
    assert.equal(typeof artifact.linkedFrom?.traceId, "string");
  } finally {
    await removeTempDir(tempDir);
  }
});

