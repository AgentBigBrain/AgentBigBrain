/**
 * @fileoverview Family-specific validators for explicit profile-memory review corrections.
 */

import { normalizeProfileValue } from "./profileMemoryNormalization";
import type { ProfileMemoryGovernanceFamily } from "./profileMemoryTruthGovernanceContracts";
import { validatePreferredNameCandidateValue } from "./profileMemoryPreferredNameValidation";

const MAX_REVIEW_CORRECTION_VALUE_LENGTH = 160;

/**
 * Validates one replacement value before an explicit review correction creates successor truth.
 *
 * **Why it exists:**
 * Review commands are intentionally powerful, but they should not create malformed durable memory
 * values for sensitive families or bypass the same shape checks used by ordinary ingest.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileValue` (import) from `./profileMemoryNormalization`.
 * - Uses `validatePreferredNameCandidateValue` (import) from `./profileMemoryPreferredNameValidation`.
 *
 * @param family - Governance family of the fact being corrected.
 * @param key - Canonical profile-memory key being corrected.
 * @param replacementValue - Raw replacement value supplied by the operator.
 * @returns Normalized replacement value when valid.
 */
export function validateProfileFactReviewReplacementValue(
  family: ProfileMemoryGovernanceFamily,
  key: string,
  replacementValue: string
): string {
  const normalizedValue = normalizeProfileValue(replacementValue);
  if (!normalizedValue) {
    throw new Error("Fact correction requires a non-empty replacement value.");
  }
  if (!isSafeReviewReplacementValue(normalizedValue)) {
    throw new Error(`Fact family ${family} rejected an unsafe correction value.`);
  }
  if (family === "identity.preferred_name") {
    const preferredName = validatePreferredNameCandidateValue(normalizedValue);
    if (!preferredName) {
      throw new Error("Preferred-name correction must be a bounded person-name value.");
    }
    return preferredName;
  }
  if (
    family === "employment.current" ||
    family === "residence.current" ||
    family === "contact.work_association" ||
    family === "contact.organization_association" ||
    family === "contact.location_association"
  ) {
    if (!looksLikeCompactReviewLabel(normalizedValue)) {
      throw new Error(`Fact family ${family} requires a compact label-style correction value.`);
    }
  }
  if (family === "contact.relationship" && !looksLikeCompactRelationshipValue(normalizedValue)) {
    throw new Error("Contact relationship correction must be a compact relationship value.");
  }
  if (family === "generic.profile_fact" && !isApprovedGenericReviewCorrectionKey(key)) {
    throw new Error("Generic profile facts do not support correction override for this key.");
  }
  return normalizedValue;
}

/**
 * Returns whether one review correction is free of obvious command, path, and URL markers.
 *
 * **Why it exists:**
 * Review replacement values are operator-provided text that become durable memory when accepted,
 * so shared low-level value safety needs one deterministic gate.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Normalized correction value.
 * @returns `true` when the value is safe for further family-specific validation.
 */
function isSafeReviewReplacementValue(value: string): boolean {
  return (
    value.length <= MAX_REVIEW_CORRECTION_VALUE_LENGTH &&
    !/[\\/]/.test(value) &&
    !/\b(?:https?:\/\/|file:\/\/)\b/i.test(value) &&
    !/[`$=<>{}\[\]()]/.test(value)
  );
}

/**
 * Returns whether one review correction is shaped like a compact organization or place label.
 *
 * **Why it exists:**
 * Current employment, residence, and association values should stay inspectable labels instead of
 * absorbing narrative clauses through review correction.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Normalized correction value.
 * @returns `true` when the value is a compact label.
 */
function looksLikeCompactReviewLabel(value: string): boolean {
  const tokens = value.split(/\s+/).filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.length <= 8 &&
    !/\b(?:and|but|because|while|although|though|then)\b/i.test(value)
  );
}

/**
 * Returns whether one review correction is shaped like a compact relationship descriptor.
 *
 * **Why it exists:**
 * Relationship corrections should be short descriptors so review commands cannot smuggle broad
 * narrative content into current relationship truth.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Normalized correction value.
 * @returns `true` when the value is a compact relationship descriptor.
 */
function looksLikeCompactRelationshipValue(value: string): boolean {
  const tokens = value.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 4;
}

/**
 * Returns whether one generic fact key remains eligible for explicit correction.
 *
 * **Why it exists:**
 * Generic profile facts are being narrowed during this cleanup. Existing review correction should
 * fail closed unless a generic key has an explicitly approved durable family.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param key - Canonical profile-memory key being corrected.
 * @returns `true` when generic correction is allowed for the key.
 */
function isApprovedGenericReviewCorrectionKey(key: string): boolean {
  return (
    key === "preference.accessibility" ||
    key === "preference.communication" ||
    key === "relationship.role"
  );
}
