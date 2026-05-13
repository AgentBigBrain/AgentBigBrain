/**
 * @fileoverview Current-speaker name resolution coverage for direct conversation prompts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmptyConversationStackV1 } from "../../src/core/stage6_86ConversationStack";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  buildCurrentSpeakerNameResolutionBlock
} from "../../src/interfaces/conversationRuntime/currentUserIdentityReference";
import type {
  ConversationContinuityFactRecord,
  QueryConversationContinuityFacts
} from "../../src/interfaces/conversationRuntime/continuityContracts";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import {
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

function buildSession(input: {
  userId: string;
  displayName: string;
  ownerId?: string;
  visibility?: "private" | "public";
}): ConversationSession {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: "test-principal-hmac-key",
    ...(input.ownerId ? { BRAIN_OWNER_TELEGRAM_USER_IDS: input.ownerId } : {})
  });
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: input.userId,
    username: "synthetic",
    conversationVisibility: input.visibility ?? "private",
    receivedAt: "2026-05-10T12:00:00.000Z",
    transportIdentity: {
      provider: "telegram",
      username: "synthetic",
      displayName: input.displayName,
      givenName: null,
      familyName: null,
      observedAt: "2026-05-10T12:00:00.000Z"
    }
  });
  session.principalContext = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-1",
    userId: input.userId,
    username: "synthetic",
    conversationVisibility: input.visibility ?? "private",
    transportIdentity: session.transportIdentity,
    receivedAt: "2026-05-10T12:00:00.000Z",
    principalConfig
  });
  session.conversationStack = createEmptyConversationStackV1("2026-05-10T12:00:00.000Z");
  return session;
}

function buildIdentityFact(value: string): ConversationContinuityFactRecord {
  return {
    factId: "fact_identity",
    key: "identity.preferred_name",
    value,
    status: "confirmed",
    observedAt: "2026-05-10T12:00:00.000Z",
    lastUpdatedAt: "2026-05-10T12:00:00.000Z",
    confidence: 0.95
  };
}

test("current speaker name block scopes a same-name self query to the speaker", async () => {
  const session = buildSession({
    userId: "synthetic-owner-principal",
    ownerId: "synthetic-owner-principal",
    displayName: "Morgan Sample"
  });
  const queryContinuityFacts: QueryConversationContinuityFacts = async () => [
    buildIdentityFact("Morgan Sample")
  ];

  const block = await buildCurrentSpeakerNameResolutionBlock(
    session,
    "Tell me about Morgan",
    queryContinuityFacts
  );

  assert.ok(block);
  assert.match(block, /Current-speaker name resolution context:/);
  assert.match(block, /Resolution scope: current_speaker/);
  assert.match(block, /Access class: owner_private/);
  assert.match(block, /Same-subject identity facts available/);
});

test("non-owner same-name speaker does not receive owner identity facts", async () => {
  const session = buildSession({
    userId: "synthetic-participant-principal",
    ownerId: "synthetic-owner-principal",
    displayName: "Morgan Sample"
  });
  let queried = false;
  const queryContinuityFacts: QueryConversationContinuityFacts = async () => {
    queried = true;
    return [buildIdentityFact("Morgan Owner")];
  };

  const block = await buildCurrentSpeakerNameResolutionBlock(
    session,
    "Tell me about Morgan",
    queryContinuityFacts
  );

  assert.ok(block);
  assert.equal(queried, false);
  assert.match(block, /Access class: speaker_private/);
  assert.match(block, /No same-subject identity facts are available/);
  assert.doesNotMatch(block, /Morgan Owner/);
});

test("public route keeps current speaker name resolution session scoped", async () => {
  const session = buildSession({
    userId: "synthetic-owner-principal",
    ownerId: "synthetic-owner-principal",
    displayName: "Morgan Sample",
    visibility: "public"
  });

  const block = await buildCurrentSpeakerNameResolutionBlock(
    session,
    "Tell me about Morgan",
    async () => [buildIdentityFact("Morgan Sample")]
  );

  assert.ok(block);
  assert.match(block, /Resolution scope: session_only/);
  assert.match(block, /Access class: shared_public/);
  assert.doesNotMatch(block, /Same-subject identity facts available/);
});
