/**
 * @fileoverview Contact continuity and context extraction helpers for narrative updates.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  displayNameFromContactToken,
  normalizeProfileKey,
  splitIntoContextSentences,
  stableContextHash,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";
import {
  escapeRegExpLiteral,
  sanitizeCapturedContactDisplayName,
  toSentenceConfidence,
  trimAssociationValue
} from "./profileMemoryContactExtractionSupport";

const THIRD_PERSON_SUBJECT_PATTERN =
  "(?:[A-Z][A-Za-z'.-]{0,30}(?:\\s+[A-Z][A-Za-z'.-]{0,30}){0,2}|[Hh]e|[Ss]he|[Tt]hey)";
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
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})(?:'s| is)(?:\\s+still)?\\s+(?<prep>at|for)\\s+(?<company>.+)$`),
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+works?\\s+(?<prep>at|for)\\s+(?<company>.+)$`),
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+(?:has\\s+already\\s+started|has\\s+started|started|joined)\\s+(?<prep>at|with)\\s+(?<company>.+)$`)
] as const;
const THIRD_PERSON_HISTORICAL_WORK_ASSOCIATION_PATTERNS = [
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+used to be\\s+(?<prep>at|for)\\s+(?<company>.+)$`),
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+used to work\\s+(?<prep>at|for)\\s+(?<company>.+)$`),
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})(?:'s| is)\\s+no\\s+longer\\s+(?<prep>at|for)\\s+(?<company>.+)$`),
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+left\\s+(?<company>.+)$`)
] as const;
const THIRD_PERSON_CONTACT_CONTEXT_PATTERNS = [
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+(?<verb>drives)\\s+(?<detail>.+)$`),
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+(?<verb>(?:still\\s+)?owns|prefers)\\s+(?<detail>.+)$`),
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+(?<verb>is\\s+still\\s+in|is\\s+in|lives\\s+in|still\\s+lives\\s+in|has\\s+been\\s+living\\s+in|is\\s+still\\s+living\\s+in)\\s+(?<detail>.+)$`),
  new RegExp(`^(?<subject>${THIRD_PERSON_SUBJECT_PATTERN})\\s+(?<verb>is\\s+still\\s+splitting\\s+time\\s+between|is\\s+splitting\\s+time\\s+between|still\\s+splitting\\s+time\\s+between|splits\\s+time\\s+between)\\s+(?<detail>.+)$`)
] as const;

interface ResolvedThirdPersonContact {
  contactToken: string;
  displayName: string;
}

/**
 * Splits into continuity clauses.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `splitIntoContextSentences` (import `splitIntoContextSentences`) from `./profileMemoryNormalization`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param text - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function splitIntoContinuityClauses(text: string): readonly string[] {
  const clauses: string[] = [];
  for (const sentence of splitIntoContextSentences(text)) {
    const fragments = sentence
      .split(/(?:,\s+|\s+but\s+|\s+while\s+|\s+although\s+|\s+though\s+)/i)
      .map((fragment) =>
        trimTrailingClausePunctuation(fragment).replace(/^(?:and|then|also)\s+/i, "")
      )
      .filter((fragment) => fragment.length >= 8);
    clauses.push(...(fragments.length === 0 ? [sentence] : fragments));
  }
  return clauses;
}

/**
 * Extracts leading work association label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `trimAssociationValue` (import `trimAssociationValue`) from `./profileMemoryContactExtractionSupport`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractLeadingWorkAssociationLabel(value: string): string {
  const trimmed = trimAssociationValue(value);
  const labelMatch = trimmed.match(
    /^[A-Z0-9][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*)*/
  );
  return trimTrailingClausePunctuation(labelMatch?.[0] ?? "");
}

