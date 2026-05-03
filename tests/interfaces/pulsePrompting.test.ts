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
import {
  buildConversationSessionFixture,
  buildPulseScoreBreakdownFixture
} from "../helpers/conversationFixtures";

/**
 * Builds a minimal conversation session for prompt tests.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const nowIso = new Date().toISOString();
  return buildConversationSessionFixture(
    {
      conversationId,
      updatedAt: nowIso,
      agentPulse: {
        ...buildConversationSessionFixture().agentPulse,
        optIn: true
      },
      ...overrides
    },
    {
      conversationId: conversationId.split(":")[1] ?? conversationId,
      receivedAt: nowIso
    }
  );
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
    relevantEpisodes: [],
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
      confidenceTier: "HIGH",
      confidence: 0.92,
      conflict: false,
      candidateTokens: ["alpha", "beta", "gamma"]
    }
  };

  const prompt = buildPulsePrompt(
    buildSession("telegram:chat-1:user-1"),
    "contextual_followup",
    buildPulseEvaluation({
      relevantEpisodes: [
        {
          episodeId: "episode_owen_fall",
          title: "Owen fell down",
          summary: "Owen fell down and the outcome is unresolved.",
          status: "unresolved",
          lastMentionedAt: "2026-03-07T12:00:00.000Z",
          ageDays: 1
        }
      ],
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
  assert.ok(prompt.includes("Relevant unresolved situations: Owen fell down (unresolved; 1d old)"));
  assert.ok(prompt.includes("Topic linkage confidence: 0.90"));
  assert.ok(prompt.includes("Side-thread linkage: present"));
  assert.ok(prompt.includes("Ask one concise revalidation question before making assumptions."));
});

test("buildDynamicPulsePrompt includes naturalness context sections when provided", () => {
  const candidate: PulseCandidateV1 = {
    candidateId: "pulse-1",
    reasonCode: "OPEN_LOOP_RESUME",
    score: 0.64,
    scoreBreakdown: buildPulseScoreBreakdownFixture({
      recency: 0.75,
      frequency: 0.5,
      unresolvedImportance: 0.67
    }),
    lastTouchedAt: "2026-03-07T14:00:00.000Z",
    threadKey: "thread-1",
    entityRefs: ["entity-1"],
    evidenceRefs: ["evidence-1"],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false,
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
        formatted: "Saturday, March 7, 2026 at 10:00 AM EST",
        dayOfWeek: "Saturday",
        hour: 10
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
  assert.ok(prompt.includes("Only send this if you can give one concrete reason"));
  assert.ok(prompt.includes("Do not write generic filler like 'AI assistant check-in'"));
  assert.ok(prompt.includes("Do not volunteer that you are an AI assistant in ordinary greetings or casual replies."));
  assert.ok(prompt.includes("Never open with canned self-introductions like 'AI assistant here' or 'I'm your AI assistant'."));
});

test("buildDynamicPulsePrompt hardens relationship clarification against generic check-in wording", () => {
  const candidate: PulseCandidateV1 = {
    candidateId: "pulse-relationship",
    reasonCode: "RELATIONSHIP_CLARIFICATION",
    score: 0.67,
    scoreBreakdown: buildPulseScoreBreakdownFixture({
      recency: 0.7,
      frequency: 0.61,
      unresolvedImportance: 0.71
    }),
    lastTouchedAt: "2026-03-07T14:00:00.000Z",
    threadKey: null,
    entityRefs: ["entity-1", "entity-2"],
    evidenceRefs: ["evidence-1"],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false,
    stableHash: "stable-hash-relationship"
  };

  const prompt = buildDynamicPulsePrompt(
    candidate,
    buildSession("telegram:chat-1:user-1"),
    "private"
  );

  assert.ok(prompt.includes("Only ask about the connection if a specific recent topic clearly grounds it."));
  assert.match(prompt, /rather than sending a generic check-in/i);
  assert.match(prompt, /do not prepend labels like 'AI assistant response'/i);
  assert.match(prompt, /do not volunteer that you are an ai assistant in ordinary greetings or casual replies/i);
  assert.match(prompt, /never open with canned self-introductions like 'ai assistant here' or 'i'm your ai assistant'/i);
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
        domainHint: null,
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
