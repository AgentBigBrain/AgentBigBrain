/**
 * @fileoverview Tests proactive inquiry model-output normalization boundary.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeProactiveInquiryInterpretationOutput } from "../../src/organs/languageUnderstanding/proactiveInquiryInterpretation";

test("normalizeProactiveInquiryInterpretationOutput accepts bounded candidate output", () => {
  const candidate = normalizeProactiveInquiryInterpretationOutput({
    candidate: {
      candidateId: "inquiry_model_1",
      sourcePulseCandidateId: "pulse_1",
      inquiryType: "surface_pattern",
      userValueReason: "surfaces_useful_pattern",
      userValueRationale: "The user repeatedly returns to the same deployment blocker.",
      questionPlan: {
        userFacingGoal: "Ask whether to turn the recurring blocker into a checklist.",
        allowedTopic: "deployment blocker",
        forbiddenDetails: [],
        suggestedTone: "tentative",
        boundedDraft: "Would it help if I turned this deployment issue into a reusable checklist?"
      },
      evidence: {
        sourceRecallRefs: ["source_recall:record#chunk"],
        memoryRefs: [],
        graphRefs: ["entity_deployment"],
        recentTurnRefs: ["turn_1"]
      },
      evidencePolicy: {
        sourceRecallStatus: "available",
        blockedSourceRecallRefs: [],
        blockReasons: []
      },
      risk: {
        interruptionRisk: "low",
        privacyRisk: "private_only",
        publicSafe: false,
        activeMissionSafe: true
      },
      confidence: 0.86,
      novelty: 0.74,
      expectedUserValue: 0.81
    }
  });

  assert.equal(candidate?.inquiryType, "surface_pattern");
  assert.equal(candidate?.evidencePolicy.sourceRecallUsable, true);
  assert.equal(candidate?.authority.outreachAuthority, false);
  assert.equal(candidate?.authority.deliveryPermission, false);
});

test("normalizeProactiveInquiryInterpretationOutput rejects absent or low-confidence output", () => {
  assert.equal(normalizeProactiveInquiryInterpretationOutput({ candidate: null }), null);
  assert.equal(normalizeProactiveInquiryInterpretationOutput(null), null);
  assert.equal(
    normalizeProactiveInquiryInterpretationOutput({
      candidate: {
        candidateId: "inquiry_low",
        inquiryType: "surface_pattern",
        userValueReason: "surfaces_useful_pattern",
        userValueRationale: "Low confidence candidate.",
        questionPlan: {
          userFacingGoal: "Ask something.",
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
        confidence: 0.4,
        novelty: 0.8,
        expectedUserValue: 0.8
      }
    }),
    null
  );
});