/**
 * Extracts leading association label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractLeadingAssociationLabel(value: string): string {
  const trimmed = trimTrailingClausePunctuation(value)
    .replace(/\b(?:for\s+now|right\s+now|currently|today)\b/gi, "")
    .trim();
  const labelMatch = trimmed.match(
    /^[A-Z0-9][A-Za-z0-9'&.-]*(?:\s+[A-Z0-9][A-Za-z0-9'&.-]*){0,3}/
  );
  return trimTrailingClausePunctuation(labelMatch?.[0] ?? "");
}

/**
 * Extracts split time association labels.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param detail - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractSplitTimeAssociationLabels(
  detail: string
): { primary: string; secondary: string } | null {
  const trimmed = trimTrailingClausePunctuation(detail);
  const match = trimmed.match(
    /^(?<primary>[A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z][A-Za-z0-9'&.-]*){0,2})\s+and\s+(?<secondary>[A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z][A-Za-z0-9'&.-]*){0,2})(?=(?:\s+for\b)|(?:\s+because\b)|(?:\s+two\b)|(?:\s+three\b)|(?:\s+days?\b)|[,.]|$)/i
  );
  const primary = extractLeadingAssociationLabel(match?.groups?.primary ?? "");
  const secondary = extractLeadingAssociationLabel(match?.groups?.secondary ?? "");
  return primary && secondary ? { primary, secondary } : null;
}

/**
 * Extracts contact context facts.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactUpsertInput` (import `ProfileFactUpsertInput`) from `../profileMemory`.
 * - Uses `escapeRegExpLiteral` (import `escapeRegExpLiteral`) from `./profileMemoryContactExtractionSupport`.
 * - Uses `toSentenceConfidence` (import `toSentenceConfidence`) from `./profileMemoryContactExtractionSupport`.
 * - Uses `displayNameFromContactToken` (import `displayNameFromContactToken`) from `./profileMemoryNormalization`.
 * - Uses `splitIntoContextSentences` (import `splitIntoContextSentences`) from `./profileMemoryNormalization`.
 * - Uses `stableContextHash` (import `stableContextHash`) from `./profileMemoryNormalization`.
 * @param text - Input consumed by this helper.
 * @param contactTokens - Input consumed by this helper.
 * @param contactDisplayNames - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @returns Result produced by this helper.
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

  for (const contactToken of contactTokens) {
    const displayName =
      contactDisplayNames.get(contactToken) ?? displayNameFromContactToken(contactToken);
    const namePattern = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escapeRegExpLiteral(displayName)}(?=$|[^\\p{L}\\p{N}])`,
      "iu"
    );
    let addedContextCount = 0;

    for (const sentence of splitIntoContextSentences(text)) {
      if (!namePattern.test(sentence)) {
        continue;
      }
      candidates.push({
        key: `contact.${contactToken}.context.${stableContextHash(`${contactToken}:${sentence}`)}`,
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
 * Extracts third person contact association and context facts.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactUpsertInput` (import `ProfileFactUpsertInput`) from `../profileMemory`.
 * - Uses `toSentenceConfidence` (import `toSentenceConfidence`) from `./profileMemoryContactExtractionSupport`.
 * - Uses `stableContextHash` (import `stableContextHash`) from `./profileMemoryNormalization`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param text - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function extractThirdPersonContactAssociationAndContextFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  let lastResolvedContact: ResolvedThirdPersonContact | null = null;

  for (const sentence of splitIntoContinuityClauses(text)) {
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
      const company = extractLeadingWorkAssociationLabel(
        associationMatch.match.groups?.company ?? ""
      );
      if (contact && looksLikeWorkAssociationLabel(company)) {
        if (!isPronounLikeContactSubject(associationMatch.match.groups?.subject ?? "")) {
          candidates.push(buildContactNameFact(contact, sourceTaskId, observedAt, sentence));
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
    const verb = trimTrailingClausePunctuation(contextMatch.groups?.verb ?? "");
    if (!contact || !detail) {
      continue;
    }

    if (!isPronounLikeContactSubject(contextMatch.groups?.subject ?? "")) {
      candidates.push(buildContactNameFact(contact, sourceTaskId, observedAt, sentence));
    }
    const normalizedVerb = verb.trim().toLowerCase();
    if (normalizedVerb.includes("owns")) {
      maybePushAssociationFact(
        candidates,
        `contact.${contact.contactToken}.organization_association`,
        extractLeadingAssociationLabel(detail),
        sourceTaskId,
        observedAt,
        sentence
      );
    }
    if (normalizedVerb.includes(" in") || normalizedVerb.includes("lives")) {
      maybePushAssociationFact(
        candidates,
        `contact.${contact.contactToken}.location_association`,
        extractLeadingAssociationLabel(detail),
        sourceTaskId,
        observedAt,
        sentence
      );
    }
    if (normalizedVerb.includes("splitting time between") || normalizedVerb.includes("splits time between")) {
      const splitLabels = extractSplitTimeAssociationLabels(detail);
      if (splitLabels) {
        maybePushAssociationFact(
          candidates,
          `contact.${contact.contactToken}.primary_location_association`,
          splitLabels.primary,
          sourceTaskId,
          observedAt,
          sentence
        );
        maybePushAssociationFact(
          candidates,
          `contact.${contact.contactToken}.secondary_location_association`,
          splitLabels.secondary,
          sourceTaskId,
          observedAt,
          sentence
        );
      }
    }
    const resolvedSentence = `${contact.displayName} ${verb || "drives"} ${detail}`;
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
 * Matches work with me association prefix.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param sentence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function matchWorkWithMeAssociationPrefix(
  sentence: string
): (typeof WORK_WITH_ME_ASSOCIATION_PREFIXES)[number] | null {
  return WORK_WITH_ME_ASSOCIATION_PREFIXES.find(({ prefix }) =>
    sentence.toLowerCase().includes(prefix)
  ) ?? null;
}

/**
 * Builds contact name fact.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactUpsertInput` (import `ProfileFactUpsertInput`) from `../profileMemory`.
 * - Uses `toSentenceConfidence` (import `toSentenceConfidence`) from `./profileMemoryContactExtractionSupport`.
 * @param contact - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @param sentence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildContactNameFact(
  contact: ResolvedThirdPersonContact,
  sourceTaskId: string,
  observedAt: string,
  sentence: string
): ProfileFactUpsertInput {
  return {
    key: `contact.${contact.contactToken}.name`,
    value: contact.displayName,
    sensitive: false,
    sourceTaskId,
    source: "user_input_pattern.named_contact",
    observedAt,
    confidence: toSentenceConfidence(sentence)
  };
}

/**
 * Attempts to push association fact.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileFactUpsertInput` (import `ProfileFactUpsertInput`) from `../profileMemory`.
 * - Uses `toSentenceConfidence` (import `toSentenceConfidence`) from `./profileMemoryContactExtractionSupport`.
 * @param candidates - Input consumed by this helper.
 * @param key - Input consumed by this helper.
 * @param value - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @param sentence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function maybePushAssociationFact(
  candidates: ProfileFactUpsertInput[],
  key: string,
  value: string,
  sourceTaskId: string,
  observedAt: string,
  sentence: string
): void {
  if (!looksLikeAssociationLabel(value)) {
    return;
  }
  const source = key.includes("organization_association")
    ? "user_input_pattern.organization_association"
    : "user_input_pattern.location_association";
  candidates.push({
    key,
    value,
    sensitive: false,
    sourceTaskId,
    source,
    observedAt,
    confidence: toSentenceConfidence(sentence)
  });
}

/**
 * Resolves third person contact subject.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `sanitizeCapturedContactDisplayName` (import `sanitizeCapturedContactDisplayName`) from `./profileMemoryContactExtractionSupport`.
 * - Uses `normalizeProfileKey` (import `normalizeProfileKey`) from `./profileMemoryNormalization`.
 * @param subject - Input consumed by this helper.
 * @param fallback - Input consumed by this helper.
 * @returns Result produced by this helper.
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
    ["i", "we", "you", "it"].includes(contactToken)
  ) {
    return null;
  }
  return { contactToken, displayName };
}

/**
 * Evaluates whether pronoun like contact subject.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param subject - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isPronounLikeContactSubject(subject: string): boolean {
  const normalized = subject.trim().toLowerCase();
  return normalized === "he" || normalized === "she" || normalized === "they";
}

/**
 * Evaluates whether like work association label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function looksLikeWorkAssociationLabel(value: string): boolean {
  return value.length > 0;
}

/**
 * Evaluates whether like association label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function looksLikeAssociationLabel(value: string): boolean {
  return value.length > 0;
}
