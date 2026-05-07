/**
 * @fileoverview Tests proactive inquiry candidate normalization and authority boundaries.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProactiveInquiryCandidateFromPulseCandidate,
  normalizeProactiveInquiryCandidate
} from "../../src/core/stage6_86/proactiveInquiryCandidates";
import type { PulseCandidateV1 } from "../../src/core/types";
import { buildPulseScoreBreakdownFixture } from "../helpers/conversationFixtures";

test("buildProactiveInquiryCandidateFromPulseCandidate creates non-authoritative inquiry intent", () => {
  const inquiry = buildProactiveInquiryCandidateFromPulseCandidate(
    buildPulseCandidate("OPEN_LOOP_RESUME"),
    { sourceRecallStatus: "not_used" }
  );

  assert.equal(inquiry.inquiryType, "resume_open_loop");
  assert.equal(inquiry.userValueReason, "prevents_stale_work");
  assert.equal(inquiry.questionPlan.boundedDraft, null);
  assert.equal(inquiry.evidencePolicy.sourceRecallStatus, "not_used");
  assert.equal(inquiry.authority.outreachAuthority, false);
  assert.equal(inquiry.authority.deliveryPermission, false);
  assert.equal(inquiry.authority.memoryWriteAuthority, false);
  assert.equal(inquiry.authority.truthAuthority, false);
  assert.equal(inquiry.authority.approvalAuthority, false);
});

test("buildProactiveInquiryCandidateFromPulseCandidate records unavailable Source Recall explicitly", () => {
  const inquiry = buildProactiveInquiryCandidateFromPulseCandidate(
    buildPulseCandidate("STALE_FACT_REVALIDATION"),
    {
      sourceRecallStatus: "blocked",
      blockedSourceRecallRefs: ["source_recall:blocked"],
      blockReasons: ["source_recall_blocked"]
    }
  );

  assert.equal(inquiry.inquiryType, "revalidate_stale_fact");
  assert.equal(inquiry.evidencePolicy.sourceRecallStatus, "blocked");
  assert.equal(inquiry.evidencePolicy.sourceRecallUsable, false);
  assert.deepEqual(inquiry.evidencePolicy.blockReasons, ["source_recall_blocked"]);
  assert.deepEqual(inquiry.evidencePolicy.blockedSourceRecallRefs, ["source_recall:blocked"]);
});

test("normalizeProactiveInquiryCandidate accepts bounded schema output", () => {
  const normalized = normalizeProactiveInquiryCandidate({
    candidateId: "inquiry_1",
    sourcePulseCandidateId: "pulse_1",
    inquiryType: "ask_missing_constraint",
    userValueReason: "asks_for_missing_constraint",
    userValueRationale: "This would prevent the assistant from guessing a key project constraint.",
    questionPlan: {
      userFacingGoal: "Ask for the missing launch deadline.",
      allowedTopic: "launch deadline",
      forbiddenDetails: ["private client details"],
      suggestedTone: "direct",
      boundedDraft: "Do you want me to use this Friday as the launch target?"
    },
    evidence: {
      sourceRecallRefs: [],
      memoryRefs: ["memory_fact_1"],
      graphRefs: ["entity_project"],
      recentTurnRefs: ["turn_recent"]
    },
    evidencePolicy: {
      sourceRecallStatus: "not_used",
      blockedSourceRecallRefs: [],
      blockReasons: []
    },
    risk: {
      interruptionRisk: "low",
      privacyRisk: "none",
      publicSafe: true,
      activeMissionSafe: true
    },
    confidence: 0.91,
    novelty: 0.8,
    expectedUserValue: 0.77
  });

  assert.equal(normalized?.candidateId, "inquiry_1");
  assert.equal(normalized?.questionPlan.boundedDraft, "Do you want me to use this Friday as the launch target?");
  assert.equal(normalized?.authority.outreachAuthority, false);
});

test("normalizeProactiveInquiryCandidate fails closed for malformed or low-value output", () => {
  const lowConfidence = normalizeProactiveInquiryCandidate({
    candidateId: "inquiry_low",
    inquiryType: "ask_missing_constraint",
    userValueReason: "asks_for_missing_constraint",
    userValueRationale: "Too weak.",
    questionPlan: {
      userFacingGoal: "Ask a question.",
      allowedTopic: "topic",
      forbiddenDetails: [],
      suggestedTone: "direct",
      boundedDraft: null
    },
    evidence: {
      sourceRecallRefs: [],
      memoryRefs: [],
      graphRefs: [],
      recentTurnRefs: []
    },
    evidencePolicy: {
      sourceRecallStatus: "not_used",
      blockedSourceRecallRefs: [],
      blockReasons: []
    },
    risk: {
      interruptionRisk: "low",
      privacyRisk: "none",
      publicSafe: true,
      activeMissionSafe: true
    },
    confidence: 0.5,
    novelty: 0.8,
    expectedUserValue: 0.77
  });
  const malformed = normalizeProactiveInquiryCandidate({
    candidateId: "inquiry_bad",
    inquiryType: "deliver_message_now",
    userValueReason: "asks_for_missing_constraint"
  });

  assert.equal(lowConfidence, null);
  assert.equal(malformed, null);
});

/**
 * Builds a deterministic pulse candidate fixture.
 *
 * @param reasonCode - Reason code.
 * @returns Pulse candidate.
 */
function buildPulseCandidate(reasonCode: PulseCandidateV1["reasonCode"]): PulseCandidateV1 {
  return {
    candidateId: `pulse_${reasonCode.toLowerCase()}`,
    reasonCode,
    score: 0.72,
    scoreBreakdown: buildPulseScoreBreakdownFixture({
      recency: 0.7,
      frequency: 0.6,
      unresolvedImportance: 0.8,
      cooldownPenalty: 0.1
    }),
    lastTouchedAt: "2026-03-07T14:00:00.000Z",
    threadKey: "thread_alpha",
    entityRefs: ["entity_alpha"],
    evidenceRefs: ["turn_alpha"],
    sourceAuthority: "stale_runtime_context",
    provenanceTier: "supporting",
    sensitive: false,
    activeMissionSuppressed: false,
    stableHash: "pulse-stable-hash"
  };
}
