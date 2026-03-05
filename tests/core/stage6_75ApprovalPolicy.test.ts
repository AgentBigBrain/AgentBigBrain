/**
 * @fileoverview Tests deterministic Stage 6.75 approval request/grant validation for diff-hash scope, expiry, and max-use enforcement.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createApprovalGrantV1,
  createApprovalRequestV1,
  registerApprovalGrantUse,
  validateApprovalGrantUse
} from "../../src/core/stage6_75ApprovalPolicy";

/**
 * Implements `buildRequest` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRequest() {
  return createApprovalRequestV1({
    missionId: "mission_approval_001",
    actionIds: ["action_approved_001"],
    diff: "ADD focus blocks for next week",
    riskClass: "tier_3",
    idempotencyKeys: ["idem_approval_001"],
    expiresAt: "2026-02-27T23:00:00.000Z",
    maxUses: 1
  });
}

test("approval grant validates when mission/action/idempotency and expiry are in scope", () => {
  const request = buildRequest();
  const grant = createApprovalGrantV1({
    request,
    approvedAt: "2026-02-27T22:00:00.000Z",
    approvedBy: "operator_benac"
  });

  const decision = validateApprovalGrantUse(request, grant, {
    missionId: "mission_approval_001",
    actionId: "action_approved_001",
    idempotencyKey: "idem_approval_001",
    nowIso: "2026-02-27T22:05:00.000Z"
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.blockCode, null);
});

test("approval grant fails closed when diff hash mismatches", () => {
  const request = buildRequest();
  const grant = createApprovalGrantV1({
    request,
    approvedAt: "2026-02-27T22:00:00.000Z",
    approvedBy: "operator_benac"
  });

  const tampered = {
    ...grant,
    diffHash: "tampered_hash"
  };
  const decision = validateApprovalGrantUse(request, tampered, {
    missionId: "mission_approval_001",
    actionId: "action_approved_001",
    idempotencyKey: "idem_approval_001",
    nowIso: "2026-02-27T22:05:00.000Z"
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.blockCode, "APPROVAL_DIFF_HASH_MISMATCH");
});

test("approval grant fails closed when expired or max-uses exceeded", () => {
  const request = buildRequest();
  const grant = createApprovalGrantV1({
    request,
    approvedAt: "2026-02-27T22:00:00.000Z",
    approvedBy: "operator_benac"
  });
  const usedGrant = registerApprovalGrantUse(grant);

  const maxUsesDecision = validateApprovalGrantUse(request, usedGrant, {
    missionId: "mission_approval_001",
    actionId: "action_approved_001",
    idempotencyKey: "idem_approval_001",
    nowIso: "2026-02-27T22:10:00.000Z"
  });
  assert.equal(maxUsesDecision.ok, false);
  assert.equal(maxUsesDecision.blockCode, "APPROVAL_MAX_USES_EXCEEDED");

  const freshGrant = createApprovalGrantV1({
    request,
    approvedAt: "2026-02-27T22:00:00.000Z",
    approvedBy: "operator_benac"
  });
  const expiryDecision = validateApprovalGrantUse(request, freshGrant, {
    missionId: "mission_approval_001",
    actionId: "action_approved_001",
    idempotencyKey: "idem_approval_001",
    nowIso: "2026-02-28T00:00:00.000Z"
  });
  assert.equal(expiryDecision.ok, false);
  assert.equal(expiryDecision.blockCode, "APPROVAL_EXPIRED");
});
