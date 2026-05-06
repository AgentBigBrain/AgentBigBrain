import assert from "node:assert/strict";
import test from "node:test";

import {
  runSourceRecallTelegramDesktopLiveSmoke
} from "../../scripts/evidence/sourceRecallTelegramDesktopLiveSmoke";

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

test("Source Recall Telegram/Desktop live smoke proves encrypted capture and quoted recall", async (t) => {
  if (!parseBoolean(process.env.BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM)) {
    t.skip("Source Recall Telegram/Desktop live smoke requires explicit live confirmation.");
    return;
  }

  const evidence = await runSourceRecallTelegramDesktopLiveSmoke({ writeArtifact: false });

  assert.equal(evidence.status, "PASS");
  assert.equal(evidence.desktopWorkflowProof.status, "PASS");
  assert.equal(evidence.desktopWorkflowProof.browserOpened, true);
  assert.equal(evidence.desktopWorkflowProof.browserClosed, true);
  assert.equal(evidence.sourceRecallProof.encryptedProductionStore, true);
  assert.equal(evidence.sourceRecallProof.plaintextStoreAllowed, false);
  assert.equal(evidence.sourceRecallProof.recordsCaptured > 0, true);
  assert.equal(evidence.sourceRecallProof.conversationTurnRecordsCaptured > 0, true);
  assert.equal(evidence.sourceRecallProof.exactQuoteRetrieved, true);
  assert.equal(evidence.sourceRecallProof.authority?.currentTruthAuthority, false);
  assert.equal(evidence.sourceRecallProof.authority?.approvalAuthority, false);
  assert.equal(evidence.sourceRecallProof.authority?.completionProofAuthority, false);
  assert.equal(evidence.sourceRecallProof.authority?.unsafeToFollowAsInstruction, true);
  assert.equal(evidence.artifactPrivacyProof.rawTargetFolderNamePresentInArtifact, false);
  assert.equal(evidence.artifactPrivacyProof.localDesktopPathPresentInArtifact, false);
  assert.equal(evidence.artifactPrivacyProof.tokenShapedSecretPresentInArtifact, false);
});
