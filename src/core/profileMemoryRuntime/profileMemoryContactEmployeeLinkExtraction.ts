/**
 * @fileoverview Deterministic employee-direction extraction for named contacts.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  normalizeProfileKey,
  splitIntoContextSentences,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";

const CURRENT_EMPLOYEE_LINK_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) works for me(?: at (?<company>.+))?$/i
] as const;

const HISTORICAL_EMPLOYEE_LINK_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) worked for me(?: at (?<company>.+))?$/i,
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) used to work for me(?: at (?<company>.+))?$/i
] as const;

const SEVERED_EMPLOYEE_LINK_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) no longer works for me(?: at (?<company>.+))?(?: anymore)?$/i,
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) does not work for me(?: at (?<company>.+))?(?: anymore)?$/i,
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) doesn't work for me(?: at (?<company>.+))?(?: anymore)?$/i
] as const;

/**
 * Trims employee-linkage company tails so appositive commentary does not enter the stored value.
 *
 * @param value - Raw company text.
 * @returns Bounded company value.
 */
function trimAssociationValue(value: string): string {
  const trimmed = trimTrailingClausePunctuation(value);
  const commaIndex = trimmed.indexOf(",");
  return commaIndex >= 0 ? trimmed.slice(0, commaIndex).trim() : trimmed;
}

/**
 * Builds one named-contact employee-linkage bundle with a bounded direct-relationship source tag.
 *
 * @param input - Normalized extraction payload.
 * @returns Canonical fact candidates.
 */
function buildEmployeeLinkCandidates(input: {
  displayName: string;
  company: string;
  sourceTaskId: string;
  observedAt: string;
  source:
    | "user_input_pattern.direct_contact_relationship"
    | "user_input_pattern.direct_contact_relationship_historical"
    | "user_input_pattern.direct_contact_relationship_severed";
}): ProfileFactUpsertInput[] {
  const contactToken = normalizeProfileKey(input.displayName);
  if (!contactToken) {
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
      value: "employee",
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
 * Extracts employee-direction named-contact phrasing such as `Owen works for me`,
 * `Owen used to work for me`, and `Owen no longer works for me`.
 *
 * @param text - Raw user text under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact fact candidates.
 */
export function extractNamedContactEmployeeLinkFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];

  for (const segment of splitIntoContextSentences(text)) {
    for (const [patterns, source] of [
      [SEVERED_EMPLOYEE_LINK_PATTERNS, "user_input_pattern.direct_contact_relationship_severed"],
      [HISTORICAL_EMPLOYEE_LINK_PATTERNS, "user_input_pattern.direct_contact_relationship_historical"],
      [CURRENT_EMPLOYEE_LINK_PATTERNS, "user_input_pattern.direct_contact_relationship"]
    ] as const) {
      const match = patterns
        .map((pattern) => segment.match(pattern))
        .find((value) => Boolean(value));
      const displayName = trimTrailingClausePunctuation(match?.groups?.name ?? "");
      if (!displayName) {
        continue;
      }
      const company = trimAssociationValue(match?.groups?.company ?? "");
      candidates.push(
        ...buildEmployeeLinkCandidates({
          displayName,
          company,
          sourceTaskId,
          observedAt,
          source
        })
      );
      break;
    }
  }

  return candidates;
}
