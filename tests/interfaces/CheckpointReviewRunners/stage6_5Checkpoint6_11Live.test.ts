/**
 * @fileoverview Tests deterministic Stage 6.5 checkpoint 6.11 live-check artifact generation and pass criteria.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCheckpoint611LiveReview } from "../../../src/interfaces/CheckpointReviewRunners/stage6_5Checkpoint6_11Live";

/**
 * Implements `removeTempDir` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function removeTempDir(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

test("checkpoint 6.11 live review produces deterministic pass artifact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_5_6_11-"));
  const artifactPath = path.join(tempDir, "artifact.json");
  const ledgerPath = path.join(tempDir, "ledger.json");

  try {
    const review = await runCheckpoint611LiveReview({
      artifactPath,
      ledgerPath
    });

    assert.equal(review.checkpointId, "6.11");
    assert.equal(review.overallPass, true);
    assert.equal(review.artifactPath, artifactPath);
    assert.ok(review.summaryLines.some((line) => line.includes("atlas-1001")));
    assert.ok(review.summaryLines.some((line) => line.includes("CLONE_DEPTH_EXCEEDED")));

    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
      passCriteria?: {
        overallPass?: boolean;
        deterministicNamingAndNoConflict?: boolean;
        capabilitySurfaceEnforced?: boolean;
      };
      artifactHash?: string;
      linkedFrom?: { traceId?: string };
      satelliteCapabilitySurfaceProofV1?: {
        directSideEffectsAllowed?: boolean;
        outputMode?: string;
      };
      spawnWithinLimits?: { cloneIds?: string[] };
      mergeDecisions?: { rejected?: { ledgerVisible?: boolean } };
    };
    assert.equal(artifact.passCriteria?.overallPass, true);
    assert.equal(artifact.passCriteria?.deterministicNamingAndNoConflict, true);
    assert.equal(artifact.passCriteria?.capabilitySurfaceEnforced, true);
    assert.equal(typeof artifact.artifactHash, "string");
    assert.equal(typeof artifact.linkedFrom?.traceId, "string");
    assert.equal(artifact.satelliteCapabilitySurfaceProofV1?.directSideEffectsAllowed, false);
    assert.equal(artifact.satelliteCapabilitySurfaceProofV1?.outputMode, "proposal_only");
    assert.deepEqual(artifact.spawnWithinLimits?.cloneIds, ["atlas-1001", "milkyway-1002"]);
    assert.equal(artifact.mergeDecisions?.rejected?.ledgerVisible, true);
  } finally {
    await removeTempDir(tempDir);
  }
});
