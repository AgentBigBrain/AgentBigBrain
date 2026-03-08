/**
 * @fileoverview Topic extraction and matching helpers for unresolved profile-memory commitments.
 */

import { type ProfileFactRecord, type ProfileMemoryState } from "../profileMemory";
import {
  isActiveFact,
  valueIndicatesResolvedCommitmentMarker
} from "./profileMemoryCommitmentSignals";

/**
 * Evaluates whether a profile fact represents an unresolved commitment.
 *
 * @param fact - Profile fact under evaluation.
 * @returns `true` when the fact is an active unresolved commitment.
 */
export function isUnresolvedCommitmentFact(fact: ProfileFactRecord): boolean {
  if (!isActiveFact(fact)) {
    return false;
  }

  const key = fact.key.trim().toLowerCase();
  const unresolvedKeyPattern =
    /^(?:commitment|todo|task)(?:\.|$)|^follow(?:\.|)up[a-z0-9]*(?:\.|$)/;
  const unresolvedKey =
    key.startsWith("commitment.") ||
    key.startsWith("todo.") ||
    key.startsWith("followup.") ||
    unresolvedKeyPattern.test(key);
  if (!unresolvedKey) {
    return false;
  }

  return !valueIndicatesResolvedCommitmentMarker(fact.value);
}

/**
 * Returns unresolved commitment facts ordered by recency.
 *
 * @param state - Loaded profile-memory state.
 * @returns Ordered unresolved commitment facts.
 */
export function listUnresolvedCommitmentFacts(
  state: ProfileMemoryState
): ProfileFactRecord[] {
  return state.facts
    .filter((fact) => isUnresolvedCommitmentFact(fact))
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));
}

/**
 * Normalizes commitment topic text for matching.
 *
 * @param value - Topic candidate text.
 * @returns Normalized topic text.
 */
export function normalizeCommitmentTopicText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derives a commitment topic from a fact key.
 *
 * @param key - Profile fact key.
 * @returns Normalized topic or `null`.
 */
export function topicFromCommitmentKey(key: string): string | null {
  const normalized = key.trim().toLowerCase();
  const followupPrefixed = normalized.match(/^follow(?:\.|)up[a-z0-9]*\.(.+)$/);
  if (followupPrefixed) {
    const topic = normalizeCommitmentTopicText(followupPrefixed[1]);
    return topic || null;
  }

  const genericPrefixed = normalized.match(/^(?:todo|task|commitment)\.(.+)$/);
  if (!genericPrefixed) {
    return null;
  }

  const topic = normalizeCommitmentTopicText(genericPrefixed[1]);
  if (!topic || topic === "item" || topic === "current" || topic === "status") {
    return null;
  }
  return topic;
}

/**
 * Derives a commitment topic from a fact value.
 *
 * @param value - Profile fact value.
 * @returns Normalized topic or `null`.
 */
export function topicFromCommitmentValue(value: string): string | null {
  const normalized = normalizeCommitmentTopicText(value);
  if (!normalized || looksLikeSensitiveTopicText(normalized)) {
    return null;
  }
  const words = normalized.split(" ").filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  return words.slice(0, 6).join(" ");
}

/**
 * Evaluates whether two normalized topics likely refer to the same commitment.
 *
 * @param sourceTopic - Source topic text.
 * @param targetTopic - Target topic text.
 * @returns `true` when the topics likely match.
 */
export function topicsLikelyMatch(sourceTopic: string, targetTopic: string): boolean {
  const sourceTokens = extractTopicTokens(sourceTopic);
  const targetTokens = extractTopicTokens(targetTopic);
  if (sourceTokens.length === 0 || targetTokens.length === 0) {
    return false;
  }

  const sourceSet = new Set(sourceTokens);
  const targetSet = new Set(targetTokens);
  const sourceSubset = sourceTokens.every((token) => targetSet.has(token));
  const targetSubset = targetTokens.every((token) => sourceSet.has(token));
  return sourceSubset || targetSubset;
}

/**
 * Evaluates whether a topic text looks sensitive enough to avoid topic matching.
 *
 * @param value - Topic candidate text.
 * @returns `true` when the topic likely contains sensitive text.
 */
function looksLikeSensitiveTopicText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(normalized)) {
    return true;
  }
  if (/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Tokenizes normalized topic text for subset matching.
 *
 * @param topic - Topic text to tokenize.
 * @returns Topic tokens.
 */
function extractTopicTokens(topic: string): string[] {
  return normalizeCommitmentTopicText(topic)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
