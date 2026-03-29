/**
 * @fileoverview Deterministic contact-specific profile-memory extraction helpers.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  displayNameFromContactToken,
  normalizeProfileKey,
  normalizeRelationshipDescriptor,
  splitIntoContextSentences,
  stableContextHash,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";

const HEDGED_CONFIDENCE_PATTERNS = ["maybe", "might be", "not sure", "i think", "possibly"];
const DIRECT_RELATIONSHIP_DESCRIPTORS = new Set([
  "friend",
  "guy",
  "person",
  "coworker",
  "colleague",
  "manager",
  "neighbor",
  "relative",
  "teammate",
  "classmate"
]);
const WORK_WITH_PREFIXES = [
  "i work with ",
  "we work with ",
  "i worked with ",
  "we worked with ",
  "i used to work with ",
  "we used to work with "
] as const;

/**
 * Trims company or association tails that continue into appositive commentary.
 *
 * @param value - Raw association text.
 * @returns Trimmed association value.
 */
function trimAssociationValue(value: string): string {
  const trimmed = trimTrailingClausePunctuation(value);
  const commaIndex = trimmed.indexOf(",");
  return commaIndex >= 0 ? trimmed.slice(0, commaIndex).trim() : trimmed;
}
const WORK_WITH_ME_ASSOCIATION_PREFIXES = [
  "work with me at ",
  "worked with me at ",
  "works with me at ",
  "work with me for ",
  "worked with me for ",
  "works with me for "
] as const;

/**
 * Extracts named-contact facts and relationship associations from narrative phrasing.
 *
 * @param text - Raw user text under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact fact candidates.
 */
