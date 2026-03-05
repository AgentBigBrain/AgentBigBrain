/**
 * @fileoverview Deterministic Stage 6.86 conversation-stack and topic-thread helpers for checkpoint 6.86.C.
 */

import {
  ConversationStackV1,
  OpenLoopV1,
  SessionSchemaVersionV1,
  ThreadFrameV1,
  TopicKeyCandidateV1,
  TopicNodeV1
} from "./types";
import { sha256HexFromCanonicalJson } from "./normalizers/canonicalizationRules";

const TOPIC_TOKEN_PATTERN = /[a-z0-9]+/g;
const TOPIC_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "let",
  "lets",
  "discuss",
  "now",
  "also",
  "go",
  "back",
  "there",
  "here",
  "thread",
  "topic",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "have",
  "your",
  "you",
  "about",
  "into",
  "just",
  "when",
  "where",
  "what",
  "which",
  "will",
  "would",
  "could",
  "should",
  "please",
  "show",
  "tell",
  "need",
  "next",
  "week",
  "today",
  "tomorrow",
  "yesterday",
  "chat",
  "bigbrain",
  "agentbigbrain"
]);
const RETURN_SIGNAL_PATTERN = /\b(?:back|return|resume|continue|pick up)\b/i;
const MIN_TOPIC_TOKEN_LENGTH = 3;
const DEFAULT_MAX_THREADS = 12;
const DEFAULT_TOPIC_SWITCH_THRESHOLD = 0.56;
const MAX_TOPIC_KEY_CHARS = 48;
const MAX_RESUME_HINT_CHARS = 180;

const THREAD_STATE_SORT_WEIGHT: Record<ThreadFrameV1["state"], number> = {
  active: 0,
  paused: 1,
  resolved: 2
};

