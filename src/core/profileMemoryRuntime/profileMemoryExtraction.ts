/**
 * @fileoverview Deterministic profile-memory candidate extraction from raw user input.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  canonicalizeProfileKey,
  isSensitiveKey,
  normalizeProfileKey,
  normalizeProfileValue,
  normalizeResolutionTopicKey
} from "./profileMemoryNormalization";
import { extractNamedContactFacts } from "./profileMemoryContactExtraction";
import {
  buildValidatedProfileFactCandidates,
  looksLikeCommandStylePreferredName,
  trimPreferredNameValue,
  validatePreferredNameCandidateValue
} from "./profileMemoryPreferredNameValidation";

const EXPLICIT_PREFERRED_NAME_PREFIXES = [
  "my name is ",
  "my name was ",
  "my name = ",
  "call me ",
  "you can call me ",
  "i go by "
] as const;
const FOLLOWUP_RESOLUTION_PREFIXES = [
  "i no longer need help with ",
  "we no longer need help with ",
  "i do not need help with ",
  "we do not need help with ",
  "i don't need help with ",
  "we don't need help with ",
  "i'm all set with ",
  "i am all set with ",
  "we are all set with "
] as const;
const NOTIFICATION_RESOLUTION_PREFIXES = [
  "turn off notifications for ",
  "turn off notifications about ",
  "turn off the notifications for ",
  "turn off the notifications about ",
  "turn off reminders for ",
  "turn off reminders about ",
  "stop notifications for ",
  "stop notifications about ",
  "stop reminders for ",
  "stop reminders about ",
  "disable notifications for ",
  "disable notifications about ",
  "disable reminders for ",
  "disable reminders about "
] as const;

export {
  buildValidatedProfileFactCandidates,
  validatePreferredNameCandidateValue
} from "./profileMemoryPreferredNameValidation";

/**
 * Splits raw user text into bounded explicit-declaration segments before regex fast-path extraction.
 *
 * @param userInput - Raw user wording under analysis.
 * @returns Ordered candidate segments that can independently hold explicit profile statements.
 */
function splitExplicitProfileSegments(userInput: string): readonly string[] {
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
 * Extracts a suffix value when one segment starts with any explicit prefix.
 *
 * @param segment - Segment under analysis.
 * @param prefixes - Lowercase prefixes to match.
 * @returns Raw suffix value, or `null`.
 */
function extractSegmentValueAfterPrefix(
  segment: string,
  prefixes: readonly string[]
): string | null {
  const normalized = segment.trim().toLowerCase();
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      return segment.trim().slice(prefix.length).trim();
    }
  }
  return null;
}

/**
 * Extracts a suffix value when one segment contains any explicit prefix later in the sentence.
 *
 * @param segment - Segment under analysis.
 * @param prefixes - Lowercase prefixes to locate.
 * @returns Raw suffix value, or `null`.
 */
function extractSegmentValueAfterContainedPrefix(
  segment: string,
  prefixes: readonly string[]
): string | null {
  const normalized = segment.trim().toLowerCase();
  for (const prefix of prefixes) {
    const prefixIndex = normalized.indexOf(prefix);
    if (prefixIndex >= 0) {
      return segment.trim().slice(prefixIndex + prefix.length).trim();
    }
  }
  return null;
}

/**
 * Trims one clause at the first coordinating continuation marker.
 *
 * @param value - Raw clause text.
 * @param markers - Ordered continuation markers.
 * @returns Bounded clause value.
 */
function trimAtContinuationMarker(value: string, markers: readonly string[]): string {
  const normalized = value.toLowerCase();
  let end = value.length;
  for (const marker of markers) {
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0 && markerIndex < end) {
      end = markerIndex;
    }
  }
  return value.slice(0, end).trim();
}

/**
 * Extracts bounded `my <key> is <value>` facts without backtracking-heavy regex.
 *
 * @param text - Raw user text under analysis.
 * @returns Ordered key/value matches.
 */
