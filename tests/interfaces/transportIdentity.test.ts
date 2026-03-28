import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildConversationTransportIdentityRecord,
  normalizeConversationTransportIdentity,
  selectConversationTransportIdentityNameHint
} from "../../src/interfaces/conversationRuntime/transportIdentity";

test("selectConversationTransportIdentityNameHint prefers transport display names", () => {
  const identity = normalizeConversationTransportIdentity({
    provider: "telegram",
    username: "averybrooks",
    displayName: "Avery Brooks",
    givenName: "Avery",
    familyName: "Bena",
    observedAt: "2026-03-20T21:00:00.000Z"
  });
  const hint = selectConversationTransportIdentityNameHint(identity);

  assert.deepEqual(hint, {
    value: "Avery Brooks",
    source: "display_name",
    confidence: "medium",
    rawValue: "Avery Brooks"
  });
});

test("selectConversationTransportIdentityNameHint uses given names when display names are absent", () => {
  const identity = normalizeConversationTransportIdentity({
    provider: "telegram",
    username: "avery",
    displayName: null,
    givenName: "Avery",
    familyName: null,
    observedAt: "2026-03-20T21:00:00.000Z"
  });
  const hint = selectConversationTransportIdentityNameHint(identity);

  assert.deepEqual(hint, {
    value: "Avery",
    source: "given_name",
    confidence: "medium",
    rawValue: "Avery"
  });
});

test("selectConversationTransportIdentityNameHint can derive a low-confidence name from username handles", () => {
  const identity = buildConversationTransportIdentityRecord({
    provider: "discord",
    username: "avery_brooks",
    displayName: null,
    givenName: null,
    familyName: null,
    observedAt: "2026-03-20T21:00:00.000Z"
  });
  const hint = selectConversationTransportIdentityNameHint(identity);

  assert.deepEqual(hint, {
    value: "Avery Brooks",
    source: "username",
    confidence: "low",
    rawValue: "avery_brooks"
  });
});

test("selectConversationTransportIdentityNameHint rejects generic service handles", () => {
  const identity = buildConversationTransportIdentityRecord({
    provider: "telegram",
    username: "agentowner",
    displayName: null,
    givenName: null,
    familyName: null,
    observedAt: "2026-03-20T21:00:00.000Z"
  });

  assert.equal(selectConversationTransportIdentityNameHint(identity), null);
});

test("selectConversationTransportIdentityNameHint rejects opaque lowercase handles without separators", () => {
  const identity = buildConversationTransportIdentityRecord({
    provider: "telegram",
    username: "averybrooks11",
    displayName: null,
    givenName: null,
    familyName: null,
    observedAt: "2026-03-20T21:00:00.000Z"
  });

  assert.equal(selectConversationTransportIdentityNameHint(identity), null);
});
