/**
 * @fileoverview Shared helper logic for Stage 6.86 conversation-stack topic/thread processing.
 */

import type {
  ConversationStackV1,
  ThreadFrameV1,
  TopicKeyCandidateV1,
  TopicNodeV1
} from "../types";
import { countLanguageTermOverlap } from "../languageRuntime/languageScoring";
import { extractConversationTopicTerms } from "../languageRuntime/queryIntentTerms";
import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";

export const RETURN_SIGNAL_PATTERN = /\b(?:back|return|resume|continue|pick up)\b/i;
export const DEFAULT_MAX_THREADS = 12;
export const DEFAULT_TOPIC_SWITCH_THRESHOLD = 0.56;
const MAX_TOPIC_KEY_CHARS = 48;
const MAX_RESUME_HINT_CHARS = 180;

const THREAD_STATE_SORT_WEIGHT: Record<ThreadFrameV1["state"], number> = {
  active: 0,
  paused: 1,
  resolved: 2
};

/**
 * Applies deterministic validity checks for valid iso timestamp.
 *
 * @param value - Timestamp candidate to validate.
 * @param fieldName - Field label used in validation error messages.
 */
export function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Normalizes whitespace into a stable shape for conversation-stack logic.
 *
 * @param value - Raw text to normalize.
 * @returns Collapsed-and-trimmed text.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes topic token into a stable shape for conversation-stack logic.
 *
 * @param value - Raw lexical token.
 * @returns Normalized token value.
 */
