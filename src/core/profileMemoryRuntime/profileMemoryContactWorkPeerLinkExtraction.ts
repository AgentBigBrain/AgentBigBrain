/**
 * @fileoverview Deterministic work-peer linkage extraction for named contacts phrased as
 * `Owen works with me`.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  normalizeProfileKey,
  splitIntoContextSentences,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";
import {
  sanitizeCapturedContactDisplayName,
  trimAssociationValue
} from "./profileMemoryContactExtractionSupport";

const CURRENT_WORK_PEER_LINK_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) works with me(?: (?<prep>at|for) (?<company>.+))?$/i,
  /^i work with (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: (?<prep>at|for) (?<company>.+))?$/i
] as const;

const HISTORICAL_WORK_PEER_LINK_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) worked with me(?: (?<prep>at|for) (?<company>.+))?$/i,
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) used to work with me(?: (?<prep>at|for) (?<company>.+))?$/i,
  /^i worked with (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: (?<prep>at|for) (?<company>.+))?$/i,
  /^i used to work with (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: (?<prep>at|for) (?<company>.+))?$/i
] as const;

const SEVERED_WORK_PEER_LINK_PATTERNS = [
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) no longer works with me(?: (?<prep>at|for) (?<company>.+))?(?: anymore)?$/i,
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) does not work with me(?: (?<prep>at|for) (?<company>.+))?(?: anymore)?$/i,
  /^(?<name>[A-Za-z][A-Za-z' -]{1,40}) doesn't work with me(?: (?<prep>at|for) (?<company>.+))?(?: anymore)?$/i,
  /^i no longer work with (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: (?<prep>at|for) (?<company>.+))?(?: anymore)?$/i,
  /^i do not work with (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: (?<prep>at|for) (?<company>.+))?(?: anymore)?$/i,
  /^i don't work with (?<name>[A-Za-z][A-Za-z' -]{1,40})(?: (?<prep>at|for) (?<company>.+))?(?: anymore)?$/i
] as const;

/**
 * Builds one named-contact work-peer linkage bundle using the existing governed work-linkage
 * source family.
 *
 * @param input - Normalized extraction payload.
 * @returns Canonical fact candidates.
 */
function buildWorkPeerLinkCandidates(input: {
  displayName: string;
  company: string;
  sourceTaskId: string;
  observedAt: string;
  source:
    | "user_input_pattern.work_with_contact"
    | "user_input_pattern.work_with_contact_historical"
    | "user_input_pattern.work_with_contact_severed";
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
      value: "work_peer",
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
 * Extracts named-contact work-peer phrasing such as `Owen works with me`,
 * `Owen worked with me`, and `Owen no longer works with me`.
 *
 * @param text - Raw user text under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Contact fact candidates.
 */
export function extractNamedContactWorkPeerLinkFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];

  for (const segment of splitIntoContextSentences(text)) {
    for (const [patterns, source] of [
      [SEVERED_WORK_PEER_LINK_PATTERNS, "user_input_pattern.work_with_contact_severed"],
      [HISTORICAL_WORK_PEER_LINK_PATTERNS, "user_input_pattern.work_with_contact_historical"],
      [CURRENT_WORK_PEER_LINK_PATTERNS, "user_input_pattern.work_with_contact"]
    ] as const) {
      const match = patterns
        .map((pattern) => segment.match(pattern))
        .find((value) => Boolean(value));
      const rawDisplayName = trimTrailingClausePunctuation(match?.groups?.name ?? "");
      const displayName = sanitizeCapturedContactDisplayName(rawDisplayName);
      if (!displayName || rawDisplayName !== displayName) {
        continue;
      }
      const company = trimAssociationValue(match?.groups?.company ?? "");
      candidates.push(
        ...buildWorkPeerLinkCandidates({
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
