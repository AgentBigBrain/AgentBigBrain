/**
 * @fileoverview Canonical Stage 6.85 mission-UX policy helpers.
 */

import type {
  MissionUxResultEnvelopeV1,
  MissionUxStateV1
} from "../types";
import type {
  MissionUxApprovalDecision,
  MissionUxApprovalInput,
  MissionUxResultEnvelopeInput,
  MissionUxStateInput
} from "./contracts";

/**
 * Derives mission ux state from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for mission ux state in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `MissionUxStateV1` (import `MissionUxStateV1`) from `../types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `MissionUxStateV1` result.
 */
export function deriveMissionUxState(input: MissionUxStateInput): MissionUxStateV1 {
  if (input.hasBlockingOutcome) {
    return "blocked";
  }
  if (input.hasCompletedOutcome) {
    return "completed";
  }
  if (input.awaitingApproval) {
    return "awaiting_approval";
  }
  if (input.hasInFlightExecution) {
    return "executing";
  }
  return "planning";
}

/**
 * Implements determine approval granularity behavior used by `stage6_85MissionUxPolicy`.
 *
 * **Why it exists:**
 * Defines public Stage 6.85 mission-UX approval behavior from a canonical clustered file instead
 * of keeping it mixed into the top-level compatibility entrypoint.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `MissionUxApprovalDecision` result.
 */
export function determineApprovalGranularity(
  input: MissionUxApprovalInput
): MissionUxApprovalDecision {
  if (input.tierDerivationFailed || input.stepTiers.length === 0) {
    return {
      approvalMode: "approve_step",
      requiresEscalationPath: true,
      reason: "Tier derivation failed; fail-closed fallback requires escalation and approve_step."
    };
  }

  const normalizedTiers = input.stepTiers.map((value) => Math.trunc(value));
  const hasInvalidTier = normalizedTiers.some((value) => !Number.isFinite(value) || value < 0 || value > 4);
  if (hasInvalidTier) {
    return {
      approvalMode: "approve_step",
      requiresEscalationPath: true,
      reason: "Invalid tier value detected; fail-closed fallback requires escalation and approve_step."
    };
  }

  const highestTier = normalizedTiers.reduce((maxTier, value) => Math.max(maxTier, value), 0);
  if (highestTier >= 3) {
    if (input.playbookAllowlistedForApproveAll) {
      return {
        approvalMode: "approve_all",
        requiresEscalationPath: true,
        reason: "Tier >= 3 step is explicitly allowlisted for approve_all."
      };
    }
    return {
      approvalMode: "approve_step",
      requiresEscalationPath: true,
      reason: "Tier >= 3 step defaults to approve_step when no approve_all allowlist is present."
    };
  }

  return {
    approvalMode: "approve_all",
    requiresEscalationPath: highestTier >= 2,
    reason: "Tier set allows approve_all with deterministic escalation rules."
  };
}

/**
 * Transforms stable approval diff into a stable output representation.
 *
 * **Why it exists:**
 * Defines public Stage 6.85 diff-formatting behavior from the clustered mission-UX subsystem.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param diffLines - Single text line being parsed or transformed.
 * @returns Resulting string value.
 */
export function formatStableApprovalDiff(diffLines: readonly string[]): string {
  if (diffLines.length === 0) {
    return "01. (no changes)";
  }

  return diffLines
    .map((line, index) => {
      const sequence = String(index + 1).padStart(2, "0");
      const normalized = line.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      return `${sequence}. ${normalized.length > 0 ? normalized : "(empty line)"}`;
    })
    .join("\n");
}

/**
 * Normalizes refs into a stable shape for `stage6_85/missionUx` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for refs so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param refs - Value for refs.
 * @returns Ordered collection produced by this step.
 */
function normalizeRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right)
  );
}

/**
 * Builds mission ux result envelope for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps Stage 6.85 mission result-envelope construction canonical inside the clustered mission-UX
 * subsystem instead of the top-level compatibility entrypoint.
 *
 * **What it talks to:**
 * - Uses `MissionUxResultEnvelopeV1` (import `MissionUxResultEnvelopeV1`) from `../types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `MissionUxResultEnvelopeV1` result.
 */
export function buildMissionUxResultEnvelope(
  input: MissionUxResultEnvelopeInput
): MissionUxResultEnvelopeV1 {
  return {
    missionId: input.missionId,
    state: input.state,
    summary: input.summary.trim(),
    evidenceRefs: normalizeRefs(input.evidenceRefs),
    receiptRefs: normalizeRefs(input.receiptRefs),
    nextStepSuggestion:
      input.nextStepSuggestion === null ? null : input.nextStepSuggestion.trim() || null
  };
}
