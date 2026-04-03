/**
 * @fileoverview Deterministic historical self-fact extraction helpers for bounded profile memory.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";

const HISTORICAL_WORK_PREFIXES = [
  "i used to work at ",
  "i used to work for ",
  "i no longer work at ",
  "i no longer work for ",
  "i don't work at ",
  "i don't work for ",
  "i do not work at ",
  "i do not work for ",
  "i quit my job at ",
  "i quit my job for ",
  "i quit working at ",
  "i quit working for ",
  "i worked at ",
  "i worked for "
] as const;
const HISTORICAL_RESIDENCE_PREFIXES = [
  "i used to live in ",
  "i no longer live in ",
  "i don't live in ",
  "i do not live in ",
  "i moved away from "
] as const;
const HEDGED_CONFIDENCE_PATTERNS = ["maybe", "might be", "not sure", "i think", "possibly"];

/**
 * Extracts bounded historical self employment and residence facts that should not be promoted to
 * current flat truth before graph-backed history exists.
 *
 * @param userInput - Raw user utterance under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Historical fact candidates for later truth governance.
 */
export function extractHistoricalProfileFactCandidates(
  userInput: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  const segments = splitHistoricalProfileSegments(userInput);

  const historicalWorkValue = extractFirstContainedPrefixValue(segments, HISTORICAL_WORK_PREFIXES);
  if (historicalWorkValue) {
    candidates.push({
      key: "employment.current",
      value: trimHistoricalValue(historicalWorkValue),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.work_at_historical",
      observedAt,
      confidence: toSentenceConfidence(historicalWorkValue)
    });
  }

  const historicalResidenceValue = extractFirstContainedPrefixValue(
    segments,
    HISTORICAL_RESIDENCE_PREFIXES
  );
  if (historicalResidenceValue) {
    candidates.push({
      key: "residence.current",
      value: trimHistoricalValue(historicalResidenceValue),
      sensitive: true,
      sourceTaskId,
      source: "user_input_pattern.residence_historical",
      observedAt,
      confidence: toSentenceConfidence(historicalResidenceValue)
    });
  }

  return candidates;
}

/**
 * Splits text into bounded explicit-declaration segments for historical self-fact extraction.
 *
 * @param userInput - Raw user wording under analysis.
 * @returns Ordered candidate segments.
 */
function splitHistoricalProfileSegments(userInput: string): readonly string[] {
  const segments: string[] = [];
  let current = "";
  for (let index = 0; index < userInput.length; index += 1) {
    const currentChar = userInput[index]!;
    const nextChar = userInput[index + 1] ?? "";
    const isHardDelimiter = currentChar === "\n" || ".!?;:".includes(currentChar);
    const isCommaDelimiter = currentChar === "," && /\s/.test(nextChar);
    if (isHardDelimiter || isCommaDelimiter) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
      current = "";
      continue;
    }
    current += currentChar;
  }
  const trailing = current.trim();
  if (trailing.length > 0) {
    segments.push(trailing);
  }
  return segments;
}

/**
 * Extracts the first bounded suffix value after any contained lowercase prefix.
 *
 * @param segments - Candidate segments under analysis.
 * @param prefixes - Lowercase prefixes to locate.
 * @returns Raw suffix value, or `null`.
 */
function extractFirstContainedPrefixValue(
  segments: readonly string[],
  prefixes: readonly string[]
): string | null {
  for (const segment of segments) {
    const normalized = segment.trim().toLowerCase();
    for (const prefix of prefixes) {
      const prefixIndex = normalized.indexOf(prefix);
      if (prefixIndex >= 0) {
        return segment.trim().slice(prefixIndex + prefix.length).trim();
      }
    }
  }
  return null;
}

/**
 * Trims one historical value at the first coordinating continuation marker.
 *
 * @param value - Raw clause text.
 * @returns Bounded clause value.
 */
function trimHistoricalValue(value: string): string {
  const normalized = value.toLowerCase();
  let end = value.length;
  for (const marker of [" anymore", " and "]) {
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0 && markerIndex < end) {
      end = markerIndex;
    }
  }
  return value.slice(0, end).trim();
}

/**
 * Builds deterministic confidence scores for extracted historical sentences.
 *
 * @param text - Source sentence or phrase.
 * @returns Confidence score in the `[0, 1]` range.
 */
function toSentenceConfidence(text: string): number {
  const normalized = text.toLowerCase();
  return HEDGED_CONFIDENCE_PATTERNS.some((pattern) => normalized.includes(pattern))
    ? 0.6
    : 0.95;
}
