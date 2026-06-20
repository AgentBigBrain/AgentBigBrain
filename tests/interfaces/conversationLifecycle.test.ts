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
import { buildTestOwnerTaskPrincipalAccess } from "../helpers/principalAccess";

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

test("enqueueConversationJob stores a redacted job-origin principal snapshot", () => {
  const principalAccess = buildTestOwnerTaskPrincipalAccess();
  const session = buildSession("telegram:chat-3:user-1", {
    principalContext: principalAccess.principalContext
  });

  enqueueConversationJob(
    session,
    "owner scoped request",
    "2026-03-07T15:00:00.000Z"
  );

  const snapshot = session.queuedJobs[0]?.principalSnapshot;
  assert.equal(snapshot?.snapshotState, "verified");
  assert.equal(snapshot?.principalRole, "owner");
  assert.equal(snapshot?.routeVisibility, "private");
  assert.equal(snapshot?.accessOperation, "task_execution");
  assert.equal(snapshot?.accessClass, "owner_private");
  assert.equal(snapshot?.accessAllowed, true);
  assert.equal(snapshot?.providerUserIdHash, principalAccess.principalContext.actor.providerUserIdHash);
  assert.equal(JSON.stringify(snapshot).includes("owner-user-1"), false);
});

test("enqueueConversationJob fails closed when the session has no principal context", () => {
  const session = buildSession("telegram:chat-4:user-1", {
    principalContext: null
  });

  enqueueConversationJob(
    session,
    "legacy request",
    "2026-03-07T15:00:00.000Z"
  );

  const snapshot = session.queuedJobs[0]?.principalSnapshot;
  assert.equal(snapshot?.snapshotState, "legacy_actor_unknown");
  assert.equal(snapshot?.principalRole, "legacy_unknown");
  assert.equal(snapshot?.accessClass, "blocked");
  assert.equal(snapshot?.accessAllowed, false);
});

test("setConversationAckLifecycleState fails closed on invalid transitions", () => {
  const job = buildJob();
  setConversationAckLifecycleState(job, "SENT", "ERR_SHOULD_NOT_APPLY");
  assert.equal(job.ackLifecycleState, "SENT");

  setConversationAckLifecycleState(job, "NOT_SENT", "ERR_INVALID_ACK_TRANSITION");
  assert.equal(job.ackLifecycleState, "CANCELLED");
  assert.equal(job.ackLastErrorCode, "ERR_INVALID_ACK_TRANSITION");
});
