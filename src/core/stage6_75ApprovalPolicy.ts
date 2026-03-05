/**
 * @fileoverview Deterministic Stage 6.75 diff-hash approval request/grant helpers with replay-safe scope, expiry, and max-use validation.
 */

import {
  ApprovalGrantV1,
  ApprovalRequestV1,
  Stage675BlockCode
} from "./types";
import { canonicalJson, sha256Hex } from "./normalizers/canonicalizationRules";

export interface ApprovalUseContextV1 {
  missionId: string;
  actionId: string;
  idempotencyKey: string;
  nowIso: string;
}

export interface ApprovalValidationDecision {
  ok: boolean;
  blockCode: Stage675BlockCode | null;
  reason: string;
}

/**
 * Builds approval request v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of approval request v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `canonicalJson` (import `canonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `sha256Hex` (import `sha256Hex`) from `./normalizers/canonicalizationRules`.
 * - Uses `ApprovalRequestV1` (import `ApprovalRequestV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ApprovalRequestV1` result.
 */
export function createApprovalRequestV1(input: {
  missionId: string;
  actionIds: readonly string[];
  diff: string;
  riskClass: "tier_2" | "tier_3";
  idempotencyKeys: readonly string[];
  expiresAt: string;
  maxUses: number;
}): ApprovalRequestV1 {
  const approvalIdBasis = [
    input.missionId,
    canonicalJson(input.actionIds),
    input.diff,
    input.expiresAt
  ].join("|");
  return {
    approvalId: `approval_${sha256Hex(approvalIdBasis).slice(0, 16)}`,
    missionId: input.missionId,
    actionIds: [...input.actionIds],
    diff: input.diff,
    diffHash: sha256Hex(input.diff),
    riskClass: input.riskClass,
    idempotencyKeys: [...input.idempotencyKeys],
    expiresAt: input.expiresAt,
    maxUses: Math.max(1, Math.floor(input.maxUses))
  };
}

/**
 * Builds approval grant v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of approval grant v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `canonicalJson` (import `canonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `sha256Hex` (import `sha256Hex`) from `./normalizers/canonicalizationRules`.
 * - Uses `ApprovalGrantV1` (import `ApprovalGrantV1`) from `./types`.
 * - Uses `ApprovalRequestV1` (import `ApprovalRequestV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ApprovalGrantV1` result.
 */
export function createApprovalGrantV1(input: {
  request: ApprovalRequestV1;
  approvedAt: string;
  approvedBy: string;
}): ApprovalGrantV1 {
  const grantBody = {
    approvalId: input.request.approvalId,
    missionId: input.request.missionId,
    actionIds: input.request.actionIds,
    diffHash: input.request.diffHash,
    approvedAt: input.approvedAt,
    expiresAt: input.request.expiresAt,
    approvedBy: input.approvedBy,
    idempotencyKeys: input.request.idempotencyKeys,
    maxUses: input.request.maxUses
  };
  return {
    ...grantBody,
    uses: 0,
    grantHash: sha256Hex(canonicalJson(grantBody))
  };
}

/**
 * Applies deterministic validity checks for approval grant use.
 *
 * **Why it exists:**
 * Fails fast when approval grant use is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `ApprovalGrantV1` (import `ApprovalGrantV1`) from `./types`.
 * - Uses `ApprovalRequestV1` (import `ApprovalRequestV1`) from `./types`.
 *
 * @param request - Structured input object for this operation.
 * @param grant - Value for grant.
 * @param context - Message/text content processed by this function.
 * @returns Computed `ApprovalValidationDecision` result.
 */
export function validateApprovalGrantUse(
  request: ApprovalRequestV1,
  grant: ApprovalGrantV1,
  context: ApprovalUseContextV1
): ApprovalValidationDecision {
  if (grant.approvalId !== request.approvalId || grant.diffHash !== request.diffHash) {
    return {
      ok: false,
      blockCode: "APPROVAL_DIFF_HASH_MISMATCH",
      reason: "Approval grant does not match request diff hash."
    };
  }
  if (grant.missionId !== context.missionId || grant.missionId !== request.missionId) {
    return {
      ok: false,
      blockCode: "APPROVAL_SCOPE_MISMATCH",
      reason: "Approval grant mission scope mismatch."
    };
  }
  if (!grant.actionIds.includes(context.actionId) || !request.actionIds.includes(context.actionId)) {
    return {
      ok: false,
      blockCode: "APPROVAL_SCOPE_MISMATCH",
      reason: "Action id is outside approved scope."
    };
  }
  if (!grant.idempotencyKeys.includes(context.idempotencyKey)) {
    return {
      ok: false,
      blockCode: "APPROVAL_SCOPE_MISMATCH",
      reason: "Idempotency key is outside approved scope."
    };
  }
  if (Date.parse(context.nowIso) > Date.parse(grant.expiresAt)) {
    return {
      ok: false,
      blockCode: "APPROVAL_EXPIRED",
      reason: "Approval grant is expired."
    };
  }
  if (grant.uses >= grant.maxUses) {
    return {
      ok: false,
      blockCode: "APPROVAL_MAX_USES_EXCEEDED",
      reason: "Approval grant max uses exceeded."
    };
  }
  return {
    ok: true,
    blockCode: null,
    reason: "Approval grant use is valid."
  };
}

/**
 * Registers approval grant use in runtime state for later policy/runtime checks.
 *
 * **Why it exists:**
 * Centralizes lifecycle tracking for approval grant use so audit and retry flows share one source of truth.
 *
 * **What it talks to:**
 * - Uses `ApprovalGrantV1` (import `ApprovalGrantV1`) from `./types`.
 *
 * @param grant - Value for grant.
 * @returns Computed `ApprovalGrantV1` result.
 */
export function registerApprovalGrantUse(grant: ApprovalGrantV1): ApprovalGrantV1 {
  return {
    ...grant,
    uses: grant.uses + 1
  };
}
