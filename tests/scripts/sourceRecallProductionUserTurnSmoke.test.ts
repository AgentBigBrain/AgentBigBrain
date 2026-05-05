/**
 * @fileoverview Tests the synthetic production Source Recall user-turn smoke.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  runSourceRecallProductionUserTurnSmoke
} from "../../scripts/evidence/sourceRecallProductionUserTurnSmoke";

test("Source Recall production user-turn smoke proves capture retrieval and delete without raw evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-source-recall-smoke-test-"));
  const artifactPath = path.join(tempDir, "source_recall_smoke.json");

  try {
    const evidence = await runSourceRecallProductionUserTurnSmoke({ artifactPath });
    const artifact = await readFile(artifactPath, "utf8");

    assert.equal(evidence.summary.status, "PASS");
    assert.equal(evidence.storageProof.encryptedProductionStore, true);
    assert.equal(evidence.storageProof.rawRowContainsCapturedText, false);
    assert.equal(evidence.captureProof.recordsCaptured, 1);
    assert.equal(evidence.captureProof.sourceKind, "conversation_turn");
    assert.equal(evidence.captureProof.sourceRole, "user");
    assert.equal(evidence.captureProof.assistantTaskRecordsCaptured, 0);
    assert.equal(evidence.captureProof.mediaDocumentRecordsCaptured, 0);
    assert.equal(evidence.retrievalProof.retrievalMode, "exact_quote");
    assert.equal(evidence.retrievalProof.excerptsReturned, 1);
    assert.equal(evidence.retrievalProof.plannerChatProductionCallsites.length, 0);
    assert.equal(evidence.deleteProof.forgotten, true);
    assert.equal(evidence.deleteProof.postForgetExcerptsReturned, 0);
    assert.equal(evidence.artifactPrivacyProof.rawSourceTextPresentInArtifact, false);
    assert.equal(artifact.includes("basalt-grid approval"), false);
    assert.equal(artifact.includes("Synthetic Source Recall smoke quote"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