export interface ConversationStackTurnV1 {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface ApplyConversationTurnOptionsV1 {
  activeMissionThreadKey?: string | null;
  maxThreads?: number;
  topicSwitchThreshold?: number;
}

export interface ConversationStackMigrationInputV1 {
  sessionSchemaVersion: SessionSchemaVersionV1 | null;
  updatedAt: string;
  conversationTurns: readonly ConversationStackTurnV1[];
  conversationStack: ConversationStackV1 | null;
  activeMissionThreadKey?: string | null;
  maxThreads?: number;
}

export interface ConversationStackMigrationResultV1 {
  sessionSchemaVersion: "v2";
  conversationStack: ConversationStackV1;
  migrationApplied: boolean;
  migrationReason: "ALREADY_V2" | "REFRESHED_FROM_TURNS" | "LEGACY_SCHEMA" | "MISSING_STACK";
}

/**
 * Applies deterministic validity checks for valid iso timestamp.
 *
 * **Why it exists:**
 * Fails fast when valid iso timestamp is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - `Date.parse` for ISO timestamp validation.
 *
 * @param value - Timestamp candidate to validate.
 * @param fieldName - Field label used in validation error messages.
 */
function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Normalizes whitespace into a stable shape for `stage6_86ConversationStack` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
 *
 * **What it talks to:**
 * - Local regex-based text normalization only.
 *
 * @param value - Raw text to normalize.
 * @returns Collapsed-and-trimmed text.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes topic token into a stable shape for `stage6_86ConversationStack` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for topic token so call sites stay aligned.
 *
 * **What it talks to:**
 * - Local lowercase/trim token cleanup.
 *
 * @param value - Raw lexical token.
 * @returns Normalized token value.
 */
function normalizeTopicToken(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Tokenizes topic words for deterministic lexical analysis.
 *
 * **Why it exists:**
 * Keeps `tokenize topic words` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Local token regex and stop-word/min-length filters.
 *
 * @param value - Raw user/assistant text.
 * @returns Ordered collection produced by this step.
 */
function tokenizeTopicWords(value: string): readonly string[] {
  const tokens = normalizeWhitespace(value).toLowerCase().match(TOPIC_TOKEN_PATTERN) ?? [];
  const uniqueTokens = new Set<string>();
  for (const token of tokens) {
    const normalized = normalizeTopicToken(token);
    if (
      normalized.length < MIN_TOPIC_TOKEN_LENGTH ||
      TOPIC_STOP_WORDS.has(normalized)
    ) {
      continue;
    }
    uniqueTokens.add(normalized);
  }
  return [...uniqueTokens];
}

/**
 * Converts values into topic label form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for topic label deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Local title-case formatting over normalized tokens.
 *
 * @param tokens - Normalized topic tokens.
 * @returns Human-readable topic label.
 */
function toTopicLabel(tokens: readonly string[]): string {
  return tokens
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

/**
 * Converts values into topic key form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for topic key deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 *
 * @param tokens - Normalized topic tokens.
 * @returns Stable topic key (or hashed fallback when tokens are empty).
 */
function toTopicKey(tokens: readonly string[]): string {
  const joined = tokens.join("_").slice(0, MAX_TOPIC_KEY_CHARS);
  if (joined.length > 0) {
    return joined;
  }
  const fallbackHash = sha256HexFromCanonicalJson({ tokens });
  return `topic_${fallbackHash.slice(0, 12)}`;
}

/**
 * Builds thread key for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of thread key consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 *
 * @param topicKey - Stable topic key backing the thread.
 * @returns Deterministic thread key derived from topic hash.
 */
function buildThreadKey(topicKey: string): string {
  const hash = sha256HexFromCanonicalJson({ topicKey });
  return `thread_${hash.slice(0, 20)}`;
}

/**
 * Builds resume hint for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of resume hint consistent across call sites.
 *
 * **What it talks to:**
 * - `normalizeWhitespace` and fixed max-length clipping.
 *
 * @param text - Turn text used to produce a concise resume hint.
 * @returns Bounded hint string for thread resume context.
 */
function buildResumeHint(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= MAX_RESUME_HINT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_RESUME_HINT_CHARS - 3)}...`;
}

/**
 * Normalizes ordering and duplication for topic nodes.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for topic nodes in one place.
 *
 * **What it talks to:**
 * - Uses `TopicNodeV1` (import `TopicNodeV1`) from `./types`.
 *
 * @param topics - Topic nodes to sort.
 * @returns Ordered collection produced by this step.
 */
function sortTopicNodes(topics: readonly TopicNodeV1[]): readonly TopicNodeV1[] {
  return [...topics].sort((left, right) => left.topicKey.localeCompare(right.topicKey));
}

/**
 * Normalizes ordering and duplication for threads.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for threads in one place.
 *
 * **What it talks to:**
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 *
 * @param threads - Thread frames to sort by lifecycle/recency.
 * @returns Ordered collection produced by this step.
 */
function sortThreads(threads: readonly ThreadFrameV1[]): readonly ThreadFrameV1[] {
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
 * **Why it exists:**
 * Keeps derivation logic for topic confidence in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Local token-count and text-length heuristics.
 *
 * @param tokens - Extracted topic tokens.
 * @param sourceText - Source text used for candidate extraction.
 * @returns Numeric result used by downstream logic.
 */
function computeTopicConfidence(tokens: readonly string[], sourceText: string): number {
  const normalizedLength = normalizeWhitespace(sourceText).length;
  const tokenSignal = Math.min(0.45, tokens.length * 0.17);
  const lengthSignal = Math.min(0.2, normalizedLength / 240);
  return Number(Math.min(0.99, 0.35 + tokenSignal + lengthSignal).toFixed(4));
}

/**
 * Upserts a topic node and increments mention counters for the current turn.
 *
 * **Why it exists:**
 * Conversation-stack updates should keep topic first/last-seen timestamps and mention counts in sync.
 *
 * **What it talks to:**
 * - `Map<string, TopicNodeV1>` topic index for in-place updates.
 *
 * @param topicsByKey - Mutable topic map keyed by `topicKey`.
 * @param topicKey - Topic identifier to update or insert.
 * @param topicLabel - Human-readable topic label.
 * @param observedAt - Timestamp for this topic touch event.
 */
function touchTopicNode(
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
 * Parses label tokens and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for label tokens so call sites stay aligned.
 *
 * **What it talks to:**
 * - `tokenizeTopicWords` lexical parser.
 *
 * @param label - Thread/topic label text.
 * @returns Ordered collection produced by this step.
 */
function parseLabelTokens(label: string): readonly string[] {
  return tokenizeTopicWords(label);
}

/**
 * Resolves explicit return thread from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of explicit return thread by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 *
 * @param stack - Current conversation stack state.
 * @param text - Current user turn text.
 * @returns Resolved paused thread, `"AMBIGUOUS"` for multi-match, or `null` when not matched.
 */
function resolveExplicitReturnThread(
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
    return labelTokens.some((token) => normalized.includes(token));
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
 * **Why it exists:**
 * Ensures threads over cap removal follows deterministic lifecycle and retention rules.
 *
 * **What it talks to:**
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 *
 * @param threads - Candidate thread list before cap enforcement.
 * @param activeThreadKey - Active thread to protect from eviction when possible.
 * @param maxThreads - Numeric bound, counter, or index used by this logic.
 * @returns Ordered collection produced by this step.
 */
function evictThreadsOverCap(
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
 * **Why it exists:**
 * Centralizes active thread mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 *
 * @param threads - Thread list to update.
 * @param nextActiveThreadKey - Thread key that should become active.
 * @returns Ordered collection produced by this step.
 */
function setActiveThread(
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
 * Finds primary topic candidate from available runtime state.
 *
 * **Why it exists:**
 * Keeps candidate selection logic for primary topic candidate centralized so outcomes stay consistent.
 *
 * **What it talks to:**
 * - Uses `TopicKeyCandidateV1` (import `TopicKeyCandidateV1`) from `./types`.
 *
 * @param text - Turn text used for topic extraction.
 * @param observedAt - Turn timestamp attached to derived candidates.
 * @returns Highest-ranked topic candidate, or `null` when no viable topic exists.
 */
function findPrimaryTopicCandidate(
  text: string,
  observedAt: string
): TopicKeyCandidateV1 | null {
  const candidates = deriveTopicKeyCandidatesV1(text, observedAt);
  return candidates[0] ?? null;
}

/**
 * Builds thread from topic candidate for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of thread from topic candidate consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 * - Uses `TopicKeyCandidateV1` (import `TopicKeyCandidateV1`) from `./types`.
 *
 * @param candidate - Topic candidate selected for thread creation.
 * @param observedAt - Timestamp for initial thread touch.
 * @param resumeHint - Resume hint text captured from current turn.
 * @returns New active thread frame seeded from topic metadata.
 */
function buildThreadFromTopicCandidate(
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
 * **Why it exists:**
 * Turn-application logic mutates thread state; map form keeps updates deterministic and cheap.
 *
 * **What it talks to:**
 * - `ThreadFrameV1` snapshots from current stack state.
 *
 * @param threads - Existing thread array from conversation stack.
 * @returns Thread map copy used for in-turn updates.
 */
function copyThreadsByKey(
  threads: readonly ThreadFrameV1[]
): Map<string, ThreadFrameV1> {
  return new Map(threads.map((thread) => [thread.threadKey, { ...thread }]));
}

/**
 * Builds empty conversation stack v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of empty conversation stack v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 *
 * @param updatedAt - Stack timestamp to assign at initialization.
 * @returns Empty ConversationStackV1 baseline.
 */
export function createEmptyConversationStackV1(updatedAt: string): ConversationStackV1 {
  assertValidIsoTimestamp(updatedAt, "updatedAt");
  return {
    schemaVersion: "v1",
    updatedAt,
    activeThreadKey: null,
    threads: [],
    topics: []
  };
}

/**
 * Evaluates conversation stack v1 and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the conversation stack v1 policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 * - Uses `TopicNodeV1` (import `TopicNodeV1`) from `./types`.
 *
 * @param value - Unknown value to validate.
 * @returns `true` when value satisfies ConversationStackV1 structural requirements.
 */
export function isConversationStackV1(value: unknown): value is ConversationStackV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ConversationStackV1>;
  if (
    candidate.schemaVersion !== "v1" ||
    typeof candidate.updatedAt !== "string" ||
    (candidate.activeThreadKey !== null && typeof candidate.activeThreadKey !== "string") ||
    !Array.isArray(candidate.threads) ||
    !Array.isArray(candidate.topics)
  ) {
    return false;
  }

  for (const thread of candidate.threads) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
      return false;
    }
    const threadCandidate = thread as Partial<ThreadFrameV1>;
    if (
      typeof threadCandidate.threadKey !== "string" ||
      typeof threadCandidate.topicKey !== "string" ||
      typeof threadCandidate.topicLabel !== "string" ||
      (threadCandidate.state !== "active" &&
        threadCandidate.state !== "paused" &&
        threadCandidate.state !== "resolved") ||
      typeof threadCandidate.resumeHint !== "string" ||
      typeof threadCandidate.lastTouchedAt !== "string" ||
      !Array.isArray(threadCandidate.openLoops)
    ) {
      return false;
    }
  }

  for (const topic of candidate.topics) {
    if (!topic || typeof topic !== "object" || Array.isArray(topic)) {
      return false;
    }
    const topicCandidate = topic as Partial<TopicNodeV1>;
    if (
      typeof topicCandidate.topicKey !== "string" ||
      typeof topicCandidate.label !== "string" ||
      typeof topicCandidate.firstSeenAt !== "string" ||
      typeof topicCandidate.lastSeenAt !== "string" ||
      typeof topicCandidate.mentionCount !== "number"
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Derives topic key candidates v1 from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for topic key candidates v1 in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `TopicKeyCandidateV1` (import `TopicKeyCandidateV1`) from `./types`.
 *
 * @param text - Turn text to analyze for topic signals.
 * @param observedAt - Timestamp to stamp on emitted candidates.
 * @returns Ordered collection produced by this step.
 */
export function deriveTopicKeyCandidatesV1(
  text: string,
  observedAt: string
): readonly TopicKeyCandidateV1[] {
  assertValidIsoTimestamp(observedAt, "observedAt");
  const tokens = tokenizeTopicWords(text);
  if (tokens.length === 0) {
    return [];
  }

  const candidateTokenSets: string[][] = [];
  candidateTokenSets.push(tokens.slice(0, Math.min(3, tokens.length)));
  if (tokens.length >= 2) {
    candidateTokenSets.push(tokens.slice(0, 2));
  }
  candidateTokenSets.push(tokens.slice(0, 1));

  const uniqueCandidatesByKey = new Map<string, TopicKeyCandidateV1>();
  for (const tokenSet of candidateTokenSets) {
    const normalizedSet = [...new Set(tokenSet.map((token) => normalizeTopicToken(token)))].filter(Boolean);
    if (normalizedSet.length === 0) {
      continue;
    }
    const topicKey = toTopicKey(normalizedSet);
    const candidate: TopicKeyCandidateV1 = {
      topicKey,
      label: toTopicLabel(normalizedSet),
      confidence: computeTopicConfidence(normalizedSet, text),
      source: normalizedSet.length > 1 ? "heuristic_phrase" : "heuristic_tokens",
      observedAt
    };
    const existing = uniqueCandidatesByKey.get(topicKey);
    if (!existing || candidate.confidence > existing.confidence) {
      uniqueCandidatesByKey.set(topicKey, candidate);
    }
  }

  return [...uniqueCandidatesByKey.values()].sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return right.confidence - left.confidence;
    }
    return left.topicKey.localeCompare(right.topicKey);
  });
}

/**
 * Executes user turn to conversation stack v1 as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the user turn to conversation stack v1 runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 *
 * @param stack - Current conversation stack state.
 * @param turn - User turn to apply.
 * @param options - Optional tuning knobs for this operation.
 * @returns Updated conversation stack after user-turn routing/switching logic.
 */
export function applyUserTurnToConversationStackV1(
  stack: ConversationStackV1,
  turn: ConversationStackTurnV1,
  options: ApplyConversationTurnOptionsV1 = {}
): ConversationStackV1 {
  if (!isConversationStackV1(stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }
  assertValidIsoTimestamp(turn.at, "turn.at");

  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const topicSwitchThreshold = options.topicSwitchThreshold ?? DEFAULT_TOPIC_SWITCH_THRESHOLD;
  const threadMap = copyThreadsByKey(stack.threads);
  const topicsByKey = new Map(stack.topics.map((topic) => [topic.topicKey, { ...topic }]));
  const currentActive = stack.activeThreadKey ? threadMap.get(stack.activeThreadKey) ?? null : null;
  const normalizedTurnText = normalizeWhitespace(turn.text);
  const turnHint = buildResumeHint(normalizedTurnText);

  if (options.activeMissionThreadKey && threadMap.has(options.activeMissionThreadKey)) {
    const missionThread = threadMap.get(options.activeMissionThreadKey)!;
    threadMap.set(missionThread.threadKey, {
      ...missionThread,
      state: missionThread.state === "resolved" ? "resolved" : "active",
      lastTouchedAt: turn.at,
      resumeHint: turnHint
    });
    touchTopicNode(topicsByKey, missionThread.topicKey, missionThread.topicLabel, turn.at);
    const missionThreads = setActiveThread([...threadMap.values()], missionThread.threadKey);
    const cappedMissionThreads = evictThreadsOverCap(missionThreads, missionThread.threadKey, maxThreads);
    return {
      schemaVersion: "v1",
      updatedAt: turn.at,
      activeThreadKey: missionThread.threadKey,
      threads: cappedMissionThreads,
      topics: sortTopicNodes([...topicsByKey.values()])
    };
  }

  const explicitReturn = resolveExplicitReturnThread(stack, normalizedTurnText);
  const hasReturnSignal = RETURN_SIGNAL_PATTERN.test(normalizedTurnText);
  if (explicitReturn && explicitReturn !== "AMBIGUOUS") {
    const resumed = threadMap.get(explicitReturn.threadKey) ?? explicitReturn;
    threadMap.set(resumed.threadKey, {
      ...resumed,
      state: "active",
      lastTouchedAt: turn.at,
      resumeHint: turnHint
    });
    touchTopicNode(topicsByKey, resumed.topicKey, resumed.topicLabel, turn.at);
    const resumedThreads = setActiveThread([...threadMap.values()], resumed.threadKey);
    const cappedResumedThreads = evictThreadsOverCap(resumedThreads, resumed.threadKey, maxThreads);
    return {
      schemaVersion: "v1",
      updatedAt: turn.at,
      activeThreadKey: resumed.threadKey,
      threads: cappedResumedThreads,
      topics: sortTopicNodes([...topicsByKey.values()])
    };
  }

  if (explicitReturn === "AMBIGUOUS" && currentActive) {
    threadMap.set(currentActive.threadKey, {
      ...currentActive,
      lastTouchedAt: turn.at,
      resumeHint: turnHint
    });
    touchTopicNode(topicsByKey, currentActive.topicKey, currentActive.topicLabel, turn.at);
    return {
      schemaVersion: "v1",
      updatedAt: turn.at,
      activeThreadKey: currentActive.threadKey,
      threads: evictThreadsOverCap(setActiveThread([...threadMap.values()], currentActive.threadKey), currentActive.threadKey, maxThreads),
      topics: sortTopicNodes([...topicsByKey.values()])
    };
  }

  if (hasReturnSignal && explicitReturn === null && currentActive) {
    threadMap.set(currentActive.threadKey, {
      ...currentActive,
      lastTouchedAt: turn.at,
      resumeHint: turnHint
    });
    touchTopicNode(topicsByKey, currentActive.topicKey, currentActive.topicLabel, turn.at);
    return {
      schemaVersion: "v1",
      updatedAt: turn.at,
      activeThreadKey: currentActive.threadKey,
      threads: evictThreadsOverCap(
        setActiveThread([...threadMap.values()], currentActive.threadKey),
        currentActive.threadKey,
        maxThreads
      ),
      topics: sortTopicNodes([...topicsByKey.values()])
    };
  }

  const primaryCandidate = findPrimaryTopicCandidate(normalizedTurnText, turn.at);
  if (!primaryCandidate || primaryCandidate.confidence < topicSwitchThreshold) {
    if (currentActive) {
      threadMap.set(currentActive.threadKey, {
        ...currentActive,
        lastTouchedAt: turn.at,
        resumeHint: turnHint
      });
      touchTopicNode(topicsByKey, currentActive.topicKey, currentActive.topicLabel, turn.at);
      return {
        schemaVersion: "v1",
        updatedAt: turn.at,
        activeThreadKey: currentActive.threadKey,
        threads: evictThreadsOverCap(setActiveThread([...threadMap.values()], currentActive.threadKey), currentActive.threadKey, maxThreads),
        topics: sortTopicNodes([...topicsByKey.values()])
      };
    }
    return {
      ...stack,
      updatedAt: turn.at
    };
  }

  const existingByTopic = [...threadMap.values()].find(
    (thread) => thread.topicKey === primaryCandidate.topicKey
  );
  const nextActiveThread: ThreadFrameV1 = existingByTopic
    ? {
        ...existingByTopic,
        state:
          existingByTopic.state === "resolved"
            ? "resolved"
            : "active",
        lastTouchedAt: turn.at,
        resumeHint: turnHint
      }
    : buildThreadFromTopicCandidate(primaryCandidate, turn.at, turnHint);

  threadMap.set(nextActiveThread.threadKey, nextActiveThread);
  touchTopicNode(topicsByKey, nextActiveThread.topicKey, nextActiveThread.topicLabel, turn.at);
  const switchedThreads = setActiveThread([...threadMap.values()], nextActiveThread.threadKey);
  const cappedThreads = evictThreadsOverCap(switchedThreads, nextActiveThread.threadKey, maxThreads);

  return {
    schemaVersion: "v1",
    updatedAt: turn.at,
    activeThreadKey: nextActiveThread.threadKey,
    threads: cappedThreads,
    topics: sortTopicNodes([...topicsByKey.values()])
  };
}

/**
 * Executes assistant turn to conversation stack v1 as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the assistant turn to conversation stack v1 runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 *
 * @param stack - Current conversation stack state.
 * @param turn - Assistant turn to apply.
 * @returns Updated conversation stack after assistant-turn touch updates.
 */
export function applyAssistantTurnToConversationStackV1(
  stack: ConversationStackV1,
  turn: ConversationStackTurnV1
): ConversationStackV1 {
  if (!isConversationStackV1(stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }
  assertValidIsoTimestamp(turn.at, "turn.at");
  if (!stack.activeThreadKey) {
    return {
      ...stack,
      updatedAt: turn.at
    };
  }

  const threadMap = copyThreadsByKey(stack.threads);
  const activeThread = threadMap.get(stack.activeThreadKey);
  if (!activeThread) {
    return {
      ...stack,
      updatedAt: turn.at
    };
  }

  threadMap.set(activeThread.threadKey, {
    ...activeThread,
    lastTouchedAt: turn.at,
    resumeHint: buildResumeHint(turn.text)
  });
  return {
    schemaVersion: "v1",
    updatedAt: turn.at,
    activeThreadKey: activeThread.threadKey,
    threads: sortThreads([...threadMap.values()]),
    topics: stack.topics
  };
}

/**
 * Builds conversation stack from turns v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of conversation stack from turns v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 *
 * @param turns - Historical turns to replay in chronological order.
 * @param updatedAt - Target stack timestamp after replay.
 * @param options - Optional tuning knobs for this operation.
 * @param existingStack - Optional existing stack to refresh instead of rebuilding from empty.
 * @returns Replayed/updated conversation stack snapshot.
 */
export function buildConversationStackFromTurnsV1(
  turns: readonly ConversationStackTurnV1[],
  updatedAt: string,
  options: ApplyConversationTurnOptionsV1 = {},
  existingStack: ConversationStackV1 | null = null
): ConversationStackV1 {
  assertValidIsoTimestamp(updatedAt, "updatedAt");
  const orderedTurns = [...turns]
    .filter((turn) => Number.isFinite(Date.parse(turn.at)))
    .sort((left, right) => {
      if (left.at !== right.at) {
        return left.at.localeCompare(right.at);
      }
      return left.role.localeCompare(right.role);
    });

  let stack = existingStack && isConversationStackV1(existingStack)
    ? {
        ...existingStack,
        threads: sortThreads(existingStack.threads),
        topics: sortTopicNodes(existingStack.topics)
      }
    : createEmptyConversationStackV1(updatedAt);

  for (const turn of orderedTurns) {
    if (turn.role === "user") {
      stack = applyUserTurnToConversationStackV1(stack, turn, options);
      continue;
    }
    stack = applyAssistantTurnToConversationStackV1(stack, turn);
  }

  if (stack.updatedAt < updatedAt) {
    stack = {
      ...stack,
      updatedAt
    };
  }

  return stack;
}

/**
 * Migrates session conversation stack to v2 to the next deterministic lifecycle state.
 *
 * **Why it exists:**
 * Centralizes session conversation stack to v2 state-transition logic to keep evolution deterministic and reviewable.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 *
 * @param input - Session schema/version state plus turns and optional existing stack.
 * @returns Migration result with v2 schema marker and rebuilt/refreshed stack.
 */
export function migrateSessionConversationStackToV2(
  input: ConversationStackMigrationInputV1
): ConversationStackMigrationResultV1 {
  assertValidIsoTimestamp(input.updatedAt, "updatedAt");

  const hasValidStack = input.conversationStack !== null && isConversationStackV1(input.conversationStack);
  const validExistingStack: ConversationStackV1 | null = hasValidStack
    ? input.conversationStack
    : null;
  const latestTurnAt = [...input.conversationTurns]
    .map((turn) => turn.at)
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;

  if (input.sessionSchemaVersion === "v2" && validExistingStack) {
    if (latestTurnAt && latestTurnAt > validExistingStack.updatedAt) {
      return {
        sessionSchemaVersion: "v2",
        conversationStack: buildConversationStackFromTurnsV1(
          input.conversationTurns,
          latestTurnAt,
          {
            activeMissionThreadKey: input.activeMissionThreadKey ?? null,
            maxThreads: input.maxThreads
          },
          validExistingStack
        ),
        migrationApplied: false,
        migrationReason: "REFRESHED_FROM_TURNS"
      };
    }

    return {
      sessionSchemaVersion: "v2",
      conversationStack: validExistingStack,
      migrationApplied: false,
      migrationReason: "ALREADY_V2"
    };
  }

  const migrationUpdatedAt = latestTurnAt && latestTurnAt > input.updatedAt ? latestTurnAt : input.updatedAt;
  const rebuilt = buildConversationStackFromTurnsV1(
    input.conversationTurns,
    migrationUpdatedAt,
    {
      activeMissionThreadKey: input.activeMissionThreadKey ?? null,
      maxThreads: input.maxThreads
    },
    validExistingStack
  );

  return {
    sessionSchemaVersion: "v2",
    conversationStack: rebuilt,
    migrationApplied: true,
    migrationReason:
      input.sessionSchemaVersion === "v1" || input.sessionSchemaVersion === null
        ? "LEGACY_SCHEMA"
        : "MISSING_STACK"
  };
}

/**
 * Evaluates open loop v1 and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the open loop v1 policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `OpenLoopV1` (import `OpenLoopV1`) from `./types`.
 *
 * @param value - Unknown value to validate.
 * @returns `true` when value satisfies OpenLoopV1 structural requirements.
 */
export function isOpenLoopV1(value: unknown): value is OpenLoopV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<OpenLoopV1>;
  return (
    typeof candidate.loopId === "string" &&
    typeof candidate.threadKey === "string" &&
    Array.isArray(candidate.entityRefs) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.lastMentionedAt === "string" &&
    typeof candidate.priority === "number" &&
    (candidate.status === "open" || candidate.status === "resolved" || candidate.status === "superseded")
  );
}
