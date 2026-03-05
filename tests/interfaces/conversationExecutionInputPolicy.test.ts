/**
 * @fileoverview Tests deterministic execution-input and follow-up policy helpers extracted from conversationManager.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAgentPulseExecutionInput,
  buildConversationAwareExecutionInput,
  buildTurnLocalStatusUpdateBlock,
  resolveFollowUpInput
} from "../../src/interfaces/conversationExecutionInputPolicy";
import {
  buildSessionSeed,
  createFollowUpRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import { classifyRoutingIntentV1 } from "../../src/interfaces/routingMap";
import {
  type ConversationSession
} from "../../src/interfaces/sessionStore";

/**
 * Creates a stable session fixture for execution-input policy tests.
 *
 * @returns Fresh seeded conversation session.
 */
function buildSession(): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-execution-policy",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-03-03T00:00:00.000Z"
  });
}

test("buildTurnLocalStatusUpdateBlock only emits block for first-person status updates", () => {
  const block = buildTurnLocalStatusUpdateBlock("my deployment ticket is still pending");
  assert.match(block ?? "", /Turn-local status update/);
  assert.match(block ?? "", /my deployment ticket is still pending/i);

  const missingStatus = buildTurnLocalStatusUpdateBlock("please help with deployment");
  assert.equal(missingStatus, null);
});

test("resolveFollowUpInput wraps short follow-up answers with prior assistant clarification context", () => {
  const session = buildSession();
  session.conversationTurns.push({
    id: "assistant-turn-1",
    role: "assistant",
    text: "Do you want the private or public pulse mode?",
    createdAt: "2026-03-03T00:00:10.000Z"
  });

  const resolution = resolveFollowUpInput(
    session,
    "private",
    createFollowUpRuleContext(null)
  );

  assert.equal(resolution.classification.isShortFollowUp, true);
  assert.match(resolution.executionInput, /Follow-up user response to prior assistant clarification/);
  assert.match(resolution.executionInput, /Previous assistant question:/);
  assert.match(resolution.executionInput, /User follow-up answer: private/);
});

test("buildConversationAwareExecutionInput returns raw input when no context, status, or routing hints exist", () => {
  const session = buildSession();
  const executionInput = buildConversationAwareExecutionInput(
    session,
    "just do this",
    10
  );

  assert.equal(executionInput, "just do this");
});

test("buildConversationAwareExecutionInput includes conversation context, status guardrails, and routing hint", () => {
  const session = buildSession();
  session.conversationTurns.push({
    id: "user-turn-1",
    role: "user",
    text: "Please keep approvals deterministic.",
    createdAt: "2026-03-03T00:00:10.000Z"
  });
  session.conversationTurns.push({
    id: "assistant-turn-2",
    role: "assistant",
    text: "I will provide the exact approval diff before any write.",
    createdAt: "2026-03-03T00:00:20.000Z"
  });

  const executionInput = buildConversationAwareExecutionInput(
    session,
    "my release status is pending",
    10,
    classifyRoutingIntentV1("schedule 3 focus blocks next week")
  );

  assert.match(executionInput, /Recent conversation context \(oldest to newest\):/);
  assert.match(executionInput, /Turn-local status update \(authoritative for this turn\):/);
  assert.match(executionInput, /Deterministic routing hint:/);
  assert.match(executionInput, /Current user request:/);
});

test("buildAgentPulseExecutionInput includes pulse safety instructions and bounded context", () => {
  const session = buildSession();
  session.conversationTurns.push({
    id: "assistant-turn-1",
    role: "assistant",
    text: "Reminder: we paused at checkpoint 6.86.G.",
    createdAt: "2026-03-03T00:00:10.000Z"
  });

  const executionInput = buildAgentPulseExecutionInput(
    session,
    "Follow up on unresolved checkpoint reminders.",
    10
  );

  assert.match(executionInput, /^System-generated Agent Pulse check-in request\./);
  assert.match(executionInput, /Do not impersonate a human\./);
  assert.match(executionInput, /Agent Pulse request:/);
  assert.match(executionInput, /Recent conversation context \(oldest to newest\):/);
});
