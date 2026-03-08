import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeConversationSession } from "../../src/interfaces/conversationRuntime/sessionMerging";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    conversationId: "telegram:chat-1:user-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    updatedAt: "2026-03-07T12:00:00.000Z",
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    classifierEvents: [],
    agentPulse: {
      optIn: false,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null,
      recentEmissions: []
    },
    ...overrides
  };
}

test("mergeConversationSession removes completed jobs from the queued list", () => {
  const existing = buildSession({
    runningJobId: "job-1",
    queuedJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
        startedAt: null,
        completedAt: null,
        status: "queued",
        resultSummary: null,
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: null,
        ackLifecycleState: "NOT_SENT",
        ackMessageId: null,
        ackSentAt: null,
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "not_attempted",
        finalDeliveryAttemptCount: 0,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: null
      }
    ]
  });
  const incoming = buildSession({
    updatedAt: "2026-03-07T12:05:00.000Z",
    recentJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:01:00.000Z",
        completedAt: "2026-03-07T12:04:00.000Z",
        status: "completed",
        resultSummary: "done",
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: null,
        ackLifecycleState: "FINAL_SENT_NO_EDIT",
        ackMessageId: "ack-1",
        ackSentAt: "2026-03-07T12:01:00.000Z",
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "sent",
        finalDeliveryAttemptCount: 1,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: "2026-03-07T12:04:30.000Z"
      }
    ]
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.queuedJobs.length, 0);
  assert.equal(merged.recentJobs.length, 1);
  assert.equal(merged.runningJobId, null);
});