export function normalizeTopicToken(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Tokenizes topic words for deterministic lexical analysis.
 *
 * @param value - Raw user/assistant text.
 * @returns Ordered collection produced by this step.
 */
export function tokenizeTopicWords(value: string): readonly string[] {
  return extractConversationTopicTerms(value).map((token) => normalizeTopicToken(token));
}

/**
 * Converts values into topic label form for consistent downstream use.
 *
 * @param tokens - Normalized topic tokens.
 * @returns Human-readable topic label.
 */
export function toTopicLabel(tokens: readonly string[]): string {
  return tokens
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

/**
 * Converts values into topic key form for consistent downstream use.
 *
 * @param tokens - Normalized topic tokens.
 * @returns Stable topic key (or hashed fallback when tokens are empty).
 */
export function toTopicKey(tokens: readonly string[]): string {
  const joined = tokens.join("_").slice(0, MAX_TOPIC_KEY_CHARS);
  if (joined.length > 0) {
    return joined;
  }
  const fallbackHash = sha256HexFromCanonicalJson({ tokens });
  return `topic_${fallbackHash.slice(0, 12)}`;
}

/**
 * Builds a deterministic thread key from a stable topic key.
 *
 * @param topicKey - Stable topic key used as the thread identity source.
 * @returns Deterministic thread identifier.
 */
function buildThreadKey(topicKey: string): string {
  const hash = sha256HexFromCanonicalJson({ topicKey });
  return `thread_${hash.slice(0, 20)}`;
}

/**
 * Builds resume hint for this module's runtime flow.
 *
 * @param text - Turn text used to produce a concise resume hint.
 * @returns Bounded hint string for thread resume context.
 */
export function buildResumeHint(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= MAX_RESUME_HINT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_RESUME_HINT_CHARS - 3)}...`;
}

/**
 * Normalizes ordering for topic nodes.
 *
 * @param topics - Topic nodes to sort.
 * @returns Ordered topic collection.
 */
export function sortTopicNodes(topics: readonly TopicNodeV1[]): readonly TopicNodeV1[] {
  return [...topics].sort((left, right) => left.topicKey.localeCompare(right.topicKey));
}

/**
 * Normalizes ordering for thread frames.
 *
 * @param threads - Thread frames to sort.
 * @returns Ordered thread collection.
 */
export function sortThreads(threads: readonly ThreadFrameV1[]): readonly ThreadFrameV1[] {
  return [...threads].sort((left, right) => {
    const stateOrder = THREAD_STATE_SORT_WEIGHT[left.state] - THREAD_STATE_SORT_WEIGHT[right.state];
    if (stateOrder !== 0) {
      return stateOrder;
    }
    if (left.lastTouchedAt !== right.lastTouchedAt) {
      return right.lastTouchedAt.localeCompare(left.lastTouchedAt);
    }
    return left.threadKey.localeCompare(right.threadKey);
  });
}

/**
 * Derives topic confidence from available runtime inputs.
 *
 * @param tokens - Extracted topic tokens.
 * @param sourceText - Source text used for candidate extraction.
 * @returns Numeric result used by downstream logic.
 */
export function computeTopicConfidence(tokens: readonly string[], sourceText: string): number {
  const normalizedLength = normalizeWhitespace(sourceText).length;
  const tokenSignal = Math.min(0.45, tokens.length * 0.17);
  const lengthSignal = Math.min(0.2, normalizedLength / 240);
  return Number(Math.min(0.99, 0.35 + tokenSignal + lengthSignal).toFixed(4));
}

/**
 * Upserts a topic node and increments mention counters for the current turn.
 *
 * @param topicsByKey - Mutable topic map keyed by `topicKey`.
 * @param topicKey - Topic identifier to update or insert.
 * @param topicLabel - Human-readable topic label.
 * @param observedAt - Timestamp for this topic touch event.
 */
export function touchTopicNode(
  topicsByKey: Map<string, TopicNodeV1>,
  topicKey: string,
  topicLabel: string,
  observedAt: string
): void {
  const existing = topicsByKey.get(topicKey);
  if (!existing) {
    topicsByKey.set(topicKey, {
      topicKey,
      label: topicLabel,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      mentionCount: 1
    });
    return;
  }

  topicsByKey.set(topicKey, {
    ...existing,
    label: topicLabel,
    lastSeenAt: observedAt,
    mentionCount: existing.mentionCount + 1
  });
}

/**
 * Parses stored topic labels back into normalized topic tokens.
 *
 * @param label - Human-readable topic label.
 * @returns Normalized topic-token list.
 */
function parseLabelTokens(label: string): readonly string[] {
  return tokenizeTopicWords(label);
}

/**
 * Resolves explicit return thread from available runtime context.
 *
 * @param stack - Current conversation stack state.
 * @param text - Current user turn text.
 * @returns Resolved paused thread, `"AMBIGUOUS"` for multi-match, or `null` when not matched.
 */
export function resolveExplicitReturnThread(
  stack: ConversationStackV1,
  text: string
): ThreadFrameV1 | "AMBIGUOUS" | null {
  if (!RETURN_SIGNAL_PATTERN.test(text)) {
    return null;
  }

  const normalized = normalizeWhitespace(text).toLowerCase();
  const candidates = stack.threads.filter((thread) => thread.state === "paused");
  const matches = candidates.filter((thread) => {
    const labelTokens = parseLabelTokens(thread.topicLabel);
    if (labelTokens.length === 0) {
      return false;
    }
    return countLanguageTermOverlap(labelTokens, tokenizeTopicWords(normalized)) > 0;
  });

  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    return "AMBIGUOUS";
  }
  return null;
}

/**
 * Removes threads over cap according to deterministic lifecycle rules.
 *
 * @param threads - Candidate thread list before cap enforcement.
 * @param activeThreadKey - Active thread to protect from eviction when possible.
 * @param maxThreads - Numeric bound used by this logic.
 * @returns Ordered thread collection after cap enforcement.
 */
export function evictThreadsOverCap(
  threads: readonly ThreadFrameV1[],
  activeThreadKey: string | null,
  maxThreads: number
): readonly ThreadFrameV1[] {
  const cap = Math.max(1, Math.floor(maxThreads));
  if (threads.length <= cap) {
    return sortThreads(threads);
  }

  const retained = [...threads];
  while (retained.length > cap) {
    const evictable = retained
      .filter((thread) => thread.threadKey !== activeThreadKey && thread.state !== "active")
      .sort((left, right) => {
        if (left.lastTouchedAt !== right.lastTouchedAt) {
          return left.lastTouchedAt.localeCompare(right.lastTouchedAt);
        }
        return left.threadKey.localeCompare(right.threadKey);
      });
    const target = evictable[0];
    if (!target) {
      break;
    }
    const index = retained.findIndex((thread) => thread.threadKey === target.threadKey);
    if (index >= 0) {
      retained.splice(index, 1);
    } else {
      break;
    }
  }
  return sortThreads(retained);
}

/**
 * Persists active thread with deterministic state semantics.
 *
 * @param threads - Thread list to update.
 * @param nextActiveThreadKey - Thread key that should become active.
 * @returns Ordered thread collection.
 */
export function setActiveThread(
  threads: readonly ThreadFrameV1[],
  nextActiveThreadKey: string
): readonly ThreadFrameV1[] {
  return sortThreads(
    threads.map((thread) => {
      if (thread.threadKey === nextActiveThreadKey) {
        return {
          ...thread,
          state: thread.state === "resolved" ? "resolved" : "active"
        };
      }
      if (thread.state === "resolved") {
        return thread;
      }
      return {
        ...thread,
        state: "paused"
      };
    })
  );
}

/**
 * Builds thread from a topic candidate.
 *
 * @param candidate - Topic candidate selected for thread creation.
 * @param observedAt - Timestamp for initial thread touch.
 * @param resumeHint - Resume hint text captured from current turn.
 * @returns New active thread frame seeded from topic metadata.
 */
export function buildThreadFromTopicCandidate(
  candidate: TopicKeyCandidateV1,
  observedAt: string,
  resumeHint: string
): ThreadFrameV1 {
  return {
    threadKey: buildThreadKey(candidate.topicKey),
    topicKey: candidate.topicKey,
    topicLabel: candidate.label,
    state: "active",
    resumeHint,
    openLoops: [],
    lastTouchedAt: observedAt
  };
}

/**
 * Clones thread frames into a mutable map keyed by `threadKey`.
 *
 * @param threads - Existing thread array from conversation stack.
 * @returns Thread map copy used for in-turn updates.
 */
export function copyThreadsByKey(
  threads: readonly ThreadFrameV1[]
): Map<string, ThreadFrameV1> {
  return new Map(threads.map((thread) => [thread.threadKey, { ...thread }]));
}
