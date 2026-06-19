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
  evaluateProactiveInquiryDeliveryPolicy,
  selectPulseTargetSession
} from "../../src/interfaces/proactiveRuntime/deliveryPolicy";
import { buildProactiveInquiryCandidateFromPulseCandidate } from "../../src/core/stage6_86/proactiveInquiryCandidates";
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
        entityKey: "entity_riley",
        canonicalName: "Riley",
        entityType: "person",
        disambiguator: null,
        domainHint: null,
        aliases: ["Riley"],
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
    candidateId: "candidate_riley",
    reasonCode: "RELATIONSHIP_CLARIFICATION",
    entityRefs: ["entity_riley"],
    evidenceRefs: [],
    threadKey: null,
    score: 0.4,
    scoreBreakdown: buildPulseScoreBreakdownFixture(),
    lastTouchedAt: "2026-03-08T11:00:00.000Z",
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false,
    stableHash: "candidate_riley_hash"
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
    recentConversationText: "Riley came up again and I wondered how Riley was doing after the fall",
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

test("evaluateProactiveInquiryDeliveryPolicy allows useful non-authoritative candidates", () => {
  const candidate = buildProactiveInquiryCandidateFromPulseCandidate(buildPulseCandidate(), {
    sourceRecallStatus: "not_used"
  });
  const decision = evaluateProactiveInquiryDeliveryPolicy({
    candidate,
    targetMode: "private"
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.suppressedBy, []);
});

test("evaluateProactiveInquiryDeliveryPolicy blocks public private evidence and unusable Source Recall", () => {
  const privateCandidate = {
    ...buildProactiveInquiryCandidateFromPulseCandidate(buildPulseCandidate(), {
      sourceRecallStatus: "available",
      blockReasons: ["public_unsafe"]
    }),
    risk: {
      interruptionRisk: "low" as const,
      privacyRisk: "private_only" as const,
      publicSafe: false,
      activeMissionSafe: true
    }
  };
  const decision = evaluateProactiveInquiryDeliveryPolicy({
    candidate: privateCandidate,
    targetMode: "public"
  });

  assert.equal(decision.allowed, false);
  assert.ok(decision.suppressedBy.includes("public_route_private_evidence"));
  assert.ok(decision.suppressedBy.includes("source_recall_unusable"));
});

test("evaluateProactiveInquiryDeliveryPolicy blocks low value, low novelty, and repeated negative outcomes", () => {
  const base = buildProactiveInquiryCandidateFromPulseCandidate(buildPulseCandidate(), {
    sourceRecallStatus: "not_used"
  });
  const lowValueCandidate = {
    ...base,
    expectedUserValue: 0.1,
    novelty: 0.1
  };
  const lowValueDecision = evaluateProactiveInquiryDeliveryPolicy({
    candidate: lowValueCandidate,
    targetMode: "private",
    recentPulseHistory: [
      {
        emittedAt: "2026-03-08T09:00:00.000Z",
        reasonCode: "RELATIONSHIP_CLARIFICATION",
        candidateEntityRefs: ["entity_riley"],
        candidateId: base.sourcePulseCandidateId ?? undefined,
        proactiveInquiryCandidate: base,
        responseOutcome: "ignored"
      },
      {
        emittedAt: "2026-03-08T10:00:00.000Z",
        reasonCode: "RELATIONSHIP_CLARIFICATION",
        candidateEntityRefs: ["entity_riley"],
        candidateId: base.sourcePulseCandidateId ?? undefined,
        proactiveInquiryCandidate: base,
        responseOutcome: "dismissed"
      }
    ]
  });

  assert.equal(lowValueDecision.allowed, false);
  assert.ok(lowValueDecision.suppressedBy.includes("low_expected_user_value"));
  assert.ok(lowValueDecision.suppressedBy.includes("low_novelty"));
  assert.ok(lowValueDecision.suppressedBy.includes("repeated_negative_outcome"));
});
