/**
 * @fileoverview Canonical Stage 6.85 quality-gate helpers for definition-of-done profiles, verification gates, and truthfulness checks.
 */

import { VerificationCategoryV1, VerificationGateV1 } from "../types";

export interface DefinitionOfDoneProfileV1 {
  category: VerificationCategoryV1;
  requiredProofKinds: readonly string[];
}

/**
 * Normalizes proof refs into a stable ordered set.
 *
 * @param proofRefs - Value for proof refs.
 * @returns Ordered collection produced by this step.
 */
function normalizeProofRefs(proofRefs: readonly string[]): string[] {
  return [...new Set(proofRefs.map((proofRef) => proofRef.trim()).filter((proofRef) => proofRef.length > 0))].sort(
    (left, right) => left.localeCompare(right)
  );
}

/**
 * Resolves the definition-of-done profile for a verification category.
 *
 * @param category - Value for category.
 * @returns Computed `DefinitionOfDoneProfileV1` result.
 */
export function resolveDefinitionOfDoneProfile(
  category: VerificationCategoryV1
): DefinitionOfDoneProfileV1 {
  if (category === "build") {
    return { category, requiredProofKinds: ["build", "test"] };
  }
  if (category === "research") {
    return { category, requiredProofKinds: ["sources", "summary"] };
  }
  if (category === "workflow_replay") {
    return { category, requiredProofKinds: ["capture", "compile", "replay_receipt"] };
  }
  return { category, requiredProofKinds: ["message", "policy_trace"] };
}

/**
 * Evaluates a verification gate using deterministic proof/waiver rules.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `VerificationGateV1` result.
 */
export function evaluateVerificationGate(input: {
  gateId: string;
  category: VerificationCategoryV1;
  proofRefs: readonly string[];
  waiverApproved: boolean;
}): VerificationGateV1 {
  const normalizedProofs = normalizeProofRefs(input.proofRefs);
  const passed = normalizedProofs.length > 0 || input.waiverApproved;
  return {
    gateId: input.gateId.trim() || "verification_gate_unknown",
    category: input.category,
    proofRefs: normalizedProofs,
    waiverApproved: input.waiverApproved,
    passed,
    reason: passed
      ? normalizedProofs.length > 0
        ? "Verification gate passed with deterministic completion proofs."
        : "Verification gate passed by explicit approved waiver."
      : "Verification gate failed because no completion proof or waiver was provided."
  };
}

/**
 * Evaluates whether a summary passes the deterministic truthfulness gate.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `{ passed: boolean; reason: string }` result.
 */
export function evaluateTruthfulnessGate(input: {
  summaryText: string;
  blockedSideEffectCount: number;
  simulatedActionCount: number;
  simulationLabelPresent: boolean;
}): { passed: boolean; reason: string } {
  const normalizedSummary = input.summaryText.trim().toLowerCase();
  const optimisticMarkers = ["success", "completed", "sent", "written", "executed"];

  if (input.blockedSideEffectCount > 0 && optimisticMarkers.some((marker) => normalizedSummary.includes(marker))) {
    return {
      passed: false,
      reason: "Blocked side effects cannot be represented using optimistic success language."
    };
  }
  if (input.simulatedActionCount > 0 && !input.simulationLabelPresent) {
    return {
      passed: false,
      reason: "Simulated actions must be explicitly labeled as simulated."
    };
  }
  return {
    passed: true,
    reason: "Truthfulness gate passed."
  };
}
