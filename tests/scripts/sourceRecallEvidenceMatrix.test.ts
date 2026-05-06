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
  assert.equal(scenarios.length, 12);

  const matrix = await runSourceRecallEvidenceMatrix(scenarios);
  assert.equal(matrix.artifactKind, "source_recall_evidence_matrix");
  assert.equal(matrix.evidenceMode, "synthetic_runtime_observed");
  assert.equal(matrix.liveDependencyStatus, "NOT_REQUIRED");
  assert.equal(matrix.summary.failed, 0);
  assert.equal(matrix.summary.passed, scenarios.length);
  assert.equal(matrix.topLevelStatus.status, "PASS");
  assert.equal(matrix.storageProof.encryptedProductionStore, true);
  assert.equal(matrix.storageProof.plaintextStoreAllowed, false);
  assert.equal(matrix.storageProof.rawRowStorageMode, "encrypted_v1");
  assert.equal(matrix.storageProof.rawRowContainsSeedText, false);
  assert.equal(matrix.productionStatusProof.disabledDefaultStatus, "disabled");
  assert.equal(matrix.productionStatusProof.enabledStatus, "enabled");
  assert.equal(matrix.productionStatusProof.blockedMissingEncryptionStatus, "blocked_missing_encryption");
  assert.equal(matrix.productionStatusProof.blockedByPolicyStatus, "blocked_by_policy");
  assert.equal(matrix.artifactPrivacyProof.rawSeedSourceTextPresentInArtifact, false);
  assert.equal(matrix.artifactPrivacyProof.localDesktopPathPresentInArtifact, false);
  assert.equal(matrix.artifactPrivacyProof.tokenShapedSecretPresentInArtifact, false);

  for (const result of matrix.results) {
    assert.equal(result.status, "PASS");
    assert.equal(result.proofSource, "runtime_observed");
    assert.equal(result.authorityProof.currentTruthAuthority, false);
    assert.equal(result.authorityProof.completionProofAuthority, false);
    assert.equal(result.authorityProof.approvalAuthority, false);
    assert.equal(result.authorityProof.safetyAuthority, false);
    assert.equal(result.authorityProof.actionAuthority, false);
    assert.equal(result.authorityProof.networkWriteApprovalAuthority, false);
    assert.equal(result.authorityProof.routeMetadataAuthority, false);
    assert.equal(result.authorityProof.browserProcessFileProofAuthority, false);
    assert.equal(result.authorityProof.memoryWriteAuthority, false);
    assert.equal(result.authorityProof.profileMemoryWriteAuthority, false);
    assert.equal(result.authorityProof.semanticLessonCommitAuthority, false);
    assert.equal(result.authorityProof.semanticCandidatePromotionAuthority, false);
  }
});

test("Source Recall evidence matrix includes delete prompt-injection and projection authority proofs", async () => {
  const matrix = await runSourceRecallEvidenceMatrix(await loadSourceRecallEvidenceScenarios());
  const deleteResult = matrix.results.find((result) => result.id === "delete_cascade_projection");
  const promptResult = matrix.results.find((result) => result.id === "prompt_injection_resistance");
  const projectionResult = matrix.results.find((result) => result.id === "projection_review_boundary");

  assert.equal(deleteResult?.status, "PASS");
  assert.equal(deleteResult?.excerptsReturned, 0);
  assert.equal(deleteResult?.projectionEntriesReturned, 0);
  assert.equal(deleteResult?.deleteProof?.postForgetExcerptsReturned, 0);
  assert.equal(deleteResult?.deleteProof?.visibleIndexEntriesAfterForget, 0);
  assert.equal(deleteResult?.deleteProof?.vectorRefsAfterForget, 0);
  assert.equal(promptResult?.status, "PASS");
  assert.equal(promptResult?.promptInjectionProof?.completionProofSpoofQuoted, true);
  assert.equal(promptResult?.promptInjectionProof?.approvalCommandSpoofQuoted, true);
  assert.equal(promptResult?.promptInjectionProof?.routeMetadataSpoofQuoted, true);
  assert.equal(promptResult?.promptInjectionProof?.browserProcessFileProofSpoofQuoted, true);
  assert.equal(promptResult?.promptInjectionProof?.standaloneInstructionAbsent, true);
  assert.equal(projectionResult?.status, "PASS");
  assert.equal(projectionResult?.projectionProof?.reviewSafeEntriesReturned, 1);
  assert.equal(projectionResult?.projectionProof?.reviewSafeEntryRedacted, true);
  assert.equal(projectionResult?.projectionProof?.operatorFullUnlatchedFullTextExposed, false);
  assert.equal(projectionResult?.projectionProof?.operatorFullLatchedFullTextExposed, true);
  assert.equal(projectionResult?.projectionProof?.authorityNoticePresent, true);
});

test("Source Recall evidence matrix fails when expected values are copied instead of observed", async () => {
  const scenarios = await loadSourceRecallEvidenceScenarios();
  const exactQuoteScenario = scenarios.find((scenario) => scenario.id === "exact_quote_recall");
  assert.ok(exactQuoteScenario);

  const matrix = await runSourceRecallEvidenceMatrix([
    {
      ...exactQuoteScenario,
      expectedRetrievalMode: "keyword"
    }
  ]);
  const result = matrix.results[0];

  assert.equal(result?.status, "FAIL");
  assert.equal(result?.retrievalMode, "exact_quote");
  assert.equal(result?.expectedRetrievalMode, "keyword");
  assert.match(result?.failureReasons.join("\n") ?? "", /retrieval mode exact_quote did not match keyword/);
});
