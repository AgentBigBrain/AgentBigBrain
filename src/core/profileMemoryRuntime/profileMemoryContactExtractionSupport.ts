/**
 * @fileoverview Shared bounded cleanup helpers for deterministic contact extraction.
 */

import { trimTrailingClausePunctuation } from "./profileMemoryNormalization";
import { normalizeProfileKey } from "./profileMemoryNormalization";

const DIRECT_RELATIONSHIP_DESCRIPTOR_PATTERN =
  "(?:friend|partner|spouse|wife|husband|girlfriend|boyfriend|acquaintance|guy|person|boss|coworker|colleague|work\\s+peer|peer|manager|supervisor|lead|team\\s+lead|employee|direct\\s+report|neighbor|neighbour|roommate|relative|distant\\s+relative|family\\s+member|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|teammate|classmate)";

/**
 * Trims company or association tails that continue into appositive commentary.
 *
 * @param value - Raw association text.
 * @returns Trimmed association value.
 */
export function trimAssociationValue(value: string): string {
  let trimmed = trimTrailingClausePunctuation(value);
  for (const suffix of [" right now", " now", " currently"]) {
    if (trimmed.endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length).trim();
    }
  }
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

/**
 * Builds one single-segment contact token from a display name without leaking dots into the
 * `contact.<token>.*` key slot.
 *
 * @param displayName - Human-facing contact name.
 * @returns Canonical single-segment contact token, or `null` when no bounded token remains.
 */
export function buildDisplayNameContactToken(displayName: string): string | null {
  const normalized = displayName
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

/**
 * Builds one deterministic disambiguated contact token by pairing a visible name with one bounded
 * qualifier such as an organization or locale label.
 *
 * @param displayName - Human-facing contact name.
 * @param qualifier - Deterministic qualifier text.
 * @returns Canonical disambiguated contact token, or `null` when the input is too weak.
 */
export function buildQualifiedContactToken(
  displayName: string,
  qualifier: string
): string | null {
  const nameToken = buildDisplayNameContactToken(displayName);
  const qualifierToken = buildDisplayNameContactToken(qualifier);
  if (!nameToken || !qualifierToken) {
    return null;
  }
  return `${nameToken}_${qualifierToken}`;
}

/**
 * Escapes one literal string for safe embedded regex use.
 *
 * @param value - Raw literal string.
 * @returns Regex-safe literal text.
 */
export function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detects likely named-contact tokens from conversational mention patterns.
 *
 * @param text - Raw user text under analysis.
 * @returns Inferred canonical contact tokens.
 */
export function extractContextInferredContactTokens(text: string): string[] {
  const tokens = new Set<string>();
  const patterns = [
    /\b([A-Z][A-Za-z' -]{1,40}?)\s+and\s+i\b/gi,
    /\bi(?:'ve| have)?\s+known\s+([A-Z][A-Za-z' -]{1,40})\b/gi,
    /\bi\s+know\s+([A-Z][A-Za-z' -]{1,40})\b/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const rawName = trimTrailingClausePunctuation(match[1] ?? "");
      if (
        rawName.split(/\s+/).filter(Boolean).length > 3 ||
        rawName.toLowerCase().startsWith("my ") ||
        rawName.toLowerCase().includes(" name ")
      ) {
        continue;
      }
      const token = normalizeProfileKey(rawName);
      if (!token || token === "i") {
        continue;
      }
      tokens.add(token);
    }
  }

  return [...tokens];
}

/**
 * Builds deterministic confidence scores for extracted sentences.
 *
 * @param text - Source sentence or phrase.
 * @returns Confidence score in the `[0, 1]` range.
 */
export function toSentenceConfidence(text: string): number {
  const normalized = text.toLowerCase();
  return normalized.includes("maybe") ||
    normalized.includes("might be") ||
    normalized.includes("not sure") ||
    normalized.includes("i think") ||
    normalized.includes("possibly")
    ? 0.6
    : 0.95;
}
