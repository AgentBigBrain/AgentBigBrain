import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProfileMemoryIngestRequest } from "../../src/core/profileMemoryRuntime/contracts";
import {
  buildDeterministicSelfIdentityReply,
  buildDeterministicSelfIdentityDeclarationReply,
  buildModelAssistedSelfIdentityReply
} from "../../src/interfaces/conversationRuntime/selfIdentityPrompting";
import { buildConversationSessionFixture } from "../helpers/conversationFixtures";

test("buildDeterministicSelfIdentityDeclarationReply defers ambiguous discourse-heavy declarations to the shared interpreter path", async () => {
  let rememberCalls = 0;

  const reply = await buildDeterministicSelfIdentityDeclarationReply(
    "I already told you my name is Avery several times.",
    "2026-03-21T10:00:00.000Z",
    async () => {
      rememberCalls += 1;
      return true;
    }
  );

  assert.equal(reply, null);
  assert.equal(rememberCalls, 0);
});

test("buildModelAssistedSelfIdentityReply persists canonical identity declarations after deterministic validation", async () => {
  const session = buildConversationSessionFixture(
    {
      conversationTurns: [
        {
          role: "assistant",
          text: "I don't know your name yet. If you tell me, I can use it.",
          at: "2026-03-21T10:00:00.000Z"
        }
      ]
    },
    {
      receivedAt: "2026-03-21T10:00:00.000Z"
    }
  );
  const rememberedInputs: (string | ProfileMemoryIngestRequest)[] = [];

  const reply = await buildModelAssistedSelfIdentityReply(
    session,
    "I already told you my name is Avery several times.",
    "2026-03-21T10:01:00.000Z",
    null,
    undefined,
    async (input) => {
      rememberedInputs.push(input);
      return true;
    },
    async () => ({
      source: "local_intent_model",
      kind: "self_identity_declaration",
      candidateValue: "Avery",
      confidence: "medium",
      shouldPersist: true,
      explanation: "The user is reaffirming their preferred name."
    })
  );

  assert.equal(reply, "Okay, I'll remember that you're Avery.");
  assert.deepEqual(rememberedInputs, [
    {
      validatedFactCandidates: [
        {
          key: "identity.preferred_name",
          candidateValue: "Avery",
          source: "conversation.identity_interpretation",
          confidence: 0.95
        }
      ]
    }
  ]);
});

test("buildModelAssistedSelfIdentityReply fails closed when the model returns an unsafe candidate", async () => {
  const session = buildConversationSessionFixture(
    {},
    {
      receivedAt: "2026-03-21T10:00:00.000Z"
    }
  );
  let rememberCalls = 0;

  const reply = await buildModelAssistedSelfIdentityReply(
    session,
    "I already told you my name is Avery several times.",
    "2026-03-21T10:02:00.000Z",
    null,
    undefined,
    async () => {
      rememberCalls += 1;
      return true;
    },
    async () => ({
      source: "local_intent_model",
      kind: "self_identity_declaration",
      candidateValue: "Avery several times",
      confidence: "medium",
      shouldPersist: true,
      explanation: "Unsafe oversized clause."
    })
  );

  assert.equal(
    reply,
    "If you're telling me your name, say it in a short direct form like \"My name is Avery.\" and I'll remember it."
  );
  assert.equal(rememberCalls, 0);
});

test("buildDeterministicSelfIdentityReply ignores relationship facts for direct self-identity questions", async () => {
  const session = buildConversationSessionFixture(
    {},
    {
      receivedAt: "2026-03-21T10:03:00.000Z"
    }
  );

  const reply = await buildDeterministicSelfIdentityReply(
    session,
    "Do you know who I am?",
    async () => [
      {
        factId: "fact_relationship_manager",
        key: "relationship.manager_name",
        value: "Morgan",
        status: "active",
        observedAt: "2026-03-21T09:00:00.000Z",
        lastUpdatedAt: "2026-03-21T09:00:00.000Z",
        confidence: 0.82
      }
    ]
  );

  assert.equal(reply, "I don't know your name yet.");
});
