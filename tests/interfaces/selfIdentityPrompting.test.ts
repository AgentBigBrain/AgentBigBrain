import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProfileMemoryIngestRequest } from "../../src/core/profileMemoryRuntime/contracts";
import { createProfileMemoryRequestTelemetry } from "../../src/core/profileMemoryRuntime/profileMemoryRequestTelemetry";
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
  const telemetry = createProfileMemoryRequestTelemetry();

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
    }),
    telemetry
  );

  assert.equal(reply, "Okay, I'll remember that you're Avery.");
  assert.equal(rememberedInputs.length, 1);
  const rememberedRequest = rememberedInputs[0] as ProfileMemoryIngestRequest;
  assert.deepEqual(rememberedRequest.validatedFactCandidates, [
    {
      key: "identity.preferred_name",
      candidateValue: "Avery",
      source: "conversation.identity_interpretation",
      confidence: 0.95
    }
  ]);
  assert.equal(rememberedRequest.provenance?.conversationId, session.conversationId);
  assert.equal(rememberedRequest.provenance?.dominantLaneAtWrite, session.domainContext.dominantLane);
  assert.equal(
    rememberedRequest.provenance?.threadKey,
    session.conversationStack?.activeThreadKey ?? null
  );
  assert.equal(rememberedRequest.provenance?.sourceSurface, "conversation_profile_input");
  assert.match(rememberedRequest.provenance?.turnId ?? "", /^turn_[a-f0-9]{24}$/);
  assert.match(rememberedRequest.provenance?.sourceFingerprint ?? "", /^[a-f0-9]{32}$/);
  assert.equal(telemetry.identitySafetyDecisionCount, 1);
  assert.equal(telemetry.selfIdentityParityCheckCount, 0);
  assert.equal(telemetry.selfIdentityParityMismatchCount, 0);
});

test("buildModelAssistedSelfIdentityReply fails closed when the model returns an unsafe candidate", async () => {
  const session = buildConversationSessionFixture(
    {},
    {
      receivedAt: "2026-03-21T10:00:00.000Z"
    }
  );
  let rememberCalls = 0;
  const telemetry = createProfileMemoryRequestTelemetry();

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
    }),
    telemetry
  );

  assert.equal(
    reply,
    "If you're telling me your name, say it in a short direct form like \"My name is Avery.\" and I'll remember it."
  );
  assert.equal(rememberCalls, 0);
  assert.equal(telemetry.identitySafetyDecisionCount, 1);
  assert.equal(telemetry.selfIdentityParityCheckCount, 0);
  assert.equal(telemetry.selfIdentityParityMismatchCount, 0);
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
    async (request) => {
      assert.equal(request.semanticMode, "identity");
      assert.equal(request.relevanceScope, "global_profile");
      return [
        {
          factId: "fact_relationship_manager",
          key: "relationship.manager_name",
          value: "Morgan",
          status: "active",
          observedAt: "2026-03-21T09:00:00.000Z",
          lastUpdatedAt: "2026-03-21T09:00:00.000Z",
          confidence: 0.82
        }
      ];
    }
  );

  assert.equal(reply, "I don't know your name yet.");
});

test("buildDeterministicSelfIdentityReply records parity mismatch against conflicting transport identity hints", async () => {
  const session = buildConversationSessionFixture(
    {
      transportIdentity: {
        provider: "telegram",
        username: "morgan_handle",
        displayName: "Morgan",
        givenName: "Morgan",
        familyName: null,
        observedAt: "2026-03-21T10:04:00.000Z"
      }
    },
    {
      receivedAt: "2026-03-21T10:04:00.000Z"
    }
  );
  const telemetry = createProfileMemoryRequestTelemetry();

  const reply = await buildDeterministicSelfIdentityReply(
    session,
    "Who am I?",
    async () => [
      {
        factId: "fact_identity_preferred_name",
        key: "identity.preferred_name",
        value: "Avery",
        status: "active",
        observedAt: "2026-03-21T09:00:00.000Z",
        lastUpdatedAt: "2026-03-21T09:30:00.000Z",
        confidence: 0.99
      }
    ],
    telemetry
  );

  assert.equal(reply, "You're Avery.");
  assert.equal(telemetry.identitySafetyDecisionCount, 1);
  assert.equal(telemetry.retrievalOperationCount, 1);
  assert.equal(telemetry.selfIdentityParityCheckCount, 1);
  assert.equal(telemetry.selfIdentityParityMismatchCount, 1);
});
