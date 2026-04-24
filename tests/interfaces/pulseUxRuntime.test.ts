/**
 * @fileoverview Tests final user-facing pulse text rendering in live interface delivery paths.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmptyConversationStackV1 } from "../../src/core/stage6_86ConversationStack";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { ConversationSession } from "../../src/interfaces/sessionStore";
import {
  renderPulseUserFacingSummaryV1,
  shouldSuppressPulseUserFacingDeliveryV1
} from "../../src/interfaces/pulseUxRuntime";

/**
 * Implements `buildSession` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildSession(): ConversationSession {
  const nowIso = "2026-03-03T15:00:00.000Z";
  const stack = createEmptyConversationStackV1(nowIso);
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: nowIso
    }),
    sessionSchemaVersion: "v2",
    conversationStack: {
      ...stack,
      activeThreadKey: "thread_budget",
      threads: [
        {
          threadKey: "thread_budget",
          topicKey: "topic_budget",
          topicLabel: "Budget runway",
          state: "active",
          resumeHint: "Resume runway checklist",
          openLoops: [
            {
              loopId: "loop_budget_1",
              threadKey: "thread_budget",
              entityRefs: ["entity_budget_runway"],
              createdAt: nowIso,
              lastMentionedAt: nowIso,
              priority: 0.74,
              status: "open"
            }
          ],
          lastTouchedAt: nowIso
        },
        {
          threadKey: "thread_research",
          topicKey: "topic_research",
          topicLabel: "Research backlog",
          state: "paused",
          resumeHint: "Resume findings summary",
          openLoops: [],
          lastTouchedAt: nowIso
        }
      ]
    },
    updatedAt: nowIso,
    agentPulse: {
      ...buildSessionSeed({
        provider: "telegram",
        conversationId: "chat-1",
        userId: "user-1",
        username: "agentowner",
        conversationVisibility: "private",
        receivedAt: nowIso
      }).agentPulse,
      optIn: true,
      recentEmissions: []
    }
  };
}

/**
 * Implements `rendersStage686PulseEnvelopeWhenReasonCodeIsPresent` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function rendersStage686PulseEnvelopeWhenReasonCodeIsPresent(): void {
  const rendered = renderPulseUserFacingSummaryV1(
    buildSession(),
    [
      "You are a personal AI assistant.",
      "Signal type: OPEN_LOOP_RESUME",
      "Intent: Something was left unfinished in conversation."
    ].join("\n"),
    "Quick check-in: want to continue the budget runway thread from yesterday?",
    "2026-03-03T15:00:10.000Z"
  );

  assert.equal(rendered, "Quick check-in: want to continue the budget runway thread from yesterday?");
  assert.doesNotMatch(rendered, /Continuity pulse:/);
  assert.doesNotMatch(rendered, /reasonCode:/);
  assert.doesNotMatch(rendered, /Thread context:/);
}

/**
 * Implements `returnsBaseSummaryWhenNoStage686ReasonCodeExists` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function returnsBaseSummaryWhenNoStage686ReasonCodeExists(): void {
  const baseSummary = "Hello from normal system execution.";
  const rendered = renderPulseUserFacingSummaryV1(
    buildSession(),
    "Agent Pulse proactive check-in request.\nReason code: unresolved_commitment",
    baseSummary,
    "2026-03-03T15:00:10.000Z"
  );
  assert.equal(rendered, baseSummary);
}

/**
 * Implements `supportsLegacyLowerCaseStage686ReasonCodes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function supportsLegacyLowerCaseStage686ReasonCodes(): void {
  const rendered = renderPulseUserFacingSummaryV1(
    buildSession(),
    "Agent Pulse proactive check-in request.\nReason code: stale_fact_revalidation",
    "Could you confirm whether your current deployment timeline changed?",
    "2026-03-03T15:00:10.000Z"
  );

  assert.equal(rendered, "Could you confirm whether your current deployment timeline changed?");
}

/**
 * Implements `suppressesBlockedStage686PulseSummaries` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function suppressesBlockedStage686PulseSummaries(): void {
  const shouldSuppress = shouldSuppressPulseUserFacingDeliveryV1(
    "Agent Pulse proactive check-in request.\nReason code: TOPIC_DRIFT_RESUME",
    [
      "I couldn't execute that request in this run.",
      "What happened: governance blocked the requested action.",
      "Why it didn't execute: Security governor rejected this request."
    ].join(" ")
  );

  assert.equal(shouldSuppress, true);
}

/**
 * Implements `keepsNaturalStage686PulseSummariesVisible` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function keepsNaturalStage686PulseSummariesVisible(): void {
  const shouldSuppress = shouldSuppressPulseUserFacingDeliveryV1(
    "Agent Pulse proactive check-in request.\nReason code: stale_fact_revalidation",
    "Quick check-in: are you still working with Billy at Sample Web Studio?"
  );

  assert.equal(shouldSuppress, false);
}

test(
  "pulse ux runtime strips stage 6.86 envelope metadata from live delivery output",
  rendersStage686PulseEnvelopeWhenReasonCodeIsPresent
);
test(
  "pulse ux runtime stays silent when no stage 6.86 reason code is present",
  returnsBaseSummaryWhenNoStage686ReasonCodeExists
);
test(
  "pulse ux runtime supports lower-case stage 6.86 reason-code prompts without leaking envelope metadata",
  supportsLegacyLowerCaseStage686ReasonCodes
);
test(
  "pulse ux runtime suppresses governance-blocked stage 6.86 pulse summaries",
  suppressesBlockedStage686PulseSummaries
);
test(
  "pulse ux runtime keeps natural stage 6.86 pulse summaries visible",
  keepsNaturalStage686PulseSummariesVisible
);
