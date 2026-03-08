/**
 * @fileoverview Deterministic profile-memory candidate extraction from raw user input.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import {
  canonicalizeProfileKey, isSensitiveKey, normalizeProfileKey, normalizeProfileValue,
  normalizeResolutionTopicKey, trimTrailingClausePunctuation
} from "./profileMemoryNormalization";
import { extractNamedContactFacts } from "./profileMemoryContactExtraction";

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

  const resolvedFollowupFacts = extractResolvedFollowupFacts(
    text,
    sourceTaskId,
    observedAt
  );
  for (const resolvedFollowupFact of resolvedFollowupFacts) {
    maybeAddCandidate(resolvedFollowupFact);
  }

  const namePattern =
    /\bmy\s+name\s+(?:is|was|=)\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const nameMatch = namePattern.exec(text);
  if (nameMatch) {
    maybeAddCandidate({
      key: "identity.preferred_name",
      value: trimTrailingClausePunctuation(nameMatch[1]),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.name_phrase",
      observedAt,
      confidence: toSentenceConfidence(nameMatch[0])
    });
  }

  const callMePattern =
    /\b(?:you\s+can\s+)?call\s+me\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const callMeMatch = callMePattern.exec(text);
  if (callMeMatch) {
    maybeAddCandidate({
      key: "identity.preferred_name",
      value: trimTrailingClausePunctuation(callMeMatch[1]),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.call_me",
      observedAt,
      confidence: toSentenceConfidence(callMeMatch[0])
    });
  }

  const goByPattern =
    /\bi\s+go\s+by\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const goByMatch = goByPattern.exec(text);
  if (goByMatch) {
    maybeAddCandidate({
      key: "identity.preferred_name",
      value: trimTrailingClausePunctuation(goByMatch[1]),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.go_by",
      observedAt,
      confidence: toSentenceConfidence(goByMatch[0])
    });
  }

  const myFactPattern =
    /\bmy\s+([a-z][a-z0-9 _.'/-]{1,80}?)\s+is\s+([^.!?\n]+?)(?=(?:\s+and\s+my\s+[a-z])|[.!?\n]|$)/gi;
  for (const match of text.matchAll(myFactPattern)) {
    const rawKey = match[1];
    const value = match[2];
    const key = normalizeProfileKey(rawKey);
    maybeAddCandidate({
      key,
      value,
      sensitive: isSensitiveKey(key),
      sourceTaskId,
      source: "user_input_pattern.my_is",
      observedAt,
      confidence: toSentenceConfidence(match[0])
    });
  }

  const workPattern =
    /\bi\s+work\s+(?:at|for)\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const workMatch = workPattern.exec(text);
  if (workMatch) {
    maybeAddCandidate({
      key: "employment.current",
      value: workMatch[1],
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.work_at",
      observedAt,
      confidence: toSentenceConfidence(workMatch[0])
    });
  }

  const jobPattern =
    /\bmy\s+(?:new\s+)?job\s+is\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const jobMatch = jobPattern.exec(text);
  if (jobMatch) {
    maybeAddCandidate({
      key: "employment.current",
      value: jobMatch[1],
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.job_is",
      observedAt,
      confidence: toSentenceConfidence(jobMatch[0])
    });
  }

  const residencePattern =
    /\bi\s+(?:live in|moved to)\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const residenceMatch = residencePattern.exec(text);
  if (residenceMatch) {
    maybeAddCandidate({
      key: "residence.current",
      value: residenceMatch[1],
      sensitive: true,
      sourceTaskId,
      source: "user_input_pattern.residence",
      observedAt,
      confidence: toSentenceConfidence(residenceMatch[0])
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
  const resolutionPatterns = [
    /\b(?:i|we)\s+(?:no\s+longer\s+need\s+help\s+with|do\s+not\s+need\s+help\s+with|don't\s+need\s+help\s+with|am\s+all\s+set\s+with|are\s+all\s+set\s+with)\s+([^.!?\n]+?)(?=(?:\s+anymore\b)?(?:[.!?\n]|$))/gi,
    /\b(?:turn\s+off|stop|disable)\s+(?:the\s+)?(?:notifications?|reminders?)\s+(?:for|about)\s+([^.!?\n]+?)(?=(?:\s+anymore\b)?(?:[.!?\n]|$))/gi
  ];

  for (const pattern of resolutionPatterns) {
    for (const match of text.matchAll(pattern)) {
      const rawTopic = trimTrailingClausePunctuation(match[1] ?? "");
      const topicKey = normalizeResolutionTopicKey(rawTopic);
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
        confidence: toSentenceConfidence(match[0])
      });
    }
  }

  return candidates;
}
