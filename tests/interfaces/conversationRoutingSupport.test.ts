import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { buildLocalIntentSessionHints } from "../../src/interfaces/conversationRuntime/conversationRoutingSupport";

test("buildLocalIntentSessionHints surfaces recent identity-context hints even without workflow continuity", () => {
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "avery_brooks",
    conversationVisibility: "private",
    receivedAt: "2026-03-21T10:00:00.000Z"
  });
  session.conversationTurns = [
    {
      id: "turn-user-1",
      role: "user",
      text: "What is my name?",
      at: "2026-03-21T10:00:00.000Z"
    },
    {
      id: "turn-assistant-1",
      role: "assistant",
      text: "What should I call you?",
      at: "2026-03-21T10:00:05.000Z"
    }
  ];

  const hints = buildLocalIntentSessionHints(session);
  assert.ok(hints);
  assert.equal(hints?.recentIdentityConversationActive, true);
  assert.equal(hints?.hasRecentAssistantIdentityPrompt, true);
  assert.equal(hints?.hasRecentAssistantIdentityAnswer, false);
  assert.equal(hints?.hasRecentAssistantQuestion, true);
});

test("buildLocalIntentSessionHints surfaces recent assistant identity answers for bounded direct-chat preservation", () => {
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "avery_brooks",
    conversationVisibility: "private",
    receivedAt: "2026-03-21T10:00:00.000Z"
  });
  session.conversationTurns = [
    {
      id: "turn-user-1",
      role: "user",
      text: "Who are you?",
      at: "2026-03-21T10:00:00.000Z"
    },
    {
      id: "turn-assistant-1",
      role: "assistant",
      text: "I'm BigBrain.",
      at: "2026-03-21T10:00:05.000Z"
    }
  ];

  const hints = buildLocalIntentSessionHints(session);
  assert.ok(hints);
  assert.equal(hints?.hasRecentAssistantIdentityAnswer, true);
  assert.equal(hints?.recentIdentityConversationActive, false);
});

test("buildLocalIntentSessionHints marks recent informational answer threads so workflow continuity cannot hijack vague follow-ups", () => {
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "avery_brooks",
    conversationVisibility: "private",
    receivedAt: "2026-04-12T20:28:00.000Z"
  });
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-12T20:00:00.000Z",
    lastUserInput: "Build the landing page now."
  };
  session.conversationTurns = [
    {
      id: "turn-user-1",
      role: "user",
      text: "What is Sample Web Studio?",
      at: "2026-04-12T20:29:00.000Z"
    },
    {
      id: "turn-assistant-1",
      role: "assistant",
      text: "From the context, Sample Web Studio appears to be a web design company where Billy worked as a front-end contractor.",
      at: "2026-04-12T20:29:05.000Z"
    }
  ];

  const hints = buildLocalIntentSessionHints(session);

  assert.ok(hints);
  assert.equal(hints?.recentAssistantTurnKind, "informational_answer");
  assert.equal(hints?.recentAssistantAnswerThreadActive, true);
});

test("buildLocalIntentSessionHints prefers runtime assistant-turn metadata over rendered prose cues", () => {
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "avery_brooks",
    conversationVisibility: "private",
    receivedAt: "2026-04-12T20:28:00.000Z"
  });
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-12T20:00:00.000Z",
    lastUserInput: "Build the landing page now."
  };
  session.conversationTurns = [
    {
      id: "turn-user-1",
      role: "user",
      text: "What is Sample Web Studio?",
      at: "2026-04-12T20:29:00.000Z"
    },
    {
      id: "turn-assistant-1",
      role: "assistant",
      text: "Status: Sample Web Studio is a fictional creative studio in this test.",
      at: "2026-04-12T20:29:05.000Z",
      metadata: {
        assistantTurnKind: "informational_answer",
        assistantTurnKindSource: "runtime_metadata"
      }
    }
  ];

  const hints = buildLocalIntentSessionHints(session);

  assert.ok(hints);
  assert.equal(hints?.recentAssistantTurnKind, "informational_answer");
  assert.equal(hints?.recentAssistantAnswerThreadActive, true);
});
