/**
 * @fileoverview Shared bounded cleanup helpers for deterministic contact extraction.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import { trimTrailingClausePunctuation } from "./profileMemoryNormalization";
import {
  displayNameFromContactToken,
  normalizeProfileKey,
  splitIntoContextSentences,
  stableContextHash
} from "./profileMemoryNormalization";

const DIRECT_RELATIONSHIP_DESCRIPTOR_PATTERN =
  "(?:friend|partner|spouse|wife|husband|girlfriend|boyfriend|acquaintance|guy|person|boss|coworker|colleague|work\\s+peer|peer|manager|supervisor|lead|team\\s+lead|employee|direct\\s+report|neighbor|neighbour|roommate|relative|distant\\s+relative|family\\s+member|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|teammate|classmate)";
const WORK_WITH_ME_ASSOCIATION_PREFIXES = [
  { prefix: "used to work with me at ", historical: true },
  { prefix: "work with me at ", historical: false },
  { prefix: "worked with me at ", historical: true },
  { prefix: "works with me at ", historical: false },
  { prefix: "used to work with me for ", historical: true },
  { prefix: "work with me for ", historical: false },
  { prefix: "worked with me for ", historical: true },
  { prefix: "works with me for ", historical: false },
  { prefix: "used to work with me", historical: true },
  { prefix: "work with me", historical: false },
  { prefix: "worked with me", historical: true },
  { prefix: "works with me", historical: false }
] as const;
const THIRD_PERSON_CURRENT_WORK_ASSOCIATION_PATTERNS = [
  /^(?<subject>[A-Za-z][A-Za-z' -]{1,40}|he|she|they)(?:'s| is)\s+(?<prep>at|for)\s+(?<company>.+)$/i,
  /^(?<subject>[A-Za-z][A-Za-z' -]{1,40}|he|she|they)\s+works?\s+(?<prep>at|for)\s+(?<company>.+)$/i
] as const;
const THIRD_PERSON_HISTORICAL_WORK_ASSOCIATION_PATTERNS = [
  /^(?<subject>[A-Za-z][A-Za-z' -]{1,40}|he|she|they)\s+used to be\s+(?<prep>at|for)\s+(?<company>.+)$/i,
  /^(?<subject>[A-Za-z][A-Za-z' -]{1,40}|he|she|they)\s+used to work\s+(?<prep>at|for)\s+(?<company>.+)$/i
] as const;
const THIRD_PERSON_CONTACT_CONTEXT_PATTERNS = [
  /^(?<subject>[A-Za-z][A-Za-z' -]{1,40}|he|she|they)\s+drives\s+(?<detail>.+)$/i
] as const;

interface ResolvedThirdPersonContact {
  contactToken: string;
  displayName: string;
}

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
 * Builds dynamic contact-context facts from sentence-level mentions.
 *
 * @param text - Raw user text under analysis.
 * @param contactTokens - Canonical contact tokens already detected.
 * @param contactDisplayNames - Stable display names for detected contacts.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact context candidates.
 */
