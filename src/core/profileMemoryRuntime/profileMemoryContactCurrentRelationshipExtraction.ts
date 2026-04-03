/**
 * @fileoverview Deterministic current direct relationship extraction for bounded symmetric phrasing.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  normalizeProfileKey,
  normalizeRelationshipDescriptor,
  splitIntoContextSentences,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";

const CURRENT_SYMMETRIC_RELATIONSHIP_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) and i are (?<descriptor>friends|partners|spouses|married|acquaintances|neighbors|neighbours|roommates|relatives|distant relatives|family|family members|cousins|siblings|classmates|coworkers|colleagues|teammates|peers|work peers)$/i,
  /^(?<ending>i am|i'm) (?<descriptor>friends|partners|spouses|acquaintances|neighbors|neighbours|roommates|relatives|distant relatives|family|family members|cousins|siblings|classmates|coworkers|colleagues|teammates|peers|work peers) with (?<name>[A-Za-z][A-Za-z' -]{1,40})$/i,
  /^(?<ending>i am|i'm) (?<descriptor>married) to (?<name>[A-Za-z][A-Za-z' -]{1,40})$/i
] as const;

const CURRENT_DIRECT_RELATIONSHIP_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) is (?<descriptor>family)$/i,
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) is (?:a |my )?(?<descriptor>family member)$/i
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

const CURRENT_RELATIONSHIP_DESCRIPTORS = new Set([
  "friend",
  "partner",
  "acquaintance",
  "neighbor",
  "roommate",
  "relative",
  "cousin",
  "classmate",
  "coworker",
  "colleague",
  "work_peer",
  "teammate"
]);

/**
 * Normalizes bounded plural relationship descriptors used by symmetric current-state phrasing.
 *
 * @param value - Raw descriptor text.
 * @returns Canonical singular relationship descriptor.
 */
function normalizeSymmetricRelationshipDescriptor(value: string): string {
  const normalized = trimTrailingClausePunctuation(value).toLowerCase();
  return normalizeRelationshipDescriptor(
    PLURAL_RELATIONSHIP_DESCRIPTOR_ALIASES[normalized] ?? normalized
  );
}

/**
 * Builds one direct named-contact relationship bundle for current-state phrasing.
 *
 * @param input - Normalized extraction payload.
 * @returns Contact fact candidates.
 */
function buildDirectRelationshipCandidates(input: {
  displayName: string;
  descriptor: string;
  sourceTaskId: string;
  observedAt: string;
}): ProfileFactUpsertInput[] {
  const contactToken = normalizeProfileKey(input.displayName);
  if (!contactToken || !CURRENT_RELATIONSHIP_DESCRIPTORS.has(input.descriptor)) {
    return [];
  }

  return [
    {
      key: `contact.${contactToken}.name`,
      value: input.displayName,
      sensitive: false,
      sourceTaskId: input.sourceTaskId,
      source: "user_input_pattern.direct_contact_relationship",
      observedAt: input.observedAt,
      confidence: 0.95
    },
    {
      key: `contact.${contactToken}.relationship`,
      value: input.descriptor,
      sensitive: false,
      sourceTaskId: input.sourceTaskId,
      source: "user_input_pattern.direct_contact_relationship",
      observedAt: input.observedAt,
      confidence: 0.95
    }
  ];
}

/**
 * Extracts bounded symmetric current direct relationship statements such as
 * `Owen and I are friends.`, `I'm friends with Owen.`, and `Owen and I are coworkers.`.
 *
 * @param text - Raw user text under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact fact candidates.
 */
export function extractCurrentDirectContactRelationshipFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];

  for (const segment of splitIntoContextSentences(text)) {
    for (const pattern of CURRENT_DIRECT_RELATIONSHIP_PATTERNS) {
      const match = segment.match(pattern);
      const displayName = trimTrailingClausePunctuation(match?.groups?.name ?? "");
      const descriptor = normalizeRelationshipDescriptor(match?.groups?.descriptor ?? "");
      if (!displayName || !descriptor) {
        continue;
      }
      candidates.push(
        ...buildDirectRelationshipCandidates({
          displayName,
          descriptor,
          sourceTaskId,
          observedAt
        })
      );
      break;
    }

    for (const pattern of CURRENT_SYMMETRIC_RELATIONSHIP_PATTERNS) {
      const match = segment.match(pattern);
      const displayName = trimTrailingClausePunctuation(match?.groups?.name ?? "");
      const descriptor = normalizeSymmetricRelationshipDescriptor(
        match?.groups?.descriptor ?? ""
      );
      if (!displayName || !descriptor) {
        continue;
      }
      candidates.push(
        ...buildDirectRelationshipCandidates({
          displayName,
          descriptor,
          sourceTaskId,
          observedAt
        })
      );
      break;
    }
  }

  return candidates;
}
