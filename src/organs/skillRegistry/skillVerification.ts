/**
 * @fileoverview Deterministic skill-verification result helpers.
 */

import type { SkillVerificationResult } from "./skillVerificationContracts";

/**
 * Normalizes unknown input into a trimmed non-empty string for verification comparisons.
 *
 * @param value - Candidate verification string value.
 * @returns Trimmed string or `null`.
 */
function trimToNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves the verification outcome for a skill self-test.
 *
 * @param actualOutputSummary - Output summary produced by the skill run.
 * @param expectedOutputContains - Required substring for a passing verification.
 * @param nowIso - Timestamp applied when verification passes.
 * @returns Canonical verification result.
 */
export function evaluateSkillVerificationResult(
  actualOutputSummary: string | null,
  expectedOutputContains: string | null,
  nowIso: string
): SkillVerificationResult {
  const normalizedExpectation = trimToNonEmptyString(expectedOutputContains);
  if (!normalizedExpectation) {
    return {
      status: "unverified",
      verifiedAt: null,
      failureReason: null,
      outputSummary: trimToNonEmptyString(actualOutputSummary)
    };
  }

  const normalizedOutput = trimToNonEmptyString(actualOutputSummary);
  if (
    normalizedOutput &&
    normalizedOutput.toLowerCase().includes(normalizedExpectation.toLowerCase())
  ) {
    return {
      status: "verified",
      verifiedAt: nowIso,
      failureReason: null,
      outputSummary: normalizedOutput
    };
  }

  return {
    status: "failed",
    verifiedAt: null,
    failureReason: `Expected skill output to include: ${normalizedExpectation}`,
    outputSummary: normalizedOutput
  };
}
