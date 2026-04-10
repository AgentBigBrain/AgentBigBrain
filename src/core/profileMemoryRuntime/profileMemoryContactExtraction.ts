/**
 * @fileoverview Deterministic contact-specific profile-memory extraction helpers.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  displayNameFromContactToken,
  normalizeProfileKey,
  normalizeRelationshipDescriptor,
  splitIntoContextSentences,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";
import {
  buildDisplayNameContactToken,
  buildQualifiedContactToken,
  extractContactContextFacts,
  extractContextInferredContactTokens,
  extractThirdPersonContactAssociationAndContextFacts,
  matchWorkWithMeAssociationPrefix,
  sanitizeCapturedContactDisplayName,
  toSentenceConfidence,
  trimAssociationValue
} from "./profileMemoryContactExtractionSupport";

const DIRECT_RELATIONSHIP_DESCRIPTORS = new Set([
  "friend",
  "partner",
  "acquaintance",
  "guy",
  "person",
  "coworker",
  "colleague",
  "work_peer",
  "manager",
  "employee",
  "neighbor",
  "roommate",
  "relative",
  "cousin",
  "son",
  "daughter",
  "parent",
  "child",
  "sibling",
  "mom",
  "mother",
  "dad",
  "father",
  "sister",
  "brother",
  "teammate",
  "classmate"
]);
const WORK_WITH_PREFIXES = [
  { prefix: "i work with ", historical: false },
  { prefix: "we work with ", historical: false },
  { prefix: "i worked with ", historical: true },
  { prefix: "we worked with ", historical: true },
  { prefix: "i used to work with ", historical: true },
  { prefix: "we used to work with ", historical: true }
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
  const detectedContactDisplayNames = new Map<string, string>();
  const rememberDetectedContact = (contactToken: string, displayName: string): void => {
    detectedContacts.add(contactToken);
    detectedContactDisplayNames.set(contactToken, displayName);
  };
  const contactPatterns = [
    /\b(?:went\s+to\s+school\s+with\s+)?(?:a\s+|an\s+|the\s+)?(friend|partner|spouse|wife|husband|girlfriend|boyfriend|acquaintance|guy|person|boss|coworker|colleague|work peer|peer|manager|supervisor|lead|team lead|employee|direct report|neighbor|neighbour|roommate|relative|distant relative|family member|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|teammate|classmate)\s+named\s+([A-Za-z][A-Za-z' -]{1,40})(?=(?:\s+and\b)|,|[.!?\n]|$)/gi,
    /\bmy\s+(friend|partner|spouse|wife|husband|girlfriend|boyfriend|acquaintance|boss|coworker|colleague|work peer|peer|manager|supervisor|lead|team lead|employee|direct report|neighbor|neighbour|roommate|relative|distant relative|family member|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|teammate|classmate)\s+is\s+([A-Za-z][A-Za-z' -]{1,40})(?=(?:\s+and\b)|,|[.!?\n]|$)/gi,
    /\bmy\s+(friend|partner|spouse|wife|husband|girlfriend|boyfriend|acquaintance|boss|coworker|colleague|work peer|peer|manager|supervisor|lead|team lead|employee|direct report|neighbor|neighbour|roommate|relative|distant relative|family member|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|teammate|classmate)\s+([A-Z][A-Za-z' -]{1,40}?)(?=\s+(?:works?|worked)\s+(?:with|for)\s+me\b)/gi
  ];

  for (const pattern of contactPatterns) {
    for (const match of text.matchAll(pattern)) {
      const descriptor = normalizeRelationshipDescriptor(match[1]);
      const displayName = sanitizeCapturedContactDisplayName(match[2]);
      const contactToken = normalizeProfileKey(displayName);
      if (!contactToken) {
        continue;
      }
      rememberDetectedContact(contactToken, displayName);

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
    const alternateContactMatch = segment.match(
      /^i(?:\s+also)?\s+(?:know|met)\s+(?:another|a\s+different)\s+([A-Z][A-Za-z'.-]{0,30})\s+(?:at|from)\s+([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z][A-Za-z0-9'&.-]*)*?)(?:\s+last\s+month)?$/i
    );
    if (alternateContactMatch) {
      const displayName = sanitizeCapturedContactDisplayName(alternateContactMatch[1] ?? "");
      const qualifier = trimAssociationValue(alternateContactMatch[2] ?? "");
      const contactToken = buildQualifiedContactToken(displayName, qualifier);
      if (contactToken) {
        rememberDetectedContact(contactToken, displayName);
        candidates.push({
          key: `contact.${contactToken}.name`,
          value: displayName,
          sensitive: false,
          sourceTaskId,
          source: "user_input_pattern.named_contact",
          observedAt,
          confidence: toSentenceConfidence(segment)
        });
        continue;
      }
    }

    const aliasQualifiedContactMatch = segment.match(
      /^the\s+([A-Z][A-Za-z'.-]{0,30})\s+from\s+([A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z][A-Za-z0-9'&.-]*)*)\s+sometimes\s+goes\s+by\s+([A-Z][A-Za-z'.-]{0,20})$/i
    );
    if (aliasQualifiedContactMatch) {
      const displayName = sanitizeCapturedContactDisplayName(aliasQualifiedContactMatch[1] ?? "");
      const contactToken = buildDisplayNameContactToken(displayName);
      if (contactToken) {
        rememberDetectedContact(contactToken, displayName);
        candidates.push({
          key: `contact.${contactToken}.name`,
          value: displayName,
          sensitive: false,
          sourceTaskId,
          source: "user_input_pattern.named_contact",
          observedAt,
          confidence: toSentenceConfidence(segment)
        });
        continue;
      }
    }

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
    rememberDetectedContact(contactToken, displayName);
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
    const prefixEntry = WORK_WITH_PREFIXES.find(({ prefix }) => normalizedSegment.startsWith(prefix));
    if (!prefixEntry) {
      continue;
    }
    const remainder = segment.slice(prefixEntry.prefix.length).trim();
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
    displayName = sanitizeCapturedContactDisplayName(displayName);
    company = trimAssociationValue(company);

    const contactToken = normalizeProfileKey(displayName);
    if (!contactToken) {
      continue;
    }
    rememberDetectedContact(contactToken, displayName);

    candidates.push({
      key: `contact.${contactToken}.name`,
      value: displayName,
      sensitive: false,
      sourceTaskId,
      source: prefixEntry.historical
        ? "user_input_pattern.work_with_contact_historical"
        : "user_input_pattern.work_with_contact",
      observedAt,
      confidence: toSentenceConfidence(segment)
    });
    candidates.push({
      key: `contact.${contactToken}.relationship`,
      value: "work_peer",
      sensitive: false,
      sourceTaskId,
      source: prefixEntry.historical
        ? "user_input_pattern.work_with_contact_historical"
        : "user_input_pattern.work_with_contact",
      observedAt,
      confidence: toSentenceConfidence(segment)
    });

    if (company) {
      candidates.push({
        key: `contact.${contactToken}.work_association`,
        value: company,
        sensitive: false,
        sourceTaskId,
        source: prefixEntry.historical
          ? "user_input_pattern.work_with_contact_historical"
          : "user_input_pattern.work_with_contact",
        observedAt,
        confidence: toSentenceConfidence(segment)
      });
    }
  }

  for (const thirdPersonFact of extractThirdPersonContactAssociationAndContextFacts(
    text,
    sourceTaskId,
    observedAt
  )) {
    const contactMatch = thirdPersonFact.key.match(/^contact\.([^.]+)\./);
    if (contactMatch?.[1]) {
      const contactToken = contactMatch[1];
      if (thirdPersonFact.key === `contact.${contactToken}.name`) {
        rememberDetectedContact(contactToken, thirdPersonFact.value);
      } else if (!detectedContactDisplayNames.has(contactToken)) {
        rememberDetectedContact(contactToken, displayNameFromContactToken(contactToken));
      } else {
        detectedContacts.add(contactToken);
      }
    }
    candidates.push(thirdPersonFact);
  }

  if (detectedContacts.size === 1) {
    const [contactToken] = [...detectedContacts];
    const associationSegment = splitIntoContextSentences(text).find((segment) =>
      matchWorkWithMeAssociationPrefix(segment) !== null
    );
    const associationPrefixEntry = associationSegment
      ? matchWorkWithMeAssociationPrefix(associationSegment)
      : null;
    if (associationSegment && associationPrefixEntry) {
      const startIndex = associationSegment.toLowerCase().indexOf(associationPrefixEntry.prefix);
      const associationValue = trimTrailingClausePunctuation(
        associationSegment.slice(startIndex + associationPrefixEntry.prefix.length)
      );
      candidates.push({
        key: `contact.${contactToken}.relationship`,
        value: "work_peer",
        sensitive: false,
        sourceTaskId,
        source: associationPrefixEntry.historical
          ? "user_input_pattern.work_association_historical"
          : "user_input_pattern.work_association",
        observedAt,
        confidence: toSentenceConfidence(associationSegment)
      });
      const trimmedAssociationValue = trimAssociationValue(associationValue);
      if (trimmedAssociationValue) {
        candidates.push({
          key: `contact.${contactToken}.work_association`,
          value: trimmedAssociationValue,
          sensitive: false,
          sourceTaskId,
          source: associationPrefixEntry.historical
            ? "user_input_pattern.work_association_historical"
            : "user_input_pattern.work_association",
          observedAt,
          confidence: toSentenceConfidence(associationSegment)
        });
      }
    }
  }

  const inferredContactTokens = extractContextInferredContactTokens(text);
  for (const inferredToken of inferredContactTokens) {
    rememberDetectedContact(inferredToken, displayNameFromContactToken(inferredToken));
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
    detectedContactDisplayNames,
    sourceTaskId,
    observedAt
  );
  for (const contextFact of contextFacts) {
    candidates.push(contextFact);
  }

  return candidates;
}
