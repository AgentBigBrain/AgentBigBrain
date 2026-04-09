/**
 * @fileoverview Shared bounded helper primitives for profile-memory mutation envelopes.
 */

import { createHash } from "node:crypto";

/**
 * Builds one bounded candidate reference token for mutation-proof linkage.
 *
 * @param kind - Candidate category.
 * @param index - Stable candidate index within that category.
 * @returns Stable bounded candidate reference.
 */
export function buildCandidateRef(kind: string, index: number): string {
  return `${kind}_candidate_${index + 1}`;
}

/**
 * Builds one redaction-safe normalized input identity for mutation-proof linkage.
 *
 * @param userInput - Raw user input attached to the ingest attempt.
 * @param sourceFingerprint - Optional canonical source fingerprint from ingest provenance.
 * @returns Stable bounded normalized input identity.
 */
export function buildNormalizedInputIdentity(
  userInput: string,
  sourceFingerprint?: string
): string {
  if (sourceFingerprint?.trim()) {
    return `input_${sourceFingerprint.trim()}`;
  }
  const normalizedInput = userInput.replace(/\s+/g, " ").trim().toLowerCase();
  return `input_${createHash("sha256")
    .update(normalizedInput)
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Builds one bounded rollback-handle token for mutation-proof linkage.
 *
 * @param sourceTaskId - Canonical source task id for the ingest attempt.
 * @param normalizedInputIdentity - Redaction-safe normalized input identity.
 * @param candidateRefs - Candidate references included in the mutation envelope.
 * @param appliedWriteRefs - Applied write references included in the mutation envelope.
 * @returns Stable bounded rollback-handle token.
 */
export function buildRollbackHandle(
  sourceTaskId: string,
  normalizedInputIdentity: string,
  candidateRefs: readonly string[],
  appliedWriteRefs: readonly string[]
): string {
  const stablePayload = JSON.stringify({
    sourceTaskId,
    normalizedInputIdentity,
    candidateRefs,
    appliedWriteRefs
  });
  return `profile_mutation_${createHash("sha256")
    .update(stablePayload)
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Deduplicates bounded mutation-proof reference ids while preserving insertion order.
 *
 * @param values - Candidate or write refs under normalization.
 * @returns Ordered unique refs.
 */
export function dedupeRefs(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}
