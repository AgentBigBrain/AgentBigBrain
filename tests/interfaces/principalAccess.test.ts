/**
 * @fileoverview Tests principal context derivation and operation-specific access envelopes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLegacyUnknownPrincipalContext,
  derivePrincipalContextFromIngress,
  normalizePrincipalContext,
  requirePrincipalAccessForOperation
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

const PRINCIPAL_KEY = "test-principal-hmac-key";

test("principal context resolves configured owner by exact provider user id", () => {
  const config = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: PRINCIPAL_KEY,
    BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-1"
  });
  const context = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "owner-user-1",
    username: "same_display",
    conversationVisibility: "private",
    receivedAt: "2026-05-10T12:00:00.000Z",
    principalConfig: config
  });

  assert.equal(context.actor.principalRole, "owner");
  assert.equal(context.actor.ownerMatchSource, "provider_user_id");
  assert.equal(context.actor.identityAuthority, "configured_owner_provider_user_id");
  assert.equal(context.actor.principalId.includes("owner-user-1"), false);
  assert.equal(context.subject.ownerSubjectRef?.subjectKind, "owner_profile");
});

test("principal context keeps username allowlist separate from owner authority", () => {
  const context = derivePrincipalContextFromIngress({
    provider: "discord",
    conversationId: "channel-1",
    userId: "participant-user-1",
    username: "owner_handle",
    conversationVisibility: "private",
    receivedAt: "2026-05-10T12:00:00.000Z",
    allowedUsernames: ["owner_handle"]
  });

  assert.equal(context.actor.principalRole, "allowed_user");
  assert.equal(context.actor.ownerMatchSource, "none");
  assert.equal(context.actor.identityAuthority, "allowlisted_username");
  assert.equal(context.subject.ownerSubjectRef, null);
});

test("principal context is stable across channels when HMAC key is configured", () => {
  const config = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: PRINCIPAL_KEY
  });
  const first = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-a",
    userId: "participant-user-1",
    username: "participant",
    conversationVisibility: "private",
    receivedAt: "2026-05-10T12:00:00.000Z",
    principalConfig: config
  });
  const second = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-b",
    userId: "participant-user-1",
    username: "participant",
    conversationVisibility: "public",
    receivedAt: "2026-05-10T12:00:05.000Z",
    principalConfig: config
  });

  assert.equal(first.actor.principalId, second.actor.principalId);
  assert.equal(first.actor.principalRole, "conversation_participant");
});

test("legacy unknown principal context fails closed", () => {
  const context = buildLegacyUnknownPrincipalContext({
    requestId: "legacy:test",
    conversationVisibility: "unknown"
  });

  assert.equal(context.actor.principalRole, "legacy_unknown");
  assert.equal(context.actor.providerUserIdHash, null);
  assert.equal(context.subject.speakerSubjectRef, null);
});

test("access decisions are operation specific", () => {
  const context = buildLegacyUnknownPrincipalContext({
    requestId: "legacy:test",
    conversationVisibility: "unknown"
  });
  const envelope = requirePrincipalAccessForOperation({
    principalContext: context,
    operation: "direct_reply",
    accessClass: "session_only",
    allowed: true,
    reason: "session_only_allowed"
  });

  assert.equal(envelope.accessDecision.operation, "direct_reply");
  assert.notEqual(envelope.accessDecision.operation, "profile_write");
});

test("principal context normalization preserves safe metadata and rejects malformed records", () => {
  const context = buildLegacyUnknownPrincipalContext({
    requestId: "legacy:test",
    conversationVisibility: "unknown"
  });

  const normalized = normalizePrincipalContext(context);
  assert.equal(normalized?.actor.principalRole, "legacy_unknown");
  assert.equal(normalized?.actor.providerUserIdHash, null);
  assert.equal(normalized?.route.visibility, "unknown");
  assert.equal(normalizePrincipalContext({ ...context, actor: { principalRole: "owner" } }), null);
});
