/**
 * @fileoverview Shared helper primitives for bounded in-conversation contextual recall.
 */

import { buildConversationStackFromTurnsV1 } from "../../core/stage6_86ConversationStack";
import { countLanguageTermOverlap } from "../../core/languageRuntime/languageScoring";
import { extractContextualRecallTerms } from "../../core/languageRuntime/queryIntentTerms";
import type {
  ConversationStackV1,
  ThreadFrameV1
} from "../../core/types";
import {
  isLikelyAssistantClarificationPrompt,
  normalizeWhitespace
} from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import type {
  ConversationContinuityEpisodeRecord,
  QueryConversationContinuityEpisodes
} from "./managerContracts";
import type { ContextualRecallCandidate } from "./contextualRecallRanking";

const MAX_CONTEXTUAL_RECALL_AGE_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_SUPPORTING_CUE_CHARS = 180;
const MAX_EPISODE_QUERY_CANDIDATES = 3;
const RECENT_ASSISTANT_DUPLICATE_LOOKBACK = 4;
const MIN_TOPIC_LABEL_OVERLAP = 1;

/**
 * Tokenizes freeform text into bounded lower-case topic terms for recall matching.
 *
 * @param value - Freeform text to tokenize.
 * @returns Stable set of meaningful topic tokens.
 */
export function tokenizeTopicTerms(value: string): readonly string[] {
  return extractContextualRecallTerms(normalizeWhitespace(value));
}

/**
 * Counts token overlap between the current user turn and a stored topic surface.
 *
 * @param left - Current user-turn tokens.
 * @param right - Thread/topic tokens to compare.
 * @returns Count of overlapping tokens.
 */
function countTokenOverlap(
  left: readonly string[],
  right: readonly string[]
): number {
  return countLanguageTermOverlap(left, right);
}

/**
 * Builds a deterministic stack snapshot for recall matching.
 *
 * @param session - Conversation session providing persisted stack/turn state.
 * @returns Canonical conversation stack for recall evaluation.
 */
export function resolveConversationStack(session: ConversationSession): ConversationStackV1 {
  return session.conversationStack
    ?? buildConversationStackFromTurnsV1(
      session.conversationTurns,
      session.updatedAt
    );
}

/**
 * Finds the best paused thread candidate for the current user turn.
 *
 * @param stack - Canonical conversation stack to inspect.
 * @param userTokens - Current user-turn topic tokens.
 * @param nowMs - Evaluation timestamp in epoch milliseconds.
 * @returns Highest-scoring paused thread, or `null` when no bounded match exists.
 */
function findBestPausedThreadMatch(
  stack: ConversationStackV1,
  userTokens: readonly string[],
  nowMs: number
): ThreadFrameV1 | null {
  let bestThread: ThreadFrameV1 | null = null;
  let bestScore = -1;

  for (const thread of stack.threads) {
    if (thread.state !== "paused") {
      continue;
    }
    const lastTouchedMs = Date.parse(thread.lastTouchedAt);
    if (!Number.isFinite(lastTouchedMs) || nowMs - lastTouchedMs > MAX_CONTEXTUAL_RECALL_AGE_MS) {
      continue;
    }

    const topicLabelTokens = tokenizeTopicTerms(thread.topicLabel);
    const labelOverlap = countTokenOverlap(userTokens, topicLabelTokens);
    if (labelOverlap < MIN_TOPIC_LABEL_OVERLAP) {
      continue;
    }

    const resumeTokens = tokenizeTopicTerms(thread.resumeHint);
    const resumeOverlap = countTokenOverlap(userTokens, resumeTokens);
    const openLoopCount = thread.openLoops.filter((loop) => loop.status === "open").length;
    const ageBoost = Math.max(0, 1 - ((nowMs - lastTouchedMs) / MAX_CONTEXTUAL_RECALL_AGE_MS));
    const score = (labelOverlap * 3) + resumeOverlap + (openLoopCount * 0.5) + ageBoost;

    if (score > bestScore) {
      bestScore = score;
      bestThread = thread;
    }
  }

  return bestThread;
}

/**
 * Truncates supporting cue text to the bounded model-facing recall size.
 *
 * @param cue - Raw cue text.
 * @returns Stable bounded cue.
 */
function clampSupportingCue(cue: string): string {
  const normalizedCue = normalizeWhitespace(cue);
  if (normalizedCue.length <= MAX_SUPPORTING_CUE_CHARS) {
    return normalizedCue;
  }
  return `${normalizedCue.slice(0, MAX_SUPPORTING_CUE_CHARS - 3)}...`;
}

/**
 * Builds a short supporting cue from prior related turns for one paused thread.
 *
 * @param session - Conversation session containing prior turns.
 * @param thread - Matched paused thread.
 * @param userTokens - Current user-turn topic tokens.
 * @returns Best supporting cue text to expose to the model.
 */
function buildThreadSupportingCue(
  session: ConversationSession,
  thread: ThreadFrameV1,
  userTokens: readonly string[]
): string {
  const topicTokens = tokenizeTopicTerms(thread.topicLabel);
  const relatedTurns = session.conversationTurns.filter((turn) => {
    const turnTokens = tokenizeTopicTerms(turn.text);
    return countTokenOverlap(turnTokens, topicTokens) > 0
      || countTokenOverlap(turnTokens, userTokens) > 0;
  });
  const assistantQuestion = [...relatedTurns]
    .reverse()
    .find(
      (turn) =>
        turn.role === "assistant"
        && isLikelyAssistantClarificationPrompt(turn.text)
    );
  const fallbackTurn = [...relatedTurns].reverse()[0] ?? null;
  return clampSupportingCue(
    assistantQuestion?.text ?? fallbackTurn?.text ?? thread.resumeHint
  );
}

