/**
 * @fileoverview Deterministic historical and severed direct relationship extraction for named contacts.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  normalizeProfileKey,
  normalizeRelationshipDescriptor,
  splitIntoContextSentences,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";

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
  "teammate",
  "classmate"
]);

const HISTORICAL_DESCRIPTOR_PREFIXES = ["former ", "ex "] as const;
const DIRECT_RELATIONSHIP_SEVERED_PREFIXES = [
  " is no longer my ",
  " is not my ",
  " isn't my "
] as const;
const SYMMETRIC_HISTORICAL_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) and i used to be (?<descriptor>friends|partners|spouses|married|acquaintances|neighbors|neighbours|roommates|relatives|distant relatives|family|family members|cousins|siblings|classmates|coworkers|colleagues|teammates|peers|work peers)$/i,
  /^i used to be (?<descriptor>friends|partners|spouses|acquaintances|neighbors|neighbours|roommates|relatives|distant relatives|family|family members|cousins|siblings|classmates|coworkers|colleagues|teammates|peers|work peers) with (?<name>[A-Za-z][A-Za-z' -]{1,40})$/i,
  /^i used to be (?<descriptor>married) to (?<name>[A-Za-z][A-Za-z' -]{1,40})$/i
] as const;
const SYMMETRIC_SEVERED_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) and i (?<ending>are no longer|are not|aren't) (?<descriptor>friends|partners|spouses|married|acquaintances|neighbors|neighbours|roommates|relatives|distant relatives|family|family members|cousins|siblings|classmates|coworkers|colleagues|teammates|peers|work peers)(?: anymore)?$/i,
  /^(?<ending>i am no longer|i am not|i'm not) (?<descriptor>friends|partners|spouses|acquaintances|neighbors|neighbours|roommates|relatives|distant relatives|family|family members|cousins|siblings|classmates|coworkers|colleagues|teammates|peers|work peers) with (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: anymore)?$/i,
  /^(?<ending>i am no longer|i am not|i'm not) (?<descriptor>married) to (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: anymore)?$/i
] as const;
const PLURAL_RELATIONSHIP_DESCRIPTOR_ALIASES: Record<string, string> = {
  friends: "friend",
  partners: "partner",
  spouses: "partner",
  married: "partner",
  acquaintances: "acquaintance",
  neighbors: "neighbor",
  neighbours: "neighbor",
  roommates: "roommate",
  relatives: "relative",
  "distant relatives": "relative",
  family: "relative",
  "family members": "relative",
  cousins: "cousin",
  siblings: "sibling",
  classmates: "classmate",
  coworkers: "coworker",
  colleagues: "colleague",
  teammates: "teammate",
  peers: "peer",
  "work peers": "work_peer"
};

/**
 * Trims association or descriptor tails for direct named-contact relationship phrases.
 *
 * @param value - Raw descriptor or association clause.
 * @returns Bounded clause value.
 */
function trimRelationshipClauseValue(value: string): string {
  let trimmed = trimTrailingClausePunctuation(value);
  for (const suffix of [" anymore", " any more"]) {
    if (trimmed.toLowerCase().endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length).trim();
    }
  }
  const commaIndex = trimmed.indexOf(",");
  return commaIndex >= 0 ? trimmed.slice(0, commaIndex).trim() : trimmed;
}

/**
 * Splits one direct relationship clause into descriptor and optional company association.
 *
 * @param value - Raw descriptor clause.
 * @returns Bounded descriptor plus optional company association.
 */
function splitDescriptorAndCompany(value: string): { descriptor: string; company: string } {
  const associationIndex = (() => {
    const atIndex = value.toLowerCase().indexOf(" at ");
    const forIndex = value.toLowerCase().indexOf(" for ");
    if (atIndex < 0) {
      return forIndex;
    }
    if (forIndex < 0) {
      return atIndex;
    }
    return Math.min(atIndex, forIndex);
  })();

  return {
    descriptor: trimRelationshipClauseValue(
      associationIndex >= 0 ? value.slice(0, associationIndex) : value
    ),
    company: trimRelationshipClauseValue(
      associationIndex >= 0 ? value.slice(associationIndex + 4) : ""
    )
  };
}

/**
 * Normalizes bounded plural relationship descriptors used by symmetric history/end-state phrasing.
 *
 * @param value - Raw descriptor text.
 * @returns Canonical singular relationship descriptor.
 */
function normalizeSymmetricRelationshipDescriptor(value: string): string {
  const normalized = trimRelationshipClauseValue(value).toLowerCase();
  return normalizeRelationshipDescriptor(
    PLURAL_RELATIONSHIP_DESCRIPTOR_ALIASES[normalized] ?? normalized
  );
}

/**
 * Builds one direct named-contact relationship bundle for historical or severed phrasing.
 *
 * @param input - Normalized extraction payload.
 * @returns Contact fact candidates.
 */
