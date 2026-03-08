/**
 * @fileoverview Covers canonical contextual follow-up helper behavior for Agent Pulse.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyContextualFollowupLexicalCue } from "../../src/interfaces/contextualFollowupLexicalClassifier";
import {
  buildSuppressedEvaluation,
  evaluateContextualFollowupCandidate,
  toContextualLexicalEvidence
} from "../../src/interfaces/conversationRuntime/pulseContextualFollowup";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

/**
 * Builds a minimal conversation session for contextual follow-up tests.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const nowIso = new Date().toISOString();
  return {
    conversationId,
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
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
      lastEvaluatedAt: null
    },
    ...overrides
  };
}

test("evaluateContextualFollowupCandidate returns an eligible bounded side-thread candidate", () => {
  const nowMs = Date.now();
  const session = buildSession("telegram:chat-1:user-1", {
    conversationTurns: [
      {
        role: "user",
        text: "remind me later about alpha beta gamma issue",
        at: new Date(nowMs - 5 * 60 * 1000).toISOString()
      },
      {
        role: "assistant",
        text: "I can check back on that.",
        at: new Date(nowMs - 4 * 60 * 1000).toISOString()
      },
      {
        role: "user",
        text: "thanks, let us switch topics for now.",
        at: new Date(nowMs - 3 * 60 * 1000).toISOString()
      }
    ]
  });

  const candidate = evaluateContextualFollowupCandidate(session, new Date(nowMs).toISOString());
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.topicKey, "alpha_beta_gamma");
  assert.equal(candidate.sideThreadLinkage, true);
  assert.ok(candidate.linkageConfidence >= 0.7);
});

test("evaluateContextualFollowupCandidate enforces contextual topic cooldown from recent jobs", () => {
  const nowMs = Date.now();
  const recentCompletedAt = new Date(nowMs - 3 * 60 * 1000).toISOString();
  const session = buildSession("telegram:chat-1:user-1", {
    conversationTurns: [
      {
        role: "user",
        text: "remind me later about alpha beta gamma issue",
        at: new Date(nowMs - 6 * 60 * 1000).toISOString()
      },
      {
        role: "assistant",
        text: "Sounds good.",
        at: new Date(nowMs - 5 * 60 * 1000).toISOString()
      },
      {
        role: "user",
        text: "we can discuss something else now",
        at: new Date(nowMs - 4 * 60 * 1000).toISOString()
      }
    ],
    recentJobs: [
      {
        id: "job_prev_contextual",
        input: [
          "Agent Pulse proactive check-in request.",
          "Reason code: contextual_followup",
          "Contextual topic key: alpha_beta_gamma"
        ].join("\n"),
        createdAt: new Date(nowMs - 5 * 60 * 1000).toISOString(),
        startedAt: new Date(nowMs - 4 * 60 * 1000).toISOString(),
        completedAt: recentCompletedAt,
        status: "completed",
        resultSummary: "done",
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: null,
        ackLifecycleState: "FINAL_SENT_NO_EDIT",
        ackMessageId: null,
        ackSentAt: null,
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "sent",
        finalDeliveryAttemptCount: 1,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: recentCompletedAt
      }
    ]
  });

  const candidate = evaluateContextualFollowupCandidate(session, new Date(nowMs).toISOString());
  assert.equal(candidate.eligible, false);
  assert.equal(candidate.suppressionCode, "CONTEXTUAL_TOPIC_COOLDOWN");
  assert.equal(candidate.topicKey, "alpha_beta_gamma");
  assert.notEqual(candidate.nextEligibleAtIso, null);
});

test("buildSuppressedEvaluation and toContextualLexicalEvidence preserve deterministic metadata", () => {
  const evaluation = buildSuppressedEvaluation({
    allowed: false,
    decisionCode: "NO_CONTEXTUAL_LINKAGE",
    suppressedBy: ["reason.requires_contextual_linkage"],
    nextEligibleAtIso: null
  });
  assert.equal(evaluation.decision.allowed, false);
  assert.equal(evaluation.unresolvedCommitmentCount, 0);

  const classification = classifyContextualFollowupLexicalCue(
    "remind me later about alpha beta gamma issue"
  );
  const evidence = toContextualLexicalEvidence(classification, "2026-03-07T15:00:00.000Z");
  assert.equal(evidence.matchedRuleId, classification.matchedRuleId);
  assert.equal(evidence.evaluatedAt, "2026-03-07T15:00:00.000Z");
  assert.equal(evidence.candidateTokens.includes("alpha"), true);
});
