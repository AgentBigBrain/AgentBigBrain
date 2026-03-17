import assert from "node:assert/strict";
import test from "node:test";

import {
  runTelegramWorkflowConversationBlendLiveSmoke
} from "../../scripts/evidence/telegramWorkflowConversationBlendLiveSmoke";

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

test("telegram workflow-conversation blend live smoke keeps conversation natural around workflow turns", async (t) => {
  if (!parseBoolean(process.env.BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM)) {
    t.skip("Telegram live workflow-conversation smoke requires explicit live confirmation.");
    return;
  }

  const artifact = await runTelegramWorkflowConversationBlendLiveSmoke();

  assert.equal(artifact.status, "PASS");
  assert.equal(Object.values(artifact.checks).every(Boolean), true);
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "conversation_before_work" &&
        result.kind === "conversation" &&
        result.pass &&
        result.observedWorkerActivity === false &&
        result.newRecentJobs === 0
    )
  );
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "workflow_plan" &&
        result.kind === "workflow" &&
        result.pass &&
        result.observedWorkerActivity &&
        result.latestRecentJobStatus === "completed" &&
        typeof result.latestRecentJobSummary === "string" &&
        result.latestRecentJobSummary.length > 0
    )
  );
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "conversation_mid_workflow" &&
        result.kind === "conversation" &&
        result.pass &&
        result.observedWorkerActivity === false &&
        result.newRecentJobs === 0
    )
  );
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "workflow_outline" &&
        result.kind === "workflow" &&
        result.pass &&
        result.latestRecentJobStatus === "completed"
    )
  );
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "issue_conversation" &&
        result.kind === "conversation" &&
        result.pass &&
        result.observedWorkerActivity === false &&
        result.newRecentJobs === 0
    )
  );
  assert.ok(
    artifact.results.some(
      (result) =>
        result.id === "workflow_copy" &&
        result.kind === "workflow" &&
        result.pass &&
        result.latestRecentJobStatus === "completed"
    )
  );
});
