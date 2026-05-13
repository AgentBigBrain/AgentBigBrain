/**
 * @fileoverview Conversation turn actor/source metadata coverage for principal-safe sessions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConversationSession } from "../../src/interfaces/sessionStore";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  backfillTurnsFromRecentJobsIfNeeded,
  recordUserTurn
} from "../../src/interfaces/conversationSessionMutations";
import { mergeConversationSession } from "../../src/interfaces/conversationRuntime/sessionMerging";
import { normalizeConversationTurn } from "../../src/interfaces/conversationRuntime/sessionNormalizationRecords";
import {
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

function buildSession(userId = "synthetic-provider-principal"): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId,
    username: "synthetic",
    conversationVisibility: "private",
    receivedAt: "2026-05-10T12:00:00.000Z"
  });
}

function attachOwnerPrincipal(session: ConversationSession): void {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: "test-principal-hmac-key",
    BRAIN_OWNER_TELEGRAM_USER_IDS: "synthetic-provider-principal"
  });
  session.principalContext = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "synthetic-provider-principal",
    username: "synthetic",
    conversationVisibility: "private",
    receivedAt: "2026-05-10T12:00:00.000Z",
    principalConfig
  });
}

function buildCompletedJob(id: string) {
  return {
    id,
    input: `input-${id}`,
    createdAt: "2026-05-10T12:00:00.000Z",
    startedAt: null,
    completedAt: "2026-05-10T12:01:00.000Z",
    status: "completed" as const,
    resultSummary: `done-${id}`,
    errorMessage: null,
    ackTimerGeneration: 0,
    ackEligibleAt: null,
    ackLifecycleState: "NOT_SENT" as const,
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: null,
    finalDeliveryOutcome: "not_attempted" as const,
    finalDeliveryAttemptCount: 0,
    finalDeliveryLastErrorCode: null,
    finalDeliveryLastAttemptAt: null
  };
}

test("recordUserTurn stamps live actor metadata when principal context is available", () => {
  const session = buildSession();
  attachOwnerPrincipal(session);

  recordUserTurn(session, "hello", "2026-05-10T12:02:00.000Z", 4);

  const actor = session.conversationTurns[0]?.metadata?.actor;
  assert.ok(actor);
  assert.equal(actor.source, "session_principal_context");
  assert.equal(actor.principalRole, "owner");
  assert.equal(actor.routeVisibility, "private");
  assert.equal(actor.identityAuthority, "configured_owner_provider_user_id");
  assert.equal(actor.ownerMatchSource, "provider_user_id");
  assert.notEqual(actor.providerUserIdHash, "synthetic-provider-principal");
});

test("backfilled turns are marked as legacy recovered source, not live user speech", () => {
  const session = buildSession();
  session.recentJobs = [buildCompletedJob("1")];

  backfillTurnsFromRecentJobsIfNeeded(session, 2, 4);

  assert.equal(session.conversationTurns.length, 2);
  for (const turn of session.conversationTurns) {
    assert.equal(turn.metadata?.actor?.source, "legacy_recovery");
    assert.equal(turn.metadata?.actor?.principalRole, "legacy_unknown");
    assert.equal(turn.metadata?.actor?.legacyIdentityState, "legacy_actor_unknown");
  }
});

test("normalizeConversationTurn preserves valid actor metadata and drops malformed actor authority", () => {
  const normalized = normalizeConversationTurn({
    role: "user",
    text: "hello",
    at: "2026-05-10T12:00:00.000Z",
    metadata: {
      actor: {
        source: "session_principal_context",
        principalRole: "owner",
        principalIdHash: "hash-1",
        providerUserIdHash: "hash-1",
        routeVisibility: "private",
        identityAuthority: "configured_owner_provider_user_id",
        legacyIdentityState: "principal_verified",
        ownerMatchSource: "provider_user_id",
        displayNameHint: "Synthetic"
      }
    }
  });
  assert.equal(normalized?.metadata?.actor?.principalRole, "owner");

  const malformed = normalizeConversationTurn({
    role: "user",
    text: "hello",
    at: "2026-05-10T12:00:00.000Z",
    metadata: {
      actor: {
        source: "session_principal_context",
        principalRole: "owner",
        routeVisibility: "private"
      } as never
    }
  });
  assert.equal(malformed?.metadata, undefined);
});

test("mergeConversationSession keeps same text and timestamp from different actors", () => {
  const existing = buildSession("synthetic-provider-principal-a");
  const incoming = buildSession("synthetic-provider-principal-b");
  existing.conversationTurns = [{
    role: "user",
    text: "same text",
    at: "2026-05-10T12:00:00.000Z",
    metadata: {
      actor: {
        source: "session_principal_context",
        principalRole: "conversation_participant",
        principalIdHash: "principal-a",
        providerUserIdHash: "principal-a",
        routeVisibility: "private",
        identityAuthority: "transport_hint",
        legacyIdentityState: "principal_verified",
        ownerMatchSource: "none"
      }
    }
  }];
  incoming.conversationTurns = [{
    role: "user",
    text: "same text",
    at: "2026-05-10T12:00:00.000Z",
    metadata: {
      actor: {
        source: "session_principal_context",
        principalRole: "conversation_participant",
        principalIdHash: "principal-b",
        providerUserIdHash: "principal-b",
        routeVisibility: "private",
        identityAuthority: "transport_hint",
        legacyIdentityState: "principal_verified",
        ownerMatchSource: "none"
      }
    }
  }];

  const merged = mergeConversationSession(existing, incoming);

  assert.equal(merged.conversationTurns.length, 2);
});
