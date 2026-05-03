/**
 * @fileoverview Tests deterministic Stage 6.86 UX rendering behavior for pulse summaries, thread context strips, and suppression silence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildThreadContextStripV1,
  renderPulseSummaryV1,
  shouldRenderPulseDecisionV1
} from "../../src/interfaces/stage6_86UxRendering";
import { ConversationStackV1, PulseCandidateV1, PulseDecisionV1 } from "../../src/core/types";

/**
 * Implements `buildConversationStackFixture` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildConversationStackFixture(): ConversationStackV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-01T00:00:00.000Z",
    activeThreadKey: "thread_budget",
    threads: [
      {
        threadKey: "thread_budget",
        topicKey: "topic_budget",
        topicLabel: "Budget runway",
        state: "active",
        resumeHint: "Resume budget assumptions",
        openLoops: [
          {
            loopId: "loop_budget_1",
            threadKey: "thread_budget",
            entityRefs: ["entity_lantern_labs"],
            createdAt: "2026-03-01T00:00:00.000Z",
            lastMentionedAt: "2026-03-01T00:00:00.000Z",
            priority: 0.62,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-03-01T00:00:00.000Z"
      },
      {
        threadKey: "thread_research",
        topicKey: "topic_research",
        topicLabel: "Sandboxing research",
        state: "paused",
        resumeHint: "Return to deterministic controls",
        openLoops: [],
        lastTouchedAt: "2026-02-28T00:00:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "topic_budget",
        label: "Budget runway",
        firstSeenAt: "2026-03-01T00:00:00.000Z",
        lastSeenAt: "2026-03-01T00:00:00.000Z",
        mentionCount: 3
      },
      {
        topicKey: "topic_research",
        label: "Sandboxing research",
        firstSeenAt: "2026-02-28T00:00:00.000Z",
        lastSeenAt: "2026-02-28T00:00:00.000Z",
        mentionCount: 1
      }
    ]
  };
}

/**
 * Implements `buildPulseCandidateFixture` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildPulseCandidateFixture(): PulseCandidateV1 {
  return {
    candidateId: "pulse_candidate_ux",
    reasonCode: "OPEN_LOOP_RESUME",
    score: 0.79,
    scoreBreakdown: {
      recency: 0.81,
      frequency: 0.72,
      unresolvedImportance: 0.78,
      sensitivityPenalty: 0,
      cooldownPenalty: 0
    },
    lastTouchedAt: "2026-03-01T00:00:00.000Z",
    threadKey: "thread_budget",
    entityRefs: ["entity_lantern_labs"],
    evidenceRefs: ["trace:pulse_candidate_ux"],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false,
    stableHash: "hash_pulse_candidate_ux"
  };
}

/**
 * Implements `rendersPulseSummaryWithReasonCodeAndBoundedPreview` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function rendersPulseSummaryWithReasonCodeAndBoundedPreview(): void {
  const summary = renderPulseSummaryV1({
    candidate: buildPulseCandidateFixture(),
    updatePreview:
      "This is a deliberately long update preview that should be truncated so user-facing continuity summaries stay bounded and readable under Stage 6.86 UX coherence constraints.",
    maxPreviewChars: 80
  });

  assert.match(summary, /^Continuity pulse:/);
  assert.match(summary, /reasonCode: OPEN_LOOP_RESUME/);
  const previewLine = summary.split("\n").find((line) => line.startsWith("- preview: "));
  assert.ok(previewLine);
  assert.ok(previewLine!.length <= 92);
  assert.ok(previewLine!.endsWith("..."));
}

/**
 * Implements `buildsThreadContextStripWithActivePausedAndOpenLoopCounts` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildsThreadContextStripWithActivePausedAndOpenLoopCounts(): void {
  const strip = buildThreadContextStripV1(buildConversationStackFixture());

  assert.equal(strip.activeThreadKey, "thread_budget");
  assert.equal(strip.activeThreadLabel, "Budget runway");
  assert.equal(strip.pausedThreadCount, 1);
  assert.equal(strip.openLoopCount, 1);
  assert.equal(
    strip.summaryText,
    "Thread context: active=Budget runway; paused=1; open_loops=1"
  );
}

/**
 * Implements `keepsSuppressedPulseDecisionsSilent` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function keepsSuppressedPulseDecisionsSilent(): void {
  const suppressedDecision: PulseDecisionV1 = {
    decisionCode: "SUPPRESS",
    candidateId: "pulse_candidate_ux",
    blockCode: "PULSE_BLOCKED",
    blockDetailReason: "PULSE_COOLDOWN_ACTIVE",
    evidenceRefs: ["trace:pulse_suppressed"],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false
  };
  const emittedDecision: PulseDecisionV1 = {
    decisionCode: "EMIT",
    candidateId: "pulse_candidate_ux",
    blockCode: null,
    blockDetailReason: null,
    evidenceRefs: ["trace:pulse_emit"],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false
  };

  assert.equal(shouldRenderPulseDecisionV1(suppressedDecision), false);
  assert.equal(shouldRenderPulseDecisionV1(emittedDecision), true);
}

test(
  "stage 6.86 ux rendering includes reason codes and bounded preview text for pulse summaries",
  rendersPulseSummaryWithReasonCodeAndBoundedPreview
);
test(
  "stage 6.86 ux rendering builds deterministic thread context strip fields",
  buildsThreadContextStripWithActivePausedAndOpenLoopCounts
);
test(
  "stage 6.86 ux rendering keeps suppressed pulse decisions silent by default",
  keepsSuppressedPulseDecisionsSilent
);
