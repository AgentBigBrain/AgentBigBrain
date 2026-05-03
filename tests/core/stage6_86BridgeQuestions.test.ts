/**
 * @fileoverview Tests deterministic Stage 6.86 bridge-question gating and answer-resolution behavior for checkpoint 6.86.F.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateBridgeQuestionEmissionV1,
  resolveBridgeQuestionAnswerV1
} from "../../src/core/stage6_86BridgeQuestions";
import { EntityGraphV1, PulseCandidateV1 } from "../../src/core/types";

/**
 * Implements `buildBridgeFixtureGraph` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBridgeFixtureGraph(): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-01T00:00:00.000Z",
    entities: [
      {
        entityKey: "entity_lantern_labs",
        canonicalName: "Lantern Labs",
        entityType: "org",
        disambiguator: null,
        domainHint: null,
        aliases: ["Lantern Labs"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-25T00:00:00.000Z",
        salience: 6,
        evidenceRefs: ["trace:entity_lantern_labs"]
      },
      {
        entityKey: "entity_project_aurora",
        canonicalName: "Project Aurora",
        entityType: "concept",
        disambiguator: null,
        domainHint: null,
        aliases: ["Project Aurora"],
        firstSeenAt: "2025-10-01T00:00:00.000Z",
        lastSeenAt: "2026-02-25T00:00:00.000Z",
        salience: 5,
        evidenceRefs: ["trace:entity_project_aurora"]
      }
    ],
    edges: [
      {
        edgeKey: "edge_bridge_primary",
        sourceEntityKey: "entity_project_aurora",
        targetEntityKey: "entity_lantern_labs",
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 7,
        strength: 7,
        firstObservedAt: "2025-10-01T00:00:00.000Z",
        lastObservedAt: "2026-02-25T00:00:00.000Z",
        evidenceRefs: ["trace:edge_bridge_primary"]
      }
    ]
  };
}

/**
 * Implements `buildBridgePulseCandidate` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBridgePulseCandidate(): PulseCandidateV1 {
  return {
    candidateId: "pulse_candidate_bridge_primary",
    reasonCode: "RELATIONSHIP_CLARIFICATION",
    score: 0.86,
    scoreBreakdown: {
      recency: 0.82,
      frequency: 0.78,
      unresolvedImportance: 0.72,
      sensitivityPenalty: 0,
      cooldownPenalty: 0
    },
    lastTouchedAt: "2026-02-25T00:00:00.000Z",
    threadKey: "thread_budget",
    entityRefs: ["entity_lantern_labs", "entity_project_aurora"],
    evidenceRefs: ["trace:candidate_bridge_primary"],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false,
    stableHash: "hash_bridge_primary"
  };
}

/**
 * Implements `emitsNeutralBridgeQuestionWhenEvidenceThresholdAndGuardsPass` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function emitsNeutralBridgeQuestionWhenEvidenceThresholdAndGuardsPass(): void {
  const result = evaluateBridgeQuestionEmissionV1({
    graph: buildBridgeFixtureGraph(),
    candidate: buildBridgePulseCandidate(),
    observedAt: "2026-03-01T12:00:00.000Z"
  });

  assert.equal(result.approved, true);
  assert.equal(result.blockCode, null);
  assert.equal(result.bridgeCandidate?.coMentionCount, 7);
  assert.equal(result.pulseEmitParams?.kind, "bridge_question");
  assert.equal(result.pulseEmitParams?.reasonCode, "RELATIONSHIP_CLARIFICATION");
  assert.ok(result.bridgeQuestion);
  assert.match(result.bridgeQuestion!.prompt, /How would you describe their relationship/i);
  assert.match(result.bridgeQuestion!.prompt, /coworker, friend, family, project_related, other, or not related/i);
  assert.equal(result.bridgeQuestion!.threadKey, "thread_budget");
  assert.equal(result.bridgeCandidate?.sourceAuthority, "stale_runtime_context");
  assert.equal(result.bridgeQuestion?.provenanceTier, "supporting");
  assert.equal(result.pulseEmitParams?.activeMissionSuppressed, false);
}

/**
 * Implements `blocksBridgeQuestionWhenEvidenceThresholdIsNotMet` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksBridgeQuestionWhenEvidenceThresholdIsNotMet(): void {
  const result = evaluateBridgeQuestionEmissionV1(
    {
      graph: buildBridgeFixtureGraph(),
      candidate: buildBridgePulseCandidate(),
      observedAt: "2026-03-01T12:00:00.000Z"
    },
    {
      coMentionThreshold: 8
    }
  );

  assert.equal(result.approved, false);
  assert.equal(result.blockCode, "PULSE_BLOCKED");
  assert.equal(result.blockDetailReason, "BRIDGE_INSUFFICIENT_EVIDENCE");
  assert.equal(result.conflict?.conflictCode, "INSUFFICIENT_EVIDENCE");
}

/**
 * Implements `blocksBridgeQuestionWhenCooldownIsActiveForPair` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksBridgeQuestionWhenCooldownIsActiveForPair(): void {
  const result = evaluateBridgeQuestionEmissionV1({
    graph: buildBridgeFixtureGraph(),
    candidate: buildBridgePulseCandidate(),
    observedAt: "2026-03-01T12:00:00.000Z",
    recentBridgeHistory: [
      {
        questionId: "bridge_q_prior",
        conversationKey: "thread_budget",
        sourceEntityKey: "entity_lantern_labs",
        targetEntityKey: "entity_project_aurora",
        askedAt: "2026-02-26T12:00:00.000Z",
        status: "deferred",
        cooldownUntil: "2026-03-05T12:00:00.000Z",
        deferralCount: 1
      }
    ]
  });

  assert.equal(result.approved, false);
  assert.equal(result.blockDetailReason, "BRIDGE_COOLDOWN_ACTIVE");
  assert.equal(result.conflict?.conflictCode, "COOLDOWN_ACTIVE");
}

/**
 * Implements `blocksBridgeQuestionWhenConversationCapIsReached` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksBridgeQuestionWhenConversationCapIsReached(): void {
  const result = evaluateBridgeQuestionEmissionV1({
    graph: buildBridgeFixtureGraph(),
    candidate: buildBridgePulseCandidate(),
    observedAt: "2026-03-01T12:00:00.000Z",
    recentBridgeHistory: [
      {
        questionId: "bridge_q_prior",
        conversationKey: "thread_budget",
        sourceEntityKey: "entity_lantern_labs",
        targetEntityKey: "entity_project_aurora",
        askedAt: "2026-02-20T12:00:00.000Z",
        status: "asked",
        cooldownUntil: "2026-02-21T12:00:00.000Z",
        deferralCount: 0
      }
    ]
  });

  assert.equal(result.approved, false);
  assert.equal(result.blockDetailReason, "BRIDGE_CAP_REACHED");
  assert.equal(result.conflict?.conflictCode, "CAP_REACHED");
}

/**
 * Implements `blocksBridgeQuestionWhenMissionWouldBeDerailed` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksBridgeQuestionWhenMissionWouldBeDerailed(): void {
  const result = evaluateBridgeQuestionEmissionV1({
    graph: buildBridgeFixtureGraph(),
    candidate: buildBridgePulseCandidate(),
    observedAt: "2026-03-01T12:00:00.000Z",
    activeMissionWorkExists: true
  });

  assert.equal(result.approved, false);
  assert.equal(result.blockDetailReason, "DERAILS_ACTIVE_MISSION");
  assert.equal(result.conflict?.conflictCode, "DERAILS_ACTIVE_MISSION");
}

/**
 * Implements `blocksBridgeQuestionWhenPrivacySensitivePairDetected` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksBridgeQuestionWhenPrivacySensitivePairDetected(): void {
  const result = evaluateBridgeQuestionEmissionV1({
    graph: buildBridgeFixtureGraph(),
    candidate: buildBridgePulseCandidate(),
    observedAt: "2026-03-01T12:00:00.000Z",
    privacyOptOutEntityKeys: ["entity_lantern_labs"]
  });

  assert.equal(result.approved, false);
  assert.equal(result.blockDetailReason, "BRIDGE_PRIVACY_SENSITIVE");
  assert.equal(result.conflict?.conflictCode, "PRIVACY_SENSITIVE");
}

/**
 * Implements `confirmedBridgeAnswerPromotesRelationAndMarksHistoryConfirmed` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function confirmedBridgeAnswerPromotesRelationAndMarksHistoryConfirmed(): void {
  const bridge = evaluateBridgeQuestionEmissionV1({
    graph: buildBridgeFixtureGraph(),
    candidate: buildBridgePulseCandidate(),
    observedAt: "2026-03-01T12:00:00.000Z"
  });
  assert.ok(bridge.bridgeQuestion);

  const resolution = resolveBridgeQuestionAnswerV1({
    graph: buildBridgeFixtureGraph(),
    question: bridge.bridgeQuestion!,
    observedAt: "2026-03-02T12:00:00.000Z",
    evidenceRef: "trace:bridge_confirmation",
    answer: {
      kind: "confirmed",
      relationType: "project_related"
    }
  });
  const promotedEdge = resolution.graph.edges.find((edge) => edge.edgeKey === "edge_bridge_primary");
  assert.equal(resolution.deniedConflictCode, null);
  assert.equal(promotedEdge?.relationType, "project_related");
  assert.equal(promotedEdge?.status, "confirmed");
  assert.equal(resolution.historyRecord.status, "confirmed");
}

/**
 * Implements `deferredBridgeAnswerExtendsCooldownWithDeterministicBackoff` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function deferredBridgeAnswerExtendsCooldownWithDeterministicBackoff(): void {
  const bridge = evaluateBridgeQuestionEmissionV1({
    graph: buildBridgeFixtureGraph(),
    candidate: buildBridgePulseCandidate(),
    observedAt: "2026-03-01T12:00:00.000Z"
  });
  assert.ok(bridge.bridgeQuestion);

  const resolution = resolveBridgeQuestionAnswerV1({
    graph: buildBridgeFixtureGraph(),
    question: bridge.bridgeQuestion!,
    observedAt: "2026-03-02T12:00:00.000Z",
    evidenceRef: "trace:bridge_defer",
    answer: {
      kind: "deferred"
    },
    recentBridgeHistory: [
      {
        questionId: "bridge_q_previous",
        conversationKey: "thread_budget",
        sourceEntityKey: "entity_lantern_labs",
        targetEntityKey: "entity_project_aurora",
        askedAt: "2026-02-20T12:00:00.000Z",
        status: "deferred",
        cooldownUntil: "2026-02-28T12:00:00.000Z",
        deferralCount: 1
      }
    ]
  });

  assert.equal(resolution.deniedConflictCode, null);
  assert.equal(resolution.historyRecord.status, "deferred");
  assert.equal(resolution.historyRecord.deferralCount, 2);
  assert.equal(resolution.historyRecord.cooldownUntil, "2026-04-13T12:00:00.000Z");
}

test(
  "stage 6.86 bridge emits neutral bridge questions when deterministic gating passes",
  emitsNeutralBridgeQuestionWhenEvidenceThresholdAndGuardsPass
);
test(
  "stage 6.86 bridge blocks emission when co-mention evidence threshold is not met",
  blocksBridgeQuestionWhenEvidenceThresholdIsNotMet
);
test(
  "stage 6.86 bridge blocks emission when bridge cooldown is active",
  blocksBridgeQuestionWhenCooldownIsActiveForPair
);
test(
  "stage 6.86 bridge blocks emission when per-conversation bridge cap is reached",
  blocksBridgeQuestionWhenConversationCapIsReached
);
test(
  "stage 6.86 bridge blocks emission when active mission work exists",
  blocksBridgeQuestionWhenMissionWouldBeDerailed
);
test(
  "stage 6.86 bridge blocks emission on privacy-sensitive bridge pairs",
  blocksBridgeQuestionWhenPrivacySensitivePairDetected
);
test(
  "stage 6.86 bridge confirmation promotes relationship status deterministically",
  confirmedBridgeAnswerPromotesRelationAndMarksHistoryConfirmed
);
test(
  "stage 6.86 bridge deferred answer extends cooldown with deterministic backoff",
  deferredBridgeAnswerExtendsCooldownWithDeterministicBackoff
);
