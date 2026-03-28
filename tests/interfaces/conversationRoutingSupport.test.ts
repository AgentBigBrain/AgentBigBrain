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
