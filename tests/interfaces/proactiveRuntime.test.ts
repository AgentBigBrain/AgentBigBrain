/**
 * @fileoverview Covers bounded proactive-runtime helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextualTopicCooldownHistory,
  resolveContextualTopicCooldown,
  shouldSuppressForPulseGap
} from "../../src/interfaces/proactiveRuntime/cooldownPolicy";
import {
  conversationBelongsToProvider,
  selectPulseTargetSession
} from "../../src/interfaces/proactiveRuntime/deliveryPolicy";
import { shouldSuppressRelationshipClarificationPulse } from "../../src/interfaces/proactiveRuntime/followupQualification";
import { calculateRelationshipClarificationUtilityScore } from "../../src/interfaces/proactiveRuntime/userValueScoring";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import type { EntityGraphV1, PulseCandidateV1 } from "../../src/core/types";
import {
  buildConversationJobFixture,
  buildConversationSessionFixture,
  buildPulseScoreBreakdownFixture
} from "../helpers/conversationFixtures";

function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  return buildConversationSessionFixture(
    {
      updatedAt: "2026-03-08T12:00:00.000Z",
      agentPulse: {
        ...buildConversationSessionFixture().agentPulse,
        optIn: true
      },
      ...overrides
    },
    {
      conversationId,
      receivedAt: "2026-03-08T12:00:00.000Z"
    }
  );
}

function buildEntityGraph(): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-08T12:00:00.000Z",
    entities: [
      {
        entityKey: "entity_owen",
        canonicalName: "Owen",
        entityType: "person",
        disambiguator: null,
        domainHint: null,
        aliases: ["Owen"],
        firstSeenAt: "2026-02-10T12:00:00.000Z",
        lastSeenAt: "2026-03-08T11:00:00.000Z",
        salience: 1,
        evidenceRefs: ["conv:thread-1"]
      }
    ],
    edges: []
  };
}

function buildPulseCandidate(): PulseCandidateV1 {
  return {
    candidateId: "candidate_owen",
    reasonCode: "RELATIONSHIP_CLARIFICATION",
    entityRefs: ["entity_owen"],
    evidenceRefs: [],
    threadKey: null,
    score: 0.4,
    scoreBreakdown: buildPulseScoreBreakdownFixture(),
    lastTouchedAt: "2026-03-08T11:00:00.000Z",
    stableHash: "candidate_owen_hash"
  };
}

test("relationship-clarification utility favors anchored unresolved value", () => {
  assert.equal(
    calculateRelationshipClarificationUtilityScore({
      anchoredEntityCount: 2,
      openLoopCount: 1,
      repeatedNegativeOutcomes: 0
    }),
    0.75
  );
});

test("relationship-clarification qualification suppresses low-value generic nudges", () => {
  const suppressed = shouldSuppressRelationshipClarificationPulse({
    candidate: buildPulseCandidate(),
    graph: buildEntityGraph(),
    recentConversationText: "we were chatting about lunch and nothing specific came up",
    openLoopCount: 0,
    repeatedNegativeOutcomes: 2
  });
  const allowed = shouldSuppressRelationshipClarificationPulse({
    candidate: buildPulseCandidate(),
    graph: buildEntityGraph(),
    recentConversationText: "Owen came up again and I wondered how Owen was doing after the fall",
    openLoopCount: 1,
    repeatedNegativeOutcomes: 0
  });

  assert.equal(suppressed, true);
  assert.equal(allowed, false);
});

test("cooldown and delivery policy helpers stay human-scale and provider-bounded", () => {
  assert.equal(
    shouldSuppressForPulseGap("2026-03-08T10:00:00.000Z", Date.parse("2026-03-08T12:00:00.000Z")),
    true
  );
  assert.equal(
    shouldSuppressForPulseGap("2026-03-07T20:00:00.000Z", Date.parse("2026-03-08T12:00:00.000Z")),
    false
  );
  assert.equal(conversationBelongsToProvider("telegram:chat-1:user-1", "telegram"), true);
  assert.equal(conversationBelongsToProvider("discord:chat-1:user-1", "telegram"), false);

  const session = buildSession("telegram:chat-1:user-1", {
    queuedJobs: [
      buildConversationJobFixture({
        id: "job-1",
        input: "Reason code: contextual_followup\nContextual topic key (derived): alpha_beta_gamma",
        createdAt: "2026-03-08T09:00:00.000Z",
        startedAt: null,
        completedAt: "2026-03-08T09:10:00.000Z",
        status: "completed",
        ackLifecycleState: "NOT_SENT",
        finalDeliveryOutcome: "not_attempted"
      })
    ]
  });
  const nextEligibleAt = resolveContextualTopicCooldown(
    buildContextualTopicCooldownHistory(session),
    "alpha_beta_gamma",
    Date.parse("2026-03-08T12:00:00.000Z")
  );
  assert.equal(nextEligibleAt, "2026-03-08T15:10:00.000Z");

  const selected = selectPulseTargetSession(buildSession("telegram:public:user-1", {
    conversationVisibility: "public",
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null
    }
  }), [
    buildSession("telegram:private-old:user-1", { updatedAt: "2026-03-08T09:00:00.000Z" }),
    buildSession("telegram:private-new:user-1", { updatedAt: "2026-03-08T11:00:00.000Z" })
  ]);
  assert.equal(selected.targetSession?.conversationId, "telegram:private-new:user-1");
});
