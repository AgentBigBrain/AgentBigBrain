import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { resolveModeContinuityIntent } from "../../src/interfaces/conversationRuntime/modeContinuity";
import type { ResolvedConversationIntentMode } from "../../src/interfaces/conversationRuntime/intentModeContracts";

function buildChatIntent(): ResolvedConversationIntentMode {
  return {
    mode: "chat",
    confidence: "medium",
    matchedRuleId: "test_chat",
    explanation: "test",
    clarification: null,
    semanticHint: null
  };
}

test("resolveModeContinuityIntent emits typed workflow-resume continuation metadata", () => {
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-mode-continuity-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-04-26T14:00:00.000Z"
  });
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-26T13:59:00.000Z",
    lastUserInput: "Build the landing page and keep going until it is done."
  };

  const resolved = resolveModeContinuityIntent(
    session,
    "Okay, keep going with it.",
    buildChatIntent()
  );

  assert.equal(resolved?.mode, "build");
  assert.equal(resolved?.semanticRoute?.routeId, "build_request");
  assert.equal(resolved?.semanticRoute?.continuationKind, "workflow_resume");
});