function extractMyFactMatches(text: string): Array<{ key: string; value: string; sourceText: string }> {
  const matches: Array<{ key: string; value: string; sourceText: string }> = [];
  const normalized = text.toLowerCase();
  let searchIndex = 0;
  while (searchIndex < normalized.length) {
    const myIndex = normalized.indexOf("my ", searchIndex);
    if (myIndex < 0) {
      break;
    }
    const isIndex = normalized.indexOf(" is ", myIndex + 3);
    if (isIndex < 0) {
      break;
    }
    const rawKey = text.slice(myIndex + 3, isIndex).trim();
    if (!/^[a-z][a-z0-9 _.'/-]{1,80}$/i.test(rawKey)) {
      searchIndex = myIndex + 3;
      continue;
    }
    const valueStart = isIndex + 4;
    let valueEnd = text.length;
    for (const marker of [" and my ", "\n", ".", "!", "?"]) {
      const markerIndex = normalized.indexOf(marker, valueStart);
      if (markerIndex >= 0 && markerIndex < valueEnd) {
        valueEnd = markerIndex;
      }
    }
    const value = text.slice(valueStart, valueEnd).trim();
    if (value.length > 0) {
      matches.push({
        key: rawKey,
        value,
        sourceText: text.slice(myIndex, valueEnd).trim()
      });
    }
    searchIndex = valueStart;
  }
  return matches;
}

/**
 * Extracts canonical preferred-name values from raw user wording.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns Deduplicated preferred-name values in extraction priority order.
 */
export function extractPreferredNameValuesFromUserInput(
  userInput: string
): readonly string[] {
  const text = userInput.trim();
  if (!text) {
    return [];
  }

  const preferredNames: string[] = [];
  const seen = new Set<string>();
  const maybeAddPreferredName = (value: string): void => {
    const normalizedValue = normalizeProfileValue(value);
    if (!normalizedValue || seen.has(normalizedValue)) {
      return;
    }
    seen.add(normalizedValue);
    preferredNames.push(normalizedValue);
  };

  for (const segment of splitExplicitProfileSegments(text)) {
    const preferredNameValue = extractSegmentValueAfterPrefix(
      segment,
      EXPLICIT_PREFERRED_NAME_PREFIXES
    );
    if (!preferredNameValue) {
      continue;
    }
    const preferredName = trimPreferredNameValue(preferredNameValue);
    if (
      segment.trim().toLowerCase().includes("call me ") &&
      looksLikeCommandStylePreferredName(preferredName)
    ) {
      continue;
    }
    maybeAddPreferredName(preferredName);
  }

  return preferredNames;
}

/**
 * Extracts deterministic profile-fact candidates from raw user text.
 *
 * @param userInput - Raw user utterance or wrapped execution input text.
 * @param sourceTaskId - Task id used for traceability on extracted facts.
 * @param observedAt - Observation timestamp applied to extracted candidates.
 * @returns Deduplicated fact candidates ready for upsert/reconciliation.
 */
export function extractProfileFactCandidatesFromUserInput(
  userInput: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  const seen = new Set<string>();
  const text = userInput.trim();
  if (!text) {
    return candidates;
  }

  const maybeAddCandidate = (candidate: ProfileFactUpsertInput): void => {
    const normalizedKey = canonicalizeProfileKey(candidate.key);
    const normalizedValue = normalizeProfileValue(candidate.value);
    if (!normalizedKey || !normalizedValue) {
      return;
    }
    const signature = `${normalizedKey}=${normalizedValue}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    candidates.push({
      ...candidate,
      key: normalizedKey,
      value: normalizedValue,
      sensitive: candidate.sensitive || isSensitiveKey(normalizedKey)
    });
  };

  const namedContactFacts = extractNamedContactFacts(text, sourceTaskId, observedAt);
  for (const namedContactFact of namedContactFacts) {
    maybeAddCandidate(namedContactFact);
  }

  const resolvedFollowupFacts = extractResolvedFollowupFacts(text, sourceTaskId, observedAt);
  for (const resolvedFollowupFact of resolvedFollowupFacts) {
    maybeAddCandidate(resolvedFollowupFact);
  }

  const preferredNameValues = extractPreferredNameValuesFromUserInput(text);
  if (preferredNameValues.length > 0) {
    maybeAddCandidate({
      key: "identity.preferred_name",
      value: preferredNameValues[0]!,
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.name_phrase",
      observedAt,
      confidence: 0.95
    });
  }

  for (const match of extractMyFactMatches(text)) {
    const rawKey = match.key;
    const value = match.value;
    const key = normalizeProfileKey(rawKey);
    if (canonicalizeProfileKey(key) === "identity.preferred_name") {
      continue;
    }
    maybeAddCandidate({
      key,
      value,
      sensitive: isSensitiveKey(key),
      sourceTaskId,
      source: "user_input_pattern.my_is",
      observedAt,
      confidence: toSentenceConfidence(match.sourceText)
    });
  }

  const workValue = splitExplicitProfileSegments(text)
    .map((segment) =>
      extractSegmentValueAfterContainedPrefix(segment, ["i work at ", "i work for "])
    )
    .find((value) => Boolean(value));
  if (workValue) {
    maybeAddCandidate({
      key: "employment.current",
      value: trimAtContinuationMarker(workValue, [" and "]),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.work_at",
      observedAt,
      confidence: toSentenceConfidence(workValue)
    });
  }

  const jobValue = splitExplicitProfileSegments(text)
    .map((segment) =>
      extractSegmentValueAfterContainedPrefix(segment, ["my job is ", "my new job is "])
    )
    .find((value) => Boolean(value));
  if (jobValue) {
    maybeAddCandidate({
      key: "employment.current",
      value: trimAtContinuationMarker(jobValue, [" and "]),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.job_is",
      observedAt,
      confidence: toSentenceConfidence(jobValue)
    });
  }

  const residenceValue = splitExplicitProfileSegments(text)
    .map((segment) =>
      extractSegmentValueAfterContainedPrefix(segment, ["i live in ", "i moved to "])
    )
    .find((value) => Boolean(value));
  if (residenceValue) {
    maybeAddCandidate({
      key: "residence.current",
      value: trimAtContinuationMarker(residenceValue, [" and "]),
      sensitive: true,
      sourceTaskId,
      source: "user_input_pattern.residence",
      observedAt,
      confidence: toSentenceConfidence(residenceValue)
    });
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
  return normalized.includes("maybe") ||
    normalized.includes("might be") ||
    normalized.includes("not sure") ||
    normalized.includes("i think") ||
    normalized.includes("possibly")
    ? 0.6
    : 0.95;
}

/**
 * Extracts resolved follow-up facts from natural completion phrasing.
 *
 * @param text - Raw user text under analysis.
 * @param sourceTaskId - Task id used to attribute extracted facts.
 * @param observedAt - Observation timestamp applied to extracted facts.
 * @returns Follow-up resolution candidates.
 */
function extractResolvedFollowupFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  for (const segment of splitExplicitProfileSegments(text)) {
    const resolutionValue =
      extractSegmentValueAfterPrefix(segment, FOLLOWUP_RESOLUTION_PREFIXES) ??
      extractSegmentValueAfterPrefix(segment, NOTIFICATION_RESOLUTION_PREFIXES);
    if (!resolutionValue) {
      continue;
    }
    const topicKey = normalizeResolutionTopicKey(
      trimAtContinuationMarker(resolutionValue, [" anymore", " and "])
    );
    if (!topicKey) {
      continue;
    }
    candidates.push({
      key: `followup.${topicKey}`,
      value: "resolved",
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.followup_resolved",
      observedAt,
      confidence: toSentenceConfidence(segment)
    });
  }

  return candidates;
}
