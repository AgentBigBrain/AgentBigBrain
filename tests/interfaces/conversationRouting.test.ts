/**
 * @fileoverview Covers canonical conversation-routing helpers below the stable ingress coordinator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionSeed,
  createFollowUpRuleContext,
  type FollowUpRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import {
  routeConversationChatInput,
  routeConversationMessageInput,
  type ConversationEnqueueResult,
  type ConversationRoutingDependencies
} from "../../src/interfaces/conversationRuntime/conversationRouting";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-07T16:00:00.000Z"
    }),
    ...overrides
  };
}

function buildRoutingDependencies(
  enqueueJob: ConversationRoutingDependencies["enqueueJob"],
  followUpRuleContext: FollowUpRuleContext = createFollowUpRuleContext(null)
): ConversationRoutingDependencies {
  return {
    followUpRuleContext,
    config: {
      maxContextTurnsForExecution: 6,
      maxConversationTurns: 20
    },
    enqueueJob
  };
}

test("routeConversationChatInput adds deterministic routing hints and records the user turn", () => {
  const session = buildSession();
  let capturedInput = "";
  let capturedExecutionInput = "";

  const result = routeConversationChatInput(
    session,
    "Create a React app at C:\\Temp\\demo and execute now.",
    "2026-03-07T16:00:05.000Z",
    buildRoutingDependencies((currentSession, input, receivedAt, executionInput) => {
      capturedInput = input;
      capturedExecutionInput = executionInput ?? "";
      assert.equal(currentSession, session);
      assert.equal(receivedAt, "2026-03-07T16:00:05.000Z");
      return {
        reply: "queued chat request",
        shouldStartWorker: true
      };
    })
  );

  assert.deepEqual(result, {
    reply: "queued chat request",
    shouldStartWorker: true
  } satisfies ConversationEnqueueResult);
  assert.equal(capturedInput, "Create a React app at C:\\Temp\\demo and execute now.");
  assert.ok(capturedExecutionInput.includes("Deterministic routing hint:"));
  assert.equal(session.conversationTurns.length, 1);
  assert.equal(
    session.conversationTurns[0]?.text,
    "Create a React app at C:\\Temp\\demo and execute now."
  );
});

test("routeConversationMessageInput keeps follow-up execution envelopes without adding chat-only routing hints", () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "assistant",
        text: "Would you like plain text or markdown?",
        at: "2026-03-07T16:00:02.000Z"
      }
    ]
  });
  let capturedExecutionInput = "";

  const result = routeConversationMessageInput(
    session,
    "plain text",
    "2026-03-07T16:00:05.000Z",
    buildRoutingDependencies((_currentSession, _input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      return {
        reply: "queued follow-up",
        shouldStartWorker: true
      };
    })
  );

  assert.deepEqual(result, {
    reply: "queued follow-up",
    shouldStartWorker: true
  } satisfies ConversationEnqueueResult);
  assert.ok(
    capturedExecutionInput.includes("Follow-up user response to prior assistant clarification.")
  );
  assert.ok(capturedExecutionInput.includes("User follow-up answer: plain text"));
  assert.ok(!capturedExecutionInput.includes("Deterministic routing hint:"));
  assert.equal(session.classifierEvents?.length, 1);
  assert.equal(session.classifierEvents?.[0]?.classifier, "follow_up");
  assert.equal(session.conversationTurns.at(-1)?.text, "plain text");
});
