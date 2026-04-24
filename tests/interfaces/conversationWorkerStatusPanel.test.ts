/**
 * @fileoverview Tests terminal status-panel rendering for completed jobs with delivery issues.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { buildTerminalPersistentStatusUpdate } from "../../src/interfaces/conversationRuntime/conversationWorkerStatusPanel";
import type { ConversationJob } from "../../src/interfaces/sessionStore";

function buildCompletedJob(nowIso: string): ConversationJob {
  return {
    id: "job-status-1",
    input: "build the page",
    executionInput: "build the page",
    createdAt: nowIso,
    startedAt: nowIso,
    completedAt: nowIso,
    status: "completed",
    resultSummary: "The landing page is ready to review.",
    errorMessage: null,
    ackTimerGeneration: 0,
    ackEligibleAt: null,
    ackLifecycleState: "FINAL_SENT_NO_EDIT",
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: null,
    finalDeliveryOutcome: "not_attempted",
    finalDeliveryAttemptCount: 0,
    finalDeliveryLastErrorCode: null,
    finalDeliveryLastAttemptAt: null
  };
}

test("buildTerminalPersistentStatusUpdate tells the truth when completed work hit a final delivery failure", () => {
  const nowIso = "2026-04-13T21:15:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-status",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  const job = buildCompletedJob(nowIso);
  job.finalDeliveryOutcome = "failed";
  job.finalDeliveryLastErrorCode = "TELEGRAM_SEND_HTTP_400";

  const update = buildTerminalPersistentStatusUpdate(session, job);

  assert.deepEqual(update, {
    status: "completed",
    message: "The work finished, but sending the full final reply here failed (TELEGRAM_SEND_HTTP_400). Ask me to summarize it again or open the result directly."
  });
});
