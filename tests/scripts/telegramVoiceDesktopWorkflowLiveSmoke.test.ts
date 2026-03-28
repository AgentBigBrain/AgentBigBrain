import assert from "node:assert/strict";
import test from "node:test";

import {
  runTelegramVoiceDesktopWorkflowLiveSmoke
} from "../../scripts/evidence/telegramVoiceDesktopWorkflowLiveSmoke";

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

test("telegram voice desktop workflow live smoke keeps exact voice-note evidence reviewable", async (t) => {
  if (!parseBoolean(process.env.BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM)) {
    t.skip("Telegram voice desktop workflow live smoke requires explicit live confirmation.");
    return;
  }

  const artifact = await runTelegramVoiceDesktopWorkflowLiveSmoke();

  assert.equal(artifact.status, "PASS");
  assert.equal(artifact.packageJsonExists, true);
  assert.equal(artifact.reactEntryExists, true);
  assert.equal(artifact.cssEntryExists, true);
  assert.equal(artifact.browserSessionStatus, "open");
  assert.equal(artifact.previewReachable, true);
  assert.ok(artifact.latestJob);
  assert.equal(artifact.latestJob?.status, "completed");
  if (artifact.recoveryAttempted) {
    assert.equal(artifact.latestJob?.recoverySummary !== null, true);
    assert.equal(artifact.latestJob?.recoveryStatus === "recovered", true);
  }
});
