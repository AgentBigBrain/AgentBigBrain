/**
 * @fileoverview Deterministic suppression rules for generic profile-fact fallbacks.
 */

import {
  normalizeProfileKey,
  normalizeProfileValue,
  normalizeRelationshipDescriptor
} from "./profileMemoryNormalization";

const NAMED_CONTACT_RELATIONSHIP_DESCRIPTORS = new Set([
  "friend",
  "partner",
  "acquaintance",
  "coworker",
  "colleague",
  "work_peer",
  "manager",
  "employee",
  "neighbor",
  "roommate",
  "relative",
  "cousin",
  "teammate",
  "classmate"
]);

/**
 * Determines whether a generic `my <key> is <value>` match should be skipped because the same
 * sentence was already captured as a named-contact relationship fact.
 *
 * **Why it exists:**
 * Contact extraction runs before the generic `my_is` fallback. Without a bounded skip here,
 * explicit named-contact phrasing such as `My supervisor is Dana.` persists both the governed
 * contact facts and an unrelated generic fact like `supervisor = Dana`, which creates parallel
 * truth surfaces for the same relationship statement.
 *
 * **What it talks to:**
 * - Uses `normalizeRelationshipDescriptor`, `normalizeProfileKey`, and `normalizeProfileValue`
 *   from `./profileMemoryNormalization`.
 * - Uses local `NAMED_CONTACT_RELATIONSHIP_DESCRIPTORS` within this module.
 *
 * @param rawKey - Raw `my_is` key candidate before canonical profile-key mapping.
 * @param rawValue - Raw `my_is` value candidate.
 * @param seen - Deduplication signatures already emitted for this extraction pass.
 * @returns `true` when the generic fallback should be suppressed.
 */
export function shouldSkipGenericMyFactForNamedContact(
  rawKey: string,
  rawValue: string,
  seen: ReadonlySet<string>
): boolean {
  const descriptor = normalizeRelationshipDescriptor(rawKey);
  if (!NAMED_CONTACT_RELATIONSHIP_DESCRIPTORS.has(descriptor)) {
    return false;
  }

  const normalizedValue = normalizeProfileValue(rawValue);
  const contactToken = normalizeProfileKey(normalizedValue);
  if (!contactToken) {
    return false;
  }

  return seen.has(`contact.${contactToken}.name=${normalizedValue}`);
}