function buildDirectRelationshipHistoryCandidates(input: {
  displayName: string;
  descriptor: string;
  company: string;
  sourceTaskId: string;
  observedAt: string;
  source: "user_input_pattern.direct_contact_relationship_historical" | "user_input_pattern.direct_contact_relationship_severed";
}): ProfileFactUpsertInput[] {
  const contactToken = normalizeProfileKey(input.displayName);
  if (!contactToken || !DIRECT_RELATIONSHIP_DESCRIPTORS.has(input.descriptor)) {
    return [];
  }

  const candidates: ProfileFactUpsertInput[] = [
    {
      key: `contact.${contactToken}.name`,
      value: input.displayName,
      sensitive: false,
      sourceTaskId: input.sourceTaskId,
      source: input.source,
      observedAt: input.observedAt,
      confidence: 0.95
    },
    {
      key: `contact.${contactToken}.relationship`,
      value: input.descriptor,
      sensitive: false,
      sourceTaskId: input.sourceTaskId,
      source: input.source,
      observedAt: input.observedAt,
      confidence: 0.95
    }
  ];

  if (input.company) {
    candidates.push({
      key: `contact.${contactToken}.work_association`,
      value: input.company,
      sensitive: false,
      sourceTaskId: input.sourceTaskId,
      source: input.source,
      observedAt: input.observedAt,
      confidence: 0.95
    });
  }

  return candidates;
}

/**
 * Extracts historical or severed direct relationship statements such as
 * `Owen is my former coworker at Lantern` and `Owen is no longer my manager`.
 *
 * @param text - Raw user text under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact fact candidates.
 */
export function extractHistoricalDirectContactRelationshipFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];

  for (const segment of splitIntoContextSentences(text)) {
    const normalizedSegment = segment.toLowerCase();
    const historicalMarkerIndex = normalizedSegment.indexOf(" is my ");
    if (historicalMarkerIndex > 0) {
      const displayName = trimRelationshipClauseValue(segment.slice(0, historicalMarkerIndex));
      const relationshipValue = trimRelationshipClauseValue(
        segment.slice(historicalMarkerIndex + " is my ".length)
      );
      for (const prefix of HISTORICAL_DESCRIPTOR_PREFIXES) {
        if (!relationshipValue.toLowerCase().startsWith(prefix)) {
          continue;
        }
        const { descriptor, company } = splitDescriptorAndCompany(
          relationshipValue.slice(prefix.length).trim()
        );
        candidates.push(
          ...buildDirectRelationshipHistoryCandidates({
            displayName,
            descriptor: normalizeRelationshipDescriptor(descriptor),
            company,
            sourceTaskId,
            observedAt,
            source: "user_input_pattern.direct_contact_relationship_historical"
          })
        );
        break;
      }
    }

    for (const prefix of DIRECT_RELATIONSHIP_SEVERED_PREFIXES) {
      const prefixIndex = normalizedSegment.indexOf(prefix);
      if (prefixIndex <= 0) {
        continue;
      }
      const displayName = trimRelationshipClauseValue(segment.slice(0, prefixIndex));
      const relationshipValue = trimRelationshipClauseValue(
        segment.slice(prefixIndex + prefix.length)
      );
      const { descriptor, company } = splitDescriptorAndCompany(relationshipValue);
      candidates.push(
        ...buildDirectRelationshipHistoryCandidates({
          displayName,
          descriptor: normalizeRelationshipDescriptor(descriptor),
          company,
          sourceTaskId,
          observedAt,
          source: "user_input_pattern.direct_contact_relationship_severed"
        })
      );
      break;
    }

    for (const pattern of SYMMETRIC_HISTORICAL_PATTERNS) {
      const match = segment.match(pattern);
      const displayName = trimRelationshipClauseValue(match?.groups?.name ?? "");
      const descriptor = normalizeSymmetricRelationshipDescriptor(
        match?.groups?.descriptor ?? ""
      );
      if (!displayName || !descriptor) {
        continue;
      }
      candidates.push(
        ...buildDirectRelationshipHistoryCandidates({
          displayName,
          descriptor,
          company: "",
          sourceTaskId,
          observedAt,
          source: "user_input_pattern.direct_contact_relationship_historical"
        })
      );
      break;
    }

    for (const pattern of SYMMETRIC_SEVERED_PATTERNS) {
      const match = segment.match(pattern);
      const displayName = trimRelationshipClauseValue(match?.groups?.name ?? "");
      const descriptor = normalizeSymmetricRelationshipDescriptor(
        match?.groups?.descriptor ?? ""
      );
      if (!displayName || !descriptor) {
        continue;
      }
      candidates.push(
        ...buildDirectRelationshipHistoryCandidates({
          displayName,
          descriptor,
          company: "",
          sourceTaskId,
          observedAt,
          source: "user_input_pattern.direct_contact_relationship_severed"
        })
      );
      break;
    }
  }

  return candidates;
}