export function extractContactContextFacts(
  text: string,
  contactTokens: Set<string>,
  contactDisplayNames: ReadonlyMap<string, string>,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  if (contactTokens.size === 0) {
    return candidates;
  }

  const sentences = splitIntoContextSentences(text);
  for (const contactToken of contactTokens) {
    const displayName = contactDisplayNames.get(contactToken) ?? displayNameFromContactToken(contactToken);
    const namePattern = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escapeRegExpLiteral(displayName)}(?=$|[^\\p{L}\\p{N}])`,
      "iu"
    );
    let addedContextCount = 0;

    for (const sentence of sentences) {
      if (!namePattern.test(sentence)) {
        continue;
      }
      const keySuffix = stableContextHash(`${contactToken}:${sentence}`);
      candidates.push({
        key: `contact.${contactToken}.context.${keySuffix}`,
        value: sentence,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.contact_context",
        observedAt,
        confidence: toSentenceConfidence(sentence)
      });
      addedContextCount += 1;
      if (addedContextCount >= 3) {
        break;
      }
    }
  }

  return candidates;
}

/**
 * Extracts bounded third-person contact association and context facts from one multi-sentence
 * utterance, reusing the most recent explicit contact subject for short pronoun follow-ups.
 *
 * @param text - Raw user text under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact fact candidates.
 */
export function extractThirdPersonContactAssociationAndContextFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  let lastResolvedContact: ResolvedThirdPersonContact | null = null;

  for (const sentence of splitIntoContextSentences(text)) {
    const associationMatch = [
      ...THIRD_PERSON_HISTORICAL_WORK_ASSOCIATION_PATTERNS.map((pattern) => ({
        match: sentence.match(pattern),
        source: "user_input_pattern.work_association_historical" as const
      })),
      ...THIRD_PERSON_CURRENT_WORK_ASSOCIATION_PATTERNS.map((pattern) => ({
        match: sentence.match(pattern),
        source: "user_input_pattern.work_association" as const
      }))
    ].find((entry) => Boolean(entry.match));
    if (associationMatch?.match) {
      const contact = resolveThirdPersonContactSubject(
        associationMatch.match.groups?.subject ?? "",
        lastResolvedContact
      );
      const company = trimAssociationValue(associationMatch.match.groups?.company ?? "");
      if (contact && looksLikeWorkAssociationLabel(company)) {
        if (!isPronounLikeContactSubject(associationMatch.match.groups?.subject ?? "")) {
          candidates.push({
            key: `contact.${contact.contactToken}.name`,
            value: contact.displayName,
            sensitive: false,
            sourceTaskId,
            source: "user_input_pattern.named_contact",
            observedAt,
            confidence: toSentenceConfidence(sentence)
          });
        }
        candidates.push({
          key: `contact.${contact.contactToken}.work_association`,
          value: company,
          sensitive: false,
          sourceTaskId,
          source: associationMatch.source,
          observedAt,
          confidence: toSentenceConfidence(sentence)
        });
        lastResolvedContact = contact;
        continue;
      }
    }

    const contextMatch = THIRD_PERSON_CONTACT_CONTEXT_PATTERNS
      .map((pattern) => sentence.match(pattern))
      .find((value) => Boolean(value));
    if (!contextMatch) {
      continue;
    }
    const contact = resolveThirdPersonContactSubject(
      contextMatch.groups?.subject ?? "",
      lastResolvedContact
    );
    const detail = trimTrailingClausePunctuation(contextMatch.groups?.detail ?? "");
    if (!contact || !detail) {
      continue;
    }

    if (!isPronounLikeContactSubject(contextMatch.groups?.subject ?? "")) {
      candidates.push({
        key: `contact.${contact.contactToken}.name`,
        value: contact.displayName,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.named_contact",
        observedAt,
        confidence: toSentenceConfidence(sentence)
      });
    }
    const resolvedSentence = `${contact.displayName} drives ${detail}`;
    candidates.push({
      key: `contact.${contact.contactToken}.context.${stableContextHash(
        `${contact.contactToken}:${resolvedSentence}`
      )}`,
      value: resolvedSentence,
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.contact_context",
      observedAt,
      confidence: toSentenceConfidence(sentence)
    });
    lastResolvedContact = contact;
  }

  return candidates;
}

/**
 * Returns one bounded association-prefix match when a single detected contact is tied to a
 * first-person work-with-me clause.
 *
 * @param sentence - Candidate sentence under inspection.
 * @returns Matching prefix entry when present.
 */
export function matchWorkWithMeAssociationPrefix(
  sentence: string
): (typeof WORK_WITH_ME_ASSOCIATION_PREFIXES)[number] | null {
  return WORK_WITH_ME_ASSOCIATION_PREFIXES.find(({ prefix }) =>
    sentence.toLowerCase().includes(prefix)
  ) ?? null;
}

/**
 * Resolves one explicit or pronoun subject against the most recent explicit contact in the same
 * utterance.
 *
 * @param subject - Raw captured subject text.
 * @param fallback - Most recent explicit contact from the same utterance.
 * @returns Resolved contact reference when available.
 */
function resolveThirdPersonContactSubject(
  subject: string,
  fallback: ResolvedThirdPersonContact | null
): ResolvedThirdPersonContact | null {
  if (isPronounLikeContactSubject(subject)) {
    return fallback;
  }

  const displayName = sanitizeCapturedContactDisplayName(subject);
  const contactToken = normalizeProfileKey(displayName);
  if (
    !displayName ||
    !contactToken ||
    contactToken === "i" ||
    contactToken === "we" ||
    contactToken === "you" ||
    contactToken === "it"
  ) {
    return null;
  }
  return {
    contactToken,
    displayName
  };
}

/**
 * Returns whether one captured subject is the bounded pronoun form allowed to reuse the most
 * recent explicit contact.
 *
 * @param subject - Raw captured subject text.
 * @returns `true` when the subject is a short third-person pronoun.
 */
function isPronounLikeContactSubject(subject: string): boolean {
  const normalized = subject.trim().toLowerCase();
  return normalized === "he" || normalized === "she" || normalized === "they";
}

/**
 * Returns whether one extracted company-like value is explicit enough for governed
 * `contact.*.work_association` mutation.
 *
 * @param value - Raw trimmed association text.
 * @returns `true` when the label looks like a named organization.
 */
function looksLikeWorkAssociationLabel(value: string): boolean {
  return /^[A-Z0-9][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*)*$/.test(value);
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
