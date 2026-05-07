/**
 * @fileoverview Schema normalization boundary for proactive inquiry model output.
 */

import {
  normalizeProactiveInquiryCandidate,
  type ProactiveInquiryCandidate,
  type ProactiveInquiryCandidateDraft
} from "../../core/stage6_86/proactiveInquiryCandidates";

export interface ProactiveInquiryInterpretationModelOutput {
  candidate: ProactiveInquiryCandidateDraft | null;
}

/**
 * Normalizes model output into one non-authoritative proactive inquiry candidate.
 *
 * **Why it exists:**
 * The model may propose inquiry intent, value rationale, evidence, and risk, but it must not grant
 * outreach permission or final wording. This boundary keeps malformed or low-confidence output from
 * entering pulse policy.
 *
 * **What it talks to:**
 * - Uses `normalizeProactiveInquiryCandidate` from core Stage 6.86 proactive inquiry contracts.
 *
 * @param output - Structured model output.
 * @returns Candidate, or `null` when output is malformed, low confidence, or absent.
 */
export function normalizeProactiveInquiryInterpretationOutput(
  output: unknown
): ProactiveInquiryCandidate | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const candidate = (output as ProactiveInquiryInterpretationModelOutput).candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  return normalizeProactiveInquiryCandidate(candidate);
}
