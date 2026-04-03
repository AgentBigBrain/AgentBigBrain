/**
 * @fileoverview Shared bounded cleanup helpers for deterministic contact extraction.
 */

import { trimTrailingClausePunctuation } from "./profileMemoryNormalization";

const DIRECT_RELATIONSHIP_DESCRIPTOR_PATTERN =
  "(?:friend|partner|spouse|wife|husband|girlfriend|boyfriend|acquaintance|guy|person|boss|coworker|colleague|work\\s+peer|peer|manager|supervisor|lead|team\\s+lead|employee|direct\\s+report|neighbor|neighbour|roommate|relative|distant\\s+relative|family\\s+member|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|teammate|classmate)";

/**
 * Trims company or association tails that continue into appositive commentary.
 *
 * @param value - Raw association text.
 * @returns Trimmed association value.
 */
export function trimAssociationValue(value: string): string {
  const trimmed = trimTrailingClausePunctuation(value);
  const commaIndex = trimmed.indexOf(",");
  return commaIndex >= 0 ? trimmed.slice(0, commaIndex).trim() : trimmed;
}

/**
 * Unwraps named-contact wrappers and trims same-clause continuation text from captured names.
 *
 * @param value - Raw captured contact display name text.
 * @returns Bounded display name suitable for tokenization.
 */
export function sanitizeCapturedContactDisplayName(value: string): string {
  let sanitized = trimTrailingClausePunctuation(value);

  const namedWrapperMatch = sanitized.match(
    new RegExp(
      `^(?:a|an|the)\\s+${DIRECT_RELATIONSHIP_DESCRIPTOR_PATTERN}\\s+named\\s+(.+)$`,
      "i"
    )
  );
  if (namedWrapperMatch?.[1]) {
    sanitized = namedWrapperMatch[1];
  }

  const myRelationshipWrapperMatch = sanitized.match(
    new RegExp(
      `^my\\s+${DIRECT_RELATIONSHIP_DESCRIPTOR_PATTERN}\\s+([A-Z][A-Za-z' -]{1,40})$`,
      "i"
    )
  );
  if (myRelationshipWrapperMatch?.[1]) {
    sanitized = myRelationshipWrapperMatch[1];
  }

  sanitized = sanitized.replace(
    /\s+(?:works?|worked)\s+(?:with|for)\s+me\b.*$/i,
    ""
  );
  sanitized = sanitized.replace(
    /\s+(?:at|for)\s+[A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z][A-Za-z0-9'&.-]*)*$/u,
    ""
  );

  return trimTrailingClausePunctuation(sanitized);
}