/**
 * Builds a bounded supporting cue for one episode recall candidate.
 *
 * @param session - Conversation session containing prior turns.
 * @param episode - Continuity-linked episode candidate.
 * @param userTokens - Current user-turn topic tokens.
 * @returns Best supporting cue text to expose to the model.
 */
function buildEpisodeSupportingCue(
  session: ConversationSession,
  episode: ConversationContinuityEpisodeRecord,
  userTokens: readonly string[]
): string {
  const episodeTerms = tokenizeTopicTerms([
    episode.title,
    episode.summary,
    ...episode.entityRefs,
    ...episode.entityLinks.map((entry) => entry.canonicalName)
  ].join(" "));
  const relatedTurns = session.conversationTurns.filter((turn) => {
    const turnTokens = tokenizeTopicTerms(turn.text);
    return countTokenOverlap(turnTokens, episodeTerms) > 0
      || countTokenOverlap(turnTokens, userTokens) > 0;
  });
  const assistantQuestion = [...relatedTurns]
    .reverse()
    .find(
      (turn) =>
        turn.role === "assistant"
        && isLikelyAssistantClarificationPrompt(turn.text)
    );
  const fallbackTurn = [...relatedTurns].reverse()[0] ?? null;
  return clampSupportingCue(
    assistantQuestion?.text ?? fallbackTurn?.text ?? episode.summary
  );
}

/**
 * Builds a paused-thread recall candidate from the current stack.
 *
 * @param session - Conversation session containing prior turns.
 * @param stack - Canonical conversation stack for evaluation.
 * @param userTokens - Current user-turn topic tokens.
 * @param nowMs - Evaluation timestamp.
 * @returns Thread-backed recall candidate, or `null` when none is bounded enough.
 */
export function buildPausedThreadRecallCandidate(
  session: ConversationSession,
  stack: ConversationStackV1,
  userTokens: readonly string[],
  nowMs: number
): ContextualRecallCandidate | null {
  const matchedThread = findBestPausedThreadMatch(stack, userTokens, nowMs);
  if (!matchedThread) {
    return null;
  }

  const openLoopCount = matchedThread.openLoops.filter((loop) => loop.status === "open").length;
  return {
    kind: "thread",
    threadKey: matchedThread.threadKey,
    topicLabel: matchedThread.topicLabel,
    supportingCue: buildThreadSupportingCue(session, matchedThread, userTokens),
    openLoopCount,
    lastTouchedAt: matchedThread.lastTouchedAt,
    relevanceScore: openLoopCount + countTokenOverlap(
      userTokens,
      tokenizeTopicTerms(`${matchedThread.topicLabel} ${matchedThread.resumeHint}`)
    )
  };
}

/**
 * Queries and builds episodic-memory recall candidates for the active user turn.
 *
 * @param session - Conversation session containing prior turns.
 * @param stack - Canonical conversation stack for evaluation.
 * @param userTokens - Current user-turn topic tokens.
 * @param queryContinuityEpisodes - Optional bounded episodic-memory query capability.
 * @returns Ranked episodic-memory candidates, or an empty list when unavailable.
 */
export async function buildEpisodeRecallCandidates(
  session: ConversationSession,
  stack: ConversationStackV1,
  userTokens: readonly string[],
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes
): Promise<readonly ContextualRecallCandidate[]> {
  if (!queryContinuityEpisodes || userTokens.length === 0) {
    return [];
  }

  let matches: readonly ConversationContinuityEpisodeRecord[];
  try {
    matches = await queryContinuityEpisodes({
      stack,
      entityHints: userTokens,
      maxEpisodes: MAX_EPISODE_QUERY_CANDIDATES
    });
  } catch {
    return [];
  }

  return matches.map((episode) => {
    const openLoopCount = episode.openLoopLinks.filter((loop) => loop.status === "open").length;
    const primaryThreadKey = episode.openLoopLinks[0]?.threadKey ?? `episode:${episode.episodeId}`;
    return {
      kind: "episode",
      threadKey: primaryThreadKey,
      topicLabel: episode.title,
      supportingCue: buildEpisodeSupportingCue(session, episode, userTokens),
      openLoopCount,
      lastTouchedAt: episode.lastMentionedAt,
      relevanceScore: (episode.entityLinks.length * 3) + (episode.openLoopLinks.length * 2),
      episodeId: episode.episodeId,
      episodeStatus: episode.status,
      episodeSummary: episode.summary,
      entityRefs: [...episode.entityRefs]
    };
  });
}

/**
 * Suppresses recall when the assistant already asked a very similar follow-up recently.
 *
 * @param session - Conversation session containing recent assistant turns.
 * @param candidate - Recall candidate under evaluation.
 * @param userTokens - Current user-turn topic tokens.
 * @returns `true` when a recent assistant turn already covered the recall.
 */
export function hasRecentDuplicateAssistantRecall(
  session: ConversationSession,
  candidate: ContextualRecallCandidate,
  userTokens: readonly string[]
): boolean {
  const candidateTokens = tokenizeTopicTerms([
    candidate.topicLabel,
    candidate.supportingCue,
    candidate.episodeSummary ?? "",
    ...(candidate.entityRefs ?? [])
  ].join(" "));
  const assistantTurns = session.conversationTurns
    .filter((turn) => turn.role === "assistant")
    .slice(-RECENT_ASSISTANT_DUPLICATE_LOOKBACK);
  return assistantTurns.some((turn) => {
    if (!isLikelyAssistantClarificationPrompt(turn.text)) {
      return false;
    }
    const turnTokens = tokenizeTopicTerms(turn.text);
    return countTokenOverlap(turnTokens, candidateTokens) > 0
      || countTokenOverlap(turnTokens, userTokens) > 0;
  });
}