export function extractNamedContactFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  const detectedContacts = new Set<string>();
  const contactPatterns = [
    /\b(?:went\s+to\s+school\s+with\s+)?(?:a\s+|an\s+|the\s+)?(friend|guy|person|coworker|colleague|manager|neighbor|relative|teammate|classmate)\s+named\s+([A-Za-z][A-Za-z' -]{1,40})(?=(?:\s+and\b)|,|[.!?\n]|$)/gi,
    /\bmy\s+(friend|coworker|colleague|manager|neighbor|relative|teammate|classmate)\s+is\s+([A-Za-z][A-Za-z' -]{1,40})(?=(?:\s+and\b)|,|[.!?\n]|$)/gi
  ];

  for (const pattern of contactPatterns) {
    for (const match of text.matchAll(pattern)) {
      const descriptor = normalizeRelationshipDescriptor(match[1]);
      const displayName = trimTrailingClausePunctuation(match[2]);
      const contactToken = normalizeProfileKey(displayName);
      if (!contactToken) {
        continue;
      }
      detectedContacts.add(contactToken);

      candidates.push({
        key: `contact.${contactToken}.name`,
        value: displayName,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.named_contact",
        observedAt,
        confidence: toSentenceConfidence(match[0])
      });
      candidates.push({
        key: `contact.${contactToken}.relationship`,
        value: descriptor,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.named_contact",
        observedAt,
        confidence: toSentenceConfidence(match[0])
      });

      if (match[0].toLowerCase().includes("went to school with")) {
        candidates.push({
          key: `contact.${contactToken}.school_association`,
          value: "went_to_school_together",
          sensitive: false,
          sourceTaskId,
          source: "user_input_pattern.school_association",
          observedAt,
          confidence: toSentenceConfidence(match[0])
        });
      }
    }
  }

  for (const segment of splitIntoContextSentences(text)) {
    const relationIndex = segment.toLowerCase().indexOf(" is my ");
    if (relationIndex <= 0) {
      continue;
    }
    const displayName = trimTrailingClausePunctuation(segment.slice(0, relationIndex));
    if (displayName.split(/\s+/).filter(Boolean).length > 3) {
      continue;
    }
    const contactToken = normalizeProfileKey(displayName);
    if (!contactToken) {
      continue;
    }
    const descriptorAndCompany = segment.slice(relationIndex + " is my ".length).trim();
    const associationIndex = (() => {
      const atIndex = descriptorAndCompany.toLowerCase().indexOf(" at ");
      const forIndex = descriptorAndCompany.toLowerCase().indexOf(" for ");
      if (atIndex < 0) {
        return forIndex;
      }
      if (forIndex < 0) {
        return atIndex;
      }
      return Math.min(atIndex, forIndex);
    })();
    const descriptor = normalizeRelationshipDescriptor(
      associationIndex >= 0
        ? descriptorAndCompany.slice(0, associationIndex)
        : descriptorAndCompany
    );
    if (!DIRECT_RELATIONSHIP_DESCRIPTORS.has(descriptor)) {
      continue;
    }
    const company =
      associationIndex >= 0
        ? trimAssociationValue(descriptorAndCompany.slice(associationIndex + 4))
        : "";
    detectedContacts.add(contactToken);
    candidates.push({
      key: `contact.${contactToken}.name`,
      value: displayName,
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.direct_contact_relationship",
      observedAt,
      confidence: toSentenceConfidence(segment)
    });
    candidates.push({
      key: `contact.${contactToken}.relationship`,
      value: descriptor,
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.direct_contact_relationship",
      observedAt,
      confidence: toSentenceConfidence(segment)
    });
    if (company) {
      candidates.push({
        key: `contact.${contactToken}.work_association`,
        value: company,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.direct_contact_relationship",
        observedAt,
        confidence: toSentenceConfidence(segment)
      });
    }
  }

  for (const segment of splitIntoContextSentences(text)) {
    const normalizedSegment = segment.toLowerCase();
    const prefix = WORK_WITH_PREFIXES.find((candidate) => normalizedSegment.startsWith(candidate));
    if (!prefix) {
      continue;
    }
    const remainder = segment.slice(prefix.length).trim();
    const associationIndex = (() => {
      const atIndex = remainder.toLowerCase().indexOf(" at ");
      const forIndex = remainder.toLowerCase().indexOf(" for ");
      if (atIndex < 0) {
        return forIndex;
      }
      if (forIndex < 0) {
        return atIndex;
      }
      return Math.min(atIndex, forIndex);
    })();
    let displayName = remainder;
    let company = "";
    if (associationIndex >= 0) {
      displayName = remainder.slice(0, associationIndex);
      company = remainder.slice(associationIndex + 4);
    }
    displayName = trimTrailingClausePunctuation(displayName);
    company = trimAssociationValue(company);

    const contactToken = normalizeProfileKey(displayName);
    if (!contactToken) {
      continue;
    }
    detectedContacts.add(contactToken);

    candidates.push({
      key: `contact.${contactToken}.name`,
      value: displayName,
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.work_with_contact",
      observedAt,
      confidence: toSentenceConfidence(segment)
    });
    candidates.push({
      key: `contact.${contactToken}.relationship`,
      value: "work_peer",
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.work_with_contact",
      observedAt,
      confidence: toSentenceConfidence(segment)
    });

    if (company) {
      candidates.push({
        key: `contact.${contactToken}.work_association`,
        value: company,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.work_with_contact",
        observedAt,
        confidence: toSentenceConfidence(segment)
      });
    }
  }

  if (detectedContacts.size === 1) {
    const [contactToken] = [...detectedContacts];
    const associationSegment = splitIntoContextSentences(text).find((segment) =>
      WORK_WITH_ME_ASSOCIATION_PREFIXES.some((prefix) =>
        segment.toLowerCase().includes(prefix)
      )
    );
    const associationPrefix = associationSegment
      ? WORK_WITH_ME_ASSOCIATION_PREFIXES.find((prefix) =>
          associationSegment.toLowerCase().includes(prefix)
        ) ?? null
      : null;
    if (associationSegment && associationPrefix) {
      const startIndex = associationSegment.toLowerCase().indexOf(associationPrefix);
      const associationValue = trimTrailingClausePunctuation(
        associationSegment.slice(startIndex + associationPrefix.length)
      );
      candidates.push({
        key: `contact.${contactToken}.relationship`,
        value: "work_peer",
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.work_association",
        observedAt,
        confidence: toSentenceConfidence(associationSegment)
      });
      candidates.push({
        key: `contact.${contactToken}.work_association`,
        value: trimAssociationValue(associationValue),
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.work_association",
        observedAt,
        confidence: toSentenceConfidence(associationSegment)
      });
    }
  }

  const inferredContactTokens = extractContextInferredContactTokens(text);
  for (const inferredToken of inferredContactTokens) {
    detectedContacts.add(inferredToken);
    candidates.push({
      key: `contact.${inferredToken}.name`,
      value: displayNameFromContactToken(inferredToken),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.contact_entity_hint",
      observedAt,
      confidence: 0.75
    });
  }

  const contextFacts = extractContactContextFacts(
    text,
    detectedContacts,
    sourceTaskId,
    observedAt
  );
  for (const contextFact of contextFacts) {
    candidates.push(contextFact);
  }

  return candidates;
}

/**
 * Detects likely named-contact tokens from conversational mention patterns.
 *
 * @param text - Raw user text under analysis.
 * @returns Inferred canonical contact tokens.
 */
function extractContextInferredContactTokens(text: string): string[] {
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
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact context candidates.
 */
function extractContactContextFacts(
  text: string,
  contactTokens: Set<string>,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  if (contactTokens.size === 0) {
    return candidates;
  }

  const sentences = splitIntoContextSentences(text);
  for (const contactToken of contactTokens) {
    const displayName = displayNameFromContactToken(contactToken);
    const namePattern = new RegExp(`\\b${displayName}\\b`, "i");
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
 * Builds deterministic confidence scores for extracted sentences.
 *
 * @param text - Source sentence or phrase.
 * @returns Confidence score in the `[0, 1]` range.
 */
function toSentenceConfidence(text: string): number {
  const normalized = text.toLowerCase();
  const hedged = HEDGED_CONFIDENCE_PATTERNS.some((pattern) =>
    normalized.includes(pattern)
  );
  return hedged ? 0.6 : 0.95;
}
