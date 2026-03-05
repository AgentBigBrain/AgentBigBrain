/**
 * @fileoverview Tests Stage 6.85 live-review checkpoint runner normalization, artifact persistence, and support-list coverage.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  listStage685LiveReviewCheckpoints,
  runStage685CheckpointLiveReview
} from "../../src/interfaces/CheckpointReviewRunners/stage685CheckpointReviewRunner";

/**
 * Implements `removeTempDir` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function removeTempDir(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

test("stage 6.85 checkpoint review runner supports alias checkpoint ids and writes artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage685-review-a-"));

  try {
    const review = await runStage685CheckpointLiveReview("6.85a", {
      artifactPathOverrides: {
        "6.85.A": path.join(tempDir, "stage6_85_a_review.json")
      }
    });
    assert.ok(review);
    assert.equal(review?.checkpointId, "6.85.A");
    assert.ok(review?.artifactPath.endsWith("stage6_85_a_review.json"));
    assert.ok(review?.summaryLines.length >= 2);
    assert.ok(review?.summaryLines[0]?.includes("Selected playbook"));

    const persistedArtifact = JSON.parse(
      await readFile(review?.artifactPath ?? "", "utf8")
    ) as {
      checkpointId: string;
      passCriteria: { overallPass: boolean };
    };
    assert.equal(persistedArtifact.checkpointId, "6.85.A");
    assert.equal(typeof persistedArtifact.passCriteria.overallPass, "boolean");
  } finally {
    await removeTempDir(tempDir);
  }
});

test("stage 6.85 checkpoint review runner supports canonical stage 6.85.H ids", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage685-review-h-"));

  try {
    const review = await runStage685CheckpointLiveReview("6.85.H", {
      artifactPathOverrides: {
        "6.85.H": path.join(tempDir, "stage6_85_h_review.json")
      }
    });
    assert.ok(review);
    assert.equal(review?.checkpointId, "6.85.H");
    assert.ok(review?.artifactPath.endsWith("stage6_85_h_review.json"));
    assert.ok(review?.summaryLines[0]?.includes("Timeline"));
  } finally {
    await removeTempDir(tempDir);
  }
});

test("stage 6.85 checkpoint review runner returns null for unsupported checkpoint ids", async () => {
  const review = await runStage685CheckpointLiveReview("6.85.Z");
  assert.equal(review, null);
});

test("stage 6.85 checkpoint review runner exposes all supported checkpoints", () => {
  const checkpoints = listStage685LiveReviewCheckpoints();
  assert.deepEqual(checkpoints, [
    "6.85.A",
    "6.85.B",
    "6.85.C",
    "6.85.D",
    "6.85.E",
    "6.85.F",
    "6.85.G",
    "6.85.H"
  ]);
});
