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
    role: "assistant",
    text: "Do you want the private or public pulse mode?",
    at: "2026-03-03T00:00:10.000Z"
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
    role: "user",
    text: "Please keep approvals deterministic.",
    at: "2026-03-03T00:00:10.000Z"
  });
  session.conversationTurns.push({
    role: "assistant",
    text: "I will provide the exact approval diff before any write.",
    at: "2026-03-03T00:00:20.000Z"
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

test("buildConversationAwareExecutionInput includes build-scaffold routing hint for generic app creation prompts", () => {
  const session = buildSession();
  const classification = classifyRoutingIntentV1(
    "Create a React app on my Desktop and execute now."
  );
  const executionInput = buildConversationAwareExecutionInput(
    session,
    "Create a React app on my Desktop and execute now.",
    10,
    classification
  );

  assert.match(executionInput, /Deterministic routing hint:/);
  assert.match(executionInput, /Intent surface: build_scaffold\./i);
  assert.match(executionInput, /Prefer governed finite proof steps first/i);
  assert.match(executionInput, /Only use managed process plus probe actions/i);
  assert.match(executionInput, /BUILD_NO_SIDE_EFFECT_EXECUTED/i);
});

test("buildConversationAwareExecutionInput can inject contextual recall from the raw user turn while preserving wrapped execution input", () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "user",
    text: "Billy fell down a few weeks ago.",
    at: "2026-02-14T15:00:00.000Z"
  });
  session.conversationStack = {
    schemaVersion: "v1",
    updatedAt: "2026-03-03T00:00:00.000Z",
    activeThreadKey: "thread_current",
    threads: [
      {
        threadKey: "thread_current",
        topicKey: "release_rollout",
        topicLabel: "Release Rollout",
        state: "active",
        resumeHint: "Need to finish the rollout.",
        openLoops: [],
        lastTouchedAt: "2026-03-03T00:00:00.000Z"
      },
      {
        threadKey: "thread_billy",
        topicKey: "billy_fall",
        topicLabel: "Billy Fall",
        state: "paused",
        resumeHint: "Billy fell down and you wanted to hear how it ended up.",
        openLoops: [
          {
            loopId: "loop_billy",
            threadKey: "thread_billy",
            entityRefs: ["billy"],
            createdAt: "2026-02-14T15:00:00.000Z",
            lastMentionedAt: "2026-02-14T15:00:00.000Z",
            priority: 0.8,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-02-14T15:00:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "release_rollout",
        label: "Release Rollout",
        firstSeenAt: "2026-03-03T00:00:00.000Z",
        lastSeenAt: "2026-03-03T00:00:00.000Z",
        mentionCount: 1
      },
      {
        topicKey: "billy_fall",
        label: "Billy Fall",
        firstSeenAt: "2026-02-14T15:00:00.000Z",
        lastSeenAt: "2026-02-14T15:00:00.000Z",
        mentionCount: 1
      }
    ]
  };

  const executionInput = buildConversationAwareExecutionInput(
    session,
    "Follow-up user response to prior assistant clarification.\nUser follow-up answer: Billy seems better now.",
    10,
    null,
    "How is Billy doing lately?"
  );

  assert.match(executionInput, /Contextual recall opportunity \(optional\):/);
  assert.match(executionInput, /older paused topic: Billy Fall/i);
  assert.match(executionInput, /Current user request:/);
  assert.match(executionInput, /User follow-up answer: Billy seems better now\./);
});

test("buildAgentPulseExecutionInput includes pulse safety instructions and bounded context", () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "Reminder: we paused at checkpoint 6.86.G.",
    at: "2026-03-03T00:00:10.000Z"
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
