/**
 * @fileoverview Covers canonical conversation queue and ack-lifecycle helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canUseConversationAckTimerForSession,
  clearConversationAckTimer,
  enqueueConversationJob,
  setConversationAckLifecycleState
} from "../../src/interfaces/conversationRuntime/conversationLifecycle";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/sessionStore";

/**
 * Builds a minimal conversation session for lifecycle helper tests.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const nowIso = new Date().toISOString();
  return {
    conversationId,
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    updatedAt: nowIso,
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null
    },
    ...overrides
  };
}

/**
 * Builds a minimal conversation job for ack-lifecycle tests.
 */
function buildJob(): ConversationJob {
  return {
    id: "job-1",
    input: "input",
    executionInput: "input",
    createdAt: "2026-03-07T15:00:00.000Z",
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
  };
}

test("canUseConversationAckTimerForSession only enables Telegram edit-capable non-streaming transports", () => {
  assert.equal(
    canUseConversationAckTimerForSession("telegram:chat-1:user-1", {
      capabilities: {
        supportsEdit: true,
        supportsNativeStreaming: false
      }
    }),
    true
  );
  assert.equal(
    canUseConversationAckTimerForSession("discord:chat-1:user-1", {
      capabilities: {
        supportsEdit: true,
        supportsNativeStreaming: false
      }
    }),
    false
  );
});

test("clearConversationAckTimer removes active timer entries", async () => {
  const timers = new Map<string, NodeJS.Timeout>();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
  }, 30);
  timers.set("telegram:chat-1:user-1", timer);

  clearConversationAckTimer("telegram:chat-1:user-1", timers);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(timers.has("telegram:chat-1:user-1"), false);
  assert.equal(fired, false);
});

test("enqueueConversationJob starts immediately for idle sessions and queues behind active work", () => {
  const idleSession = buildSession("telegram:chat-1:user-1");
  const started = enqueueConversationJob(
    idleSession,
    "first input",
    "2026-03-07T15:00:00.000Z"
  );
  assert.equal(started.shouldStartWorker, true);
  assert.equal(started.reply, "");
  assert.equal(idleSession.queuedJobs.length, 1);

  const busySession = buildSession("telegram:chat-2:user-1", {
    queuedJobs: [buildJob()]
  });
  const queued = enqueueConversationJob(
    busySession,
    "second input",
    "2026-03-07T15:00:00.000Z"
  );
  assert.equal(queued.shouldStartWorker, false);
  assert.ok(queued.reply.includes("Queue depth: 2"));
});

test("setConversationAckLifecycleState fails closed on invalid transitions", () => {
  const job = buildJob();
  setConversationAckLifecycleState(job, "SENT", "ERR_SHOULD_NOT_APPLY");
  assert.equal(job.ackLifecycleState, "SENT");

  setConversationAckLifecycleState(job, "NOT_SENT", "ERR_INVALID_ACK_TRANSITION");
  assert.equal(job.ackLifecycleState, "CANCELLED");
  assert.equal(job.ackLastErrorCode, "ERR_INVALID_ACK_TRANSITION");
});
