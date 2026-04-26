import assert from "node:assert/strict";
import test from "node:test";

import {
  runTelegramDesktopWorkflowAndCleanupLiveSmoke
} from "../../scripts/evidence/telegramDesktopWorkflowAndCleanupLiveSmoke";

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

test("telegram desktop workflow live smoke blends conversation with real Desktop work", async (t) => {
  if (!parseBoolean(process.env.BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM)) {
    t.skip("Telegram Desktop workflow live smoke requires explicit live confirmation.");
    return;
  }

  const artifact = await runTelegramDesktopWorkflowAndCleanupLiveSmoke();

  assert.equal(artifact.status, "PASS");
  assert.equal(Object.values(artifact.checks).every(Boolean), true);
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "conversation_before_build" &&
        result.pass &&
        result.observedWorkerActivity === false &&
        result.newRecentJobs === 0
    )
  );
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "build_landing_page" &&
        result.pass &&
        result.latestRecentJobStatus === "completed"
    )
  );
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "cleanup_desktop_sample_folders" &&
        result.pass &&
        result.latestRecentJobStatus === "completed" &&
        /^I moved .+ into /i.test(result.latestRecentJobSummary ?? result.reply ?? "")
    )
  );
  assert.ok(artifact.cleanupBaselineRootFolders.includes(artifact.targetFolderName));
  assert.equal(artifact.finalRootFolders.includes(artifact.targetFolderName), false);
});
