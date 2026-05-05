/**
 * @fileoverview Tests Source Recall synthetic evidence matrix behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadSourceRecallEvidenceScenarios,
  runSourceRecallEvidenceMatrix
} from "../../scripts/evidence/sourceRecallEvidenceMatrix";

test("Source Recall evidence matrix scenarios execute with runtime-observed synthetic proof", async () => {
  const scenarios = await loadSourceRecallEvidenceScenarios();
  assert.equal(scenarios.length, 8);

  const matrix = await runSourceRecallEvidenceMatrix(scenarios);
  assert.equal(matrix.artifactKind, "source_recall_evidence_matrix");
  assert.equal(matrix.evidenceMode, "synthetic_runtime_observed");
  assert.equal(matrix.summary.failed, 0);
  assert.equal(matrix.summary.passed, scenarios.length);

  for (const result of matrix.results) {
    assert.equal(result.status, "PASS");
    assert.equal(result.authorityProof.currentTruthAuthority, false);
    assert.equal(result.authorityProof.completionProofAuthority, false);
    assert.equal(result.authorityProof.approvalAuthority, false);
    assert.equal(result.authorityProof.safetyAuthority, false);
    assert.equal(result.authorityProof.profileMemoryWriteAuthority, false);
  }
});

test("Source Recall evidence matrix includes delete and prompt-injection authority proofs", async () => {
  const matrix = await runSourceRecallEvidenceMatrix(await loadSourceRecallEvidenceScenarios());
  const deleteResult = matrix.results.find((result) => result.id === "delete_cascade_projection");
  const promptResult = matrix.results.find((result) => result.id === "prompt_injection_resistance");

  assert.equal(deleteResult?.status, "PASS");
  assert.equal(deleteResult?.excerptsReturned, 0);
  assert.equal(deleteResult?.projectionEntriesReturned, 0);
  assert.equal(promptResult?.status, "PASS");
  assert.equal(promptResult?.promptInjectionProof?.payloadQuoted, true);
  assert.equal(promptResult?.promptInjectionProof?.standaloneInstructionAbsent, true);
});
