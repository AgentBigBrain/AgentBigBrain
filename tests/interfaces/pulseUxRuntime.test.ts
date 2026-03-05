/**
 * @fileoverview Tests deterministic Stage 6.86 pulse UX envelope rendering in live interface delivery paths.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmptyConversationStackV1 } from "../../src/core/stage6_86ConversationStack";
import { ConversationSession } from "../../src/interfaces/sessionStore";
import { renderPulseUserFacingSummaryV1 } from "../../src/interfaces/pulseUxRuntime";

/**
 * Implements `buildSession` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildSession(): ConversationSession {
  const nowIso = "2026-03-03T15:00:00.000Z";
  const stack = createEmptyConversationStackV1(nowIso);
  return {
    conversationId: "telegram:chat-1:user-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
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
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null,
      lastContextualLexicalEvidence: null,
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

  assert.match(rendered, /^Continuity pulse:/);
  assert.match(rendered, /- reasonCode: OPEN_LOOP_RESUME/);
  assert.match(rendered, /Thread context: active=Budget runway; paused=1; open_loops=1/);
  assert.match(rendered, /Quick check-in:/);
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

  assert.match(rendered, /reasonCode: STALE_FACT_REVALIDATION/);
  assert.match(rendered, /Thread context: active=Budget runway; paused=1; open_loops=1/);
}

test(
  "pulse ux runtime renders stage 6.86 reason code and thread strip in live delivery output",
  rendersStage686PulseEnvelopeWhenReasonCodeIsPresent
);
test(
  "pulse ux runtime stays silent when no stage 6.86 reason code is present",
  returnsBaseSummaryWhenNoStage686ReasonCodeExists
);
test(
  "pulse ux runtime supports lower-case stage 6.86 reason-code prompts",
  supportsLegacyLowerCaseStage686ReasonCodes
);
