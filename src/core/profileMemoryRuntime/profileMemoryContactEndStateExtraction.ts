/**
 * @fileoverview Deterministic end-state extraction for named contact work-linkage phrasing.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  normalizeProfileKey,
  splitIntoContextSentences,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";

const WORK_WITH_CONTACT_SEVERED_PREFIXES = [
  "i no longer work with ",
  "i do not work with ",
  "i don't work with "
] as const;

const WORK_TOGETHER_CONTACT_SEVERED_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) and i (?<ending>no longer|do not|don't) work together(?: anymore)?$/i,
  /^i (?<ending>no longer|do not|don't) work together with (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: anymore)?$/i
] as const;

/**
 * Trims punctuation and conversational `anymore` tails from explicit severed-linkage clauses.
 *
 * @param value - Raw clause text.
 * @returns Bounded clause value suitable for name or association extraction.
 */
function trimEndStateClauseValue(value: string): string {
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
 * Builds one bounded contact-name plus work-linkage candidate bundle for a severed relationship.
 *
 * @param input - Normalized contact payload.
 * @returns Canonical fact candidates carrying the severed work-linkage source tag.
 */
function buildWorkWithContactSeveredCandidates(input: {
  displayName: string;
  company: string;
  sourceTaskId: string;
  observedAt: string;
}): ProfileFactUpsertInput[] {
  const contactToken = normalizeProfileKey(input.displayName);
  if (!contactToken) {
    return [];
  }
  const confidence = 0.95;
  const candidates: ProfileFactUpsertInput[] = [
    {
      key: `contact.${contactToken}.name`,
      value: input.displayName,
      sensitive: false,
      sourceTaskId: input.sourceTaskId,
      source: "user_input_pattern.work_with_contact_severed",
      observedAt: input.observedAt,
      confidence
    },
    {
      key: `contact.${contactToken}.relationship`,
      value: "work_peer",
      sensitive: false,
      sourceTaskId: input.sourceTaskId,
      source: "user_input_pattern.work_with_contact_severed",
      observedAt: input.observedAt,
      confidence
    }
  ];
  if (input.company) {
    candidates.push({
      key: `contact.${contactToken}.work_association`,
      value: input.company,
      sensitive: false,
      sourceTaskId: input.sourceTaskId,
      source: "user_input_pattern.work_with_contact_severed",
      observedAt: input.observedAt,
      confidence
    });
  }
  return candidates;
}

/**
 * Extracts named-contact work-linkage endings such as `I don't work with Owen anymore.` into
 * bounded support-only candidates that can later become explicit end-state markers.
 *
 * @param text - Raw user text under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact fact candidates for severed work-linkage phrasing.
 */
export function extractSeveredNamedContactFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];

  for (const segment of splitIntoContextSentences(text)) {
    const normalizedSegment = segment.toLowerCase();
    const severedPrefix = WORK_WITH_CONTACT_SEVERED_PREFIXES.find((prefix) =>
      normalizedSegment.startsWith(prefix)
    );
    if (severedPrefix) {
      const remainder = trimEndStateClauseValue(segment.slice(severedPrefix.length).trim());
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
      const displayName = trimEndStateClauseValue(
        associationIndex >= 0 ? remainder.slice(0, associationIndex) : remainder
      );
      const company = trimEndStateClauseValue(
        associationIndex >= 0 ? remainder.slice(associationIndex + 4) : ""
      );
      candidates.push(
        ...buildWorkWithContactSeveredCandidates({
          displayName,
          company,
          sourceTaskId,
          observedAt
        })
      );
      continue;
    }

    for (const pattern of WORK_TOGETHER_CONTACT_SEVERED_PATTERNS) {
      const match = segment.match(pattern);
      const displayName = trimEndStateClauseValue(match?.groups?.name ?? "");
      if (!displayName) {
        continue;
      }
      candidates.push(
        ...buildWorkWithContactSeveredCandidates({
          displayName,
          company: "",
          sourceTaskId,
          observedAt
        })
      );
      break;
    }
  }

  return candidates;
}
