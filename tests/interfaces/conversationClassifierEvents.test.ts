/**
 * @fileoverview Tests deterministic classifier-event persistence gates and bounded retention behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  recordClassifierEvent,
  recordPulseLexicalClassifierEvent,
  shouldPersistClassifierEvent,
  shouldPersistPulseLexicalClassifierEvent
} from "../../src/interfaces/conversationClassifierEvents";
import {
  type FollowUpClassification,
  type ProposalReplyClassification
} from "../../src/interfaces/followUpClassifier";
import { type PulseLexicalClassification } from "../../src/organs/pulseLexicalClassifier";
import { type ConversationSession } from "../../src/interfaces/sessionStore";

/**
 * Creates a deterministic baseline session for classifier-event persistence tests.
 *
 * **Why it exists:**
 * Event tests need a fully-typed session record while keeping setup small and repeatable.
 *
 * **What it talks to:**
 * - Calls `buildSessionSeed` to mirror runtime session defaults.
 *
 * @returns Fresh session snapshot with empty classifier history.
 */
function buildSession(): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-03-03T00:00:00.000Z"
  });
}

/**
 * Builds a deterministic follow-up classification payload for event tests.
 *
 * **Why it exists:**
 * Keeps follow-up event assertions focused on persistence behavior rather than payload scaffolding.
 *
 * **What it talks to:**
 * - Returns in-memory classifier payload for `recordClassifierEvent`.
 *
 * @param overrides - Optional per-test field overrides.
 * @returns Follow-up classification payload.
 */
function buildFollowUpClassification(
  overrides: Partial<FollowUpClassification> = {}
): FollowUpClassification {
  return {
    isShortFollowUp: true,
    category: "ACK",
    confidenceTier: "MED",
    matchedRuleId: "follow_up_rule",
    rulepackVersion: "FollowUpRulepackV1",
    ...overrides
  };
}

/**
 * Builds a deterministic proposal-reply classification payload for event tests.
 *
 * **Why it exists:**
 * Proposal events carry an intent field and should always be persisted; this helper makes those
 * test cases concise.
 *
 * **What it talks to:**
 * - Returns in-memory classifier payload for `recordClassifierEvent`.
 *
 * @param overrides - Optional per-test field overrides.
 * @returns Proposal-reply classification payload.
 */
function buildProposalReplyClassification(
  overrides: Partial<ProposalReplyClassification> = {}
): ProposalReplyClassification {
  return {
    ...buildFollowUpClassification(),
    intent: "QUESTION",
    adjustmentText: null,
    ...overrides
  };
}

/**
 * Builds a deterministic pulse lexical classification payload for event tests.
 *
 * **Why it exists:**
 * Pulse lexical event tests need stable command/non-command examples with explicit conflict flags.
 *
 * **What it talks to:**
 * - Returns in-memory classifier payload for `recordPulseLexicalClassifierEvent`.
 *
 * @param overrides - Optional per-test field overrides.
 * @returns Pulse lexical classification payload.
 */
function buildPulseClassification(
  overrides: Partial<PulseLexicalClassification> = {}
): PulseLexicalClassification {
  return {
    category: "COMMAND",
    commandIntent: "status",
    confidenceTier: "HIGH",
    matchedRuleId: "pulse_rule",
    rulepackVersion: "PulseLexicalRulepackV1",
    conflict: false,
    ...overrides
  };
}

test("shouldPersistClassifierEvent stores proposal intent events even when not short follow-ups", () => {
  const classification = buildProposalReplyClassification({ isShortFollowUp: false });
  assert.equal(shouldPersistClassifierEvent(classification), true);
});

test("shouldPersistClassifierEvent skips non-short plain follow-up events", () => {
  const classification = buildFollowUpClassification({ isShortFollowUp: false });
  assert.equal(shouldPersistClassifierEvent(classification), false);
});

test("recordClassifierEvent appends normalized follow-up events and enforces retention cap", () => {
  const session = buildSession();
  const classification = buildFollowUpClassification();

  recordClassifierEvent(session, "   First   ", "2026-03-03T00:00:01.000Z", classification, 2);
  recordClassifierEvent(session, "Second", "2026-03-03T00:00:02.000Z", classification, 2);
  recordClassifierEvent(session, "Third", "2026-03-03T00:00:03.000Z", classification, 2);

  assert.equal(session.classifierEvents?.length, 2);
  assert.deepEqual(session.classifierEvents?.map((event) => event.input), ["Second", "Third"]);
  assert.equal(session.classifierEvents?.[0]?.classifier, "follow_up");
});

test("recordClassifierEvent skips non-persisted follow-up classifications", () => {
  const session = buildSession();
  const classification = buildFollowUpClassification({ isShortFollowUp: false });

  recordClassifierEvent(session, "ignored", "2026-03-03T00:00:01.000Z", classification);

  assert.equal(session.classifierEvents?.length ?? 0, 0);
});

test("shouldPersistPulseLexicalClassifierEvent keeps command and conflict events", () => {
  assert.equal(
    shouldPersistPulseLexicalClassifierEvent(buildPulseClassification({ category: "COMMAND" })),
    true
  );
  assert.equal(
    shouldPersistPulseLexicalClassifierEvent(
      buildPulseClassification({
        category: "NON_COMMAND",
        conflict: true
      })
    ),
    true
  );
  assert.equal(
    shouldPersistPulseLexicalClassifierEvent(
      buildPulseClassification({
        category: "NON_COMMAND",
        conflict: false
      })
    ),
    false
  );
});

test("recordPulseLexicalClassifierEvent appends pulse classifier metadata with bounded retention", () => {
  const session = buildSession();
  const classification = buildPulseClassification({
    commandIntent: "off",
    conflict: true
  });

  recordPulseLexicalClassifierEvent(session, "  pulse off  ", "2026-03-03T00:00:01.000Z", classification, 1);
  recordPulseLexicalClassifierEvent(session, "pulse off now", "2026-03-03T00:00:02.000Z", classification, 1);

  assert.equal(session.classifierEvents?.length, 1);
  assert.equal(session.classifierEvents?.[0]?.classifier, "pulse_lexical");
  assert.equal(session.classifierEvents?.[0]?.intent, "off");
  assert.equal(session.classifierEvents?.[0]?.conflict, true);
  assert.equal(session.classifierEvents?.[0]?.input, "pulse off now");
});

test("recordPulseLexicalClassifierEvent skips non-command non-conflict output", () => {
  const session = buildSession();
  const classification = buildPulseClassification({
    category: "NON_COMMAND",
    conflict: false,
    commandIntent: null
  });

  recordPulseLexicalClassifierEvent(session, "hello", "2026-03-03T00:00:01.000Z", classification);

  assert.equal(session.classifierEvents?.length ?? 0, 0);
});
