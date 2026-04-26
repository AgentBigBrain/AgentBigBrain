import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationStackFromTurnsV1 } from "../../src/core/stage6_86ConversationStack";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { resolveConversationTopicKeyInterpretationSignal } from "../../src/interfaces/conversationRuntime/conversationTopicKeyInterpretation";
import { classifyRoutingIntentV1 } from "../../src/interfaces/routingMap";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import type { ResolvedConversationIntentMode } from "../../src/interfaces/conversationRuntime/intentModeContracts";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-22T10:00:00.000Z"
    }),
    ...overrides
  };
}

function buildIntentMode(mode: ResolvedConversationIntentMode["mode"]): ResolvedConversationIntentMode {
  return {
    mode,
    confidence: "medium",
    matchedRuleId: "test",
    explanation: "test",
    clarification: null,
    semanticHint: null
  };
}

function buildThreadedSession(): ConversationSession {
  const session = buildSession();
  session.conversationTurns = [
    {
      role: "user",
      text: "Landing page hero section",
      at: "2026-03-22T10:00:01.000Z"
    },
    {
      role: "assistant",
      text: "I updated the landing page hero section.",
      at: "2026-03-22T10:00:02.000Z"
    },
    {
      role: "user",
      text: "API auth retry bug",
      at: "2026-03-22T10:00:03.000Z"
    },
    {
      role: "assistant",
      text: "I investigated the API auth retry bug.",
      at: "2026-03-22T10:00:04.000Z"
    }
  ];
  session.conversationStack = buildConversationStackFromTurnsV1(
    session.conversationTurns,
    "2026-03-22T10:00:04.000Z",
    {}
  );
  return session;
}

test("resolveConversationTopicKeyInterpretationSignal maps a validated paused-thread resume signal", async () => {
  const session = buildThreadedSession();
  const pausedThread = session.conversationStack?.threads.find((thread) => thread.state === "paused");
  assert.ok(pausedThread);

  const signal = await resolveConversationTopicKeyInterpretationSignal(
    session,
    "continue that",
    "2026-03-22T10:00:05.000Z",
    classifyRoutingIntentV1("continue that"),
    buildIntentMode("build"),
    async (request) => {
      assert.equal(request.pausedThreads?.length, 1);
      assert.equal(request.activeThread?.state, "active");
      return {
        source: "local_intent_model",
        kind: "resume_paused_thread",
        selectedTopicKey: null,
        selectedThreadKey: pausedThread.threadKey,
        confidence: "high",
        explanation: "resume the paused landing-page thread"
      };
    }
  );

  assert.deepEqual(signal, {
    kind: "resume_paused_thread",
    selectedTopicKey: null,
    selectedThreadKey: pausedThread.threadKey,
    confidence: "high"
  });
});

test("resolveConversationTopicKeyInterpretationSignal skips the model when deterministic topic selection is already strong", async () => {
  const session = buildThreadedSession();
  let resolverCalled = false;

  const signal = await resolveConversationTopicKeyInterpretationSignal(
    session,
    "Update the sample company landing page hero section and pricing CTA.",
    "2026-03-22T10:00:05.000Z",
    classifyRoutingIntentV1("Update the sample company landing page hero section and pricing CTA."),
    buildIntentMode("build"),
    async () => {
      resolverCalled = true;
      return {
        source: "local_intent_model",
        kind: "switch_topic_candidate",
        selectedTopicKey: "ignored",
        selectedThreadKey: null,
        confidence: "high",
        explanation: "ignored"
      };
    }
  );

  assert.equal(signal, null);
  assert.equal(resolverCalled, false);
});
