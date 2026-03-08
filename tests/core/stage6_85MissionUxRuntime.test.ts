/**
 * @fileoverview Tests canonical Stage 6.85 mission-UX runtime helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMissionUxResultEnvelope,
  determineApprovalGranularity
} from "../../src/core/stage6_85/missionUx";

test("stage6_85 mission runtime keeps Tier >= 3 default on approve_step without allowlist", () => {
  const decision = determineApprovalGranularity({
    stepTiers: [2, 3],
    playbookAllowlistedForApproveAll: false,
    tierDerivationFailed: false
  });

  assert.equal(decision.approvalMode, "approve_step");
  assert.equal(decision.requiresEscalationPath, true);
});

test("stage6_85 mission runtime normalizes refs and trims next-step text", () => {
  const envelope = buildMissionUxResultEnvelope({
    missionId: "mission_6_85_runtime",
    state: "awaiting_approval",
    summary: "  waiting for approval  ",
    evidenceRefs: ["trace_b", "trace_a", "trace_b"],
    receiptRefs: ["receipt_b", "receipt_a", "receipt_a"],
    nextStepSuggestion: "  approve now "
  });

  assert.deepEqual(envelope.evidenceRefs, ["trace_a", "trace_b"]);
  assert.deepEqual(envelope.receiptRefs, ["receipt_a", "receipt_b"]);
  assert.equal(envelope.nextStepSuggestion, "approve now");
});
