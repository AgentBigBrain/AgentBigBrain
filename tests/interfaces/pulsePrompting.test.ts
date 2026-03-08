/**
 * @fileoverview Covers canonical Agent Pulse prompt builders and relationship-context helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDynamicPulsePrompt, buildPulsePrompt, computeRelationshipAgeDays } from "../../src/interfaces/conversationRuntime/pulsePrompting";
import type { ContextualFollowupCandidate } from "../../src/interfaces/conversationRuntime/pulseContextualFollowup";
import type { AgentPulseEvaluationResult } from "../../src/core/profileMemoryStore";
import type { EntityGraphV1, PulseCandidateV1 } from "../../src/core/types";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

/**
 * Builds a minimal conversation session for prompt tests.
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

/**
 * Builds a deterministic pulse evaluation payload.
 */
function buildPulseEvaluation(
  overrides: Partial<AgentPulseEvaluationResult> = {}
): AgentPulseEvaluationResult {
  return {
    decision: {
      allowed: true,
      decisionCode: "ALLOWED",
      suppressedBy: [],
      nextEligibleAtIso: null
    },
    staleFactCount: 0,
    unresolvedCommitmentCount: 0,
    unresolvedCommitmentTopics: [],
    relationship: {
      role: "unknown",
      roleFactId: null
    },
    contextDrift: {
      detected: false,
      domains: [],
      requiresRevalidation: false
    },
    ...overrides
  };
}

test("buildPulsePrompt includes contextual follow-up and revalidation directives for private mode", () => {
  const contextualCandidate: ContextualFollowupCandidate = {
    eligible: true,
    topicKey: "alpha_beta_gamma",
    topicSummary: "alpha beta gamma",
    topicTokens: ["alpha", "beta", "gamma"],
    linkageConfidence: 0.9,
    sideThreadLinkage: true,
    suppressionCode: null,
    nextEligibleAtIso: null,
    lexicalClassification: {
      cueDetected: true,
      matchedRuleId: "contextual_followup_lexical_v1_cue_with_candidate_tokens",
      rulepackVersion: "v1",
      rulepackFingerprint: "fingerprint",
      confidenceTier: "high",
      confidence: 0.92,
      conflict: false,
      candidateTokens: ["alpha", "beta", "gamma"]
    }
  };

  const prompt = buildPulsePrompt(
    buildSession("telegram:chat-1:user-1"),
    "contextual_followup",
    buildPulseEvaluation({
      relationship: {
        role: "friend",
        roleFactId: "profile_fact_friend"
      },
      contextDrift: {
        detected: true,
        domains: ["team"],
        requiresRevalidation: true
      }
    }),
    "private",
    contextualCandidate
  );

  assert.ok(prompt.includes("Contextual follow-up nudge: enabled."));
  assert.ok(prompt.includes("Topic linkage confidence: 0.90"));
  assert.ok(prompt.includes("Side-thread linkage: present"));
  assert.ok(prompt.includes("Ask one concise revalidation question before making assumptions."));
});

test("buildDynamicPulsePrompt includes naturalness context sections when provided", () => {
  const candidate: PulseCandidateV1 = {
    candidateId: "pulse-1",
    reasonCode: "OPEN_LOOP_RESUME",
    score: 0.64,
    scoreBreakdown: {
      recency: 0.75,
      frequency: 0.5,
      unresolvedImportance: 0.67
    },
    lastTouchedAt: "2026-03-07T14:00:00.000Z",
    threadKey: "thread-1",
    entityRefs: ["entity-1"],
    evidenceRefs: ["evidence-1"],
    stableHash: "stable-hash"
  };

  const prompt = buildDynamicPulsePrompt(
    candidate,
    buildSession("telegram:chat-1:user-1", {
      conversationTurns: [
        {
          role: "user",
          text: "Can you remind me about the toolchain migration later?",
          at: "2026-03-07T13:00:00.000Z"
        }
      ]
    }),
    "private",
    {
      nowIso: "2026-03-07T15:00:00.000Z",
      userLocalTime: {
        timezone: "America/New_York",
        formatted: "Saturday, March 7, 2026 at 10:00 AM EST",
        locale: "en-US",
        offsetMinutes: -300
      },
      conversationalGapMs: 2 * 60 * 60 * 1000,
      relationshipAgeDays: 30,
      previousPulseOutcomes: [
        {
          emittedAt: "2026-03-06T15:00:00.000Z",
          reasonCode: "OPEN_LOOP_RESUME",
          candidateEntityRefs: ["entity-1"],
          responseOutcome: "ignored",
          generatedSnippet: "Checking back on the migration plan."
        }
      ],
      userStyleFingerprint: "brief and task-focused"
    }
  );

  assert.ok(prompt.includes("Time since last user message:"));
  assert.ok(prompt.includes("User's local time:"));
  assert.ok(prompt.includes("working with this user for"));
  assert.ok(prompt.includes("1 ignored"));
  assert.ok(prompt.includes("User communication style: brief and task-focused"));
});

test("computeRelationshipAgeDays prefers entity-graph firstSeenAt over conversation turns", () => {
  const nowIso = "2026-03-07T15:00:00.000Z";
  const graph: EntityGraphV1 = {
    schemaVersion: "v1",
    updatedAt: nowIso,
    entities: [
      {
        entityKey: "entity-agentowner",
        canonicalName: "agentowner",
        entityType: "person",
        disambiguator: null,
        aliases: [],
        firstSeenAt: "2026-02-05T15:00:00.000Z",
        lastSeenAt: nowIso,
        salience: 1,
        evidenceRefs: []
      }
    ],
    edges: []
  };
  const session = buildSession("telegram:chat-1:user-1", {
    conversationTurns: [
      {
        role: "user",
        text: "hello",
        at: "2026-03-06T15:00:00.000Z"
      }
    ]
  });

  const ageDays = computeRelationshipAgeDays(graph, session, Date.parse(nowIso));
  assert.ok(ageDays >= 29);
});
