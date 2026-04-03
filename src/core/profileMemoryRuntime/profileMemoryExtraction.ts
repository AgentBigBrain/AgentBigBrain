/**
 * @fileoverview Deterministic profile-memory candidate extraction from raw user input.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  canonicalizeProfileKey,
  isSensitiveKey,
  normalizeProfileKey,
  normalizeProfileValue
} from "./profileMemoryNormalization";
import { extractNamedContactFacts } from "./profileMemoryContactExtraction";
import {
  extractMyFactMatches,
  extractResolvedFollowupFacts,
  extractSegmentValueAfterContainedPrefix,
  extractSegmentValueAfterPrefix,
  splitExplicitProfileSegments,
  toSentenceConfidence,
  trimAtContinuationMarker
} from "./profileMemoryExtractionSupport";
import { shouldSkipGenericMyFactForNamedContact } from "./profileMemoryGenericFactSuppression";
import {
  buildValidatedProfileFactCandidates,
  looksLikeCommandStylePreferredName,
  trimPreferredNameValue,
  validatePreferredNameCandidateValue
} from "./profileMemoryPreferredNameValidation";
import { extractHistoricalProfileFactCandidates } from "./profileMemoryHistoricalExtraction";
import { extractSeveredNamedContactFacts } from "./profileMemoryContactEndStateExtraction";
import { extractHistoricalDirectContactRelationshipFacts } from "./profileMemoryContactRelationshipHistoryExtraction";
import { extractNamedContactEmployeeLinkFacts } from "./profileMemoryContactEmployeeLinkExtraction";
import { extractCurrentDirectContactRelationshipFacts } from "./profileMemoryContactCurrentRelationshipExtraction";
import { extractNamedContactWorkPeerLinkFacts } from "./profileMemoryContactWorkPeerLinkExtraction";

const EXPLICIT_PREFERRED_NAME_PREFIXES = [
  "my name is ",
  "my name was ",
  "my name = ",
  "call me ",
  "you can call me ",
  "i go by "
] as const;

export {
  buildValidatedProfileFactCandidates,
  validatePreferredNameCandidateValue
} from "./profileMemoryPreferredNameValidation";

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

  for (const contactFactGroup of [
    extractSeveredNamedContactFacts(text, sourceTaskId, observedAt),
    extractHistoricalDirectContactRelationshipFacts(text, sourceTaskId, observedAt),
    extractNamedContactEmployeeLinkFacts(text, sourceTaskId, observedAt),
    extractNamedContactWorkPeerLinkFacts(text, sourceTaskId, observedAt),
    extractCurrentDirectContactRelationshipFacts(text, sourceTaskId, observedAt),
    extractNamedContactFacts(text, sourceTaskId, observedAt)
  ]) {
    for (const contactFact of contactFactGroup) {
      maybeAddCandidate(contactFact);
    }
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
    if (shouldSkipGenericMyFactForNamedContact(rawKey, value, seen)) {
      continue;
    }
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

  const historicalFactCandidates = extractHistoricalProfileFactCandidates(text, sourceTaskId, observedAt);
  for (const historicalFactCandidate of historicalFactCandidates) {
    maybeAddCandidate(historicalFactCandidate);
  }

  return candidates;
}
