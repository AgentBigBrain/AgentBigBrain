/**
 * @fileoverview Focused tests for bounded session-domain lane routing helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmptyConversationDomainContext } from "../../src/core/sessionContext";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { buildConversationDomainSignalWindowForTurn } from "../../src/interfaces/conversationRuntime/sessionDomainRouting";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

/**
 * Creates a stable session fixture for session-domain routing tests.
 *
 * @returns Fresh seeded conversation session.
 */
function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  const conversationId = "telegram:chat-domain-routing:user-1";
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId,
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-03T00:00:00.000Z"
    }),
    domainContext: createEmptyConversationDomainContext(conversationId),
    ...overrides
  };
}

test("buildConversationDomainSignalWindowForTurn keeps broader governed relationship wording on the relationship lane", () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-03T00:00:25.000Z",
      lastUserInput: "Build the release notes app."
    }
  });

  const update = buildConversationDomainSignalWindowForTurn(
    session,
    "My team lead is Jordan.",
    "2026-03-03T00:00:30.000Z",
    null,
    null
  );

  assert.equal(
    update.laneSignals?.some((signal) => signal.lane === "relationship"),
    true
  );
});
