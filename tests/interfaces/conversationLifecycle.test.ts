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
import {
  buildConversationJobFixture,
  buildConversationSessionFixture
} from "../helpers/conversationFixtures";

/**
 * Builds a minimal conversation session for lifecycle helper tests.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const nowIso = new Date().toISOString();
  return buildConversationSessionFixture(
    {
      updatedAt: nowIso,
      agentPulse: {
        ...buildConversationSessionFixture().agentPulse,
        optIn: true
      },
      ...overrides
    },
    {
      conversationId,
      receivedAt: nowIso
    }
  );
}

/**
 * Builds a minimal conversation job for ack-lifecycle tests.
 */
function buildJob(): ConversationJob {
  return buildConversationJobFixture({
    input: "input",
    executionInput: "input",
    createdAt: "2026-03-07T15:00:00.000Z"
  });
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
  assert.ok(queued.reply.includes("1 request is already waiting ahead of it."));
});

test("setConversationAckLifecycleState fails closed on invalid transitions", () => {
  const job = buildJob();
  setConversationAckLifecycleState(job, "SENT", "ERR_SHOULD_NOT_APPLY");
  assert.equal(job.ackLifecycleState, "SENT");

  setConversationAckLifecycleState(job, "NOT_SENT", "ERR_INVALID_ACK_TRANSITION");
  assert.equal(job.ackLifecycleState, "CANCELLED");
  assert.equal(job.ackLastErrorCode, "ERR_INVALID_ACK_TRANSITION");
});
