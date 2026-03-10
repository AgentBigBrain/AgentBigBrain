/**
 * @fileoverview Owns bounded in-conversation contextual recall helpers for active user turns.
 */

import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import { normalizeWhitespace } from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import type {
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./managerContracts";
import { resolveContextualReferenceHints } from "../../organs/languageUnderstanding/contextualReferenceResolution";
import { buildRecallSynthesis } from "../../organs/memorySynthesis/recallSynthesis";
import { buildMediaContinuityHints } from "../../core/stage6_86/mediaContinuityLinking";
import {
  buildEpisodeRecallCandidates,
  buildPausedThreadRecallCandidate,
  hasRecentDuplicateAssistantRecall,
  resolveConversationStack,
  tokenizeTopicTerms
} from "./contextualRecallSupport";
import {
  selectBestContextualRecallCandidate,
  type ContextualRecallCandidate
} from "./contextualRecallRanking";

export type { ContextualRecallCandidate } from "./contextualRecallRanking";

const GENERIC_RECALL_DETAIL_TERMS = new Set([
  "ago",
  "few",
  "situation",
  "thing",
  "whole",
  "week",
  "weeks"
]);

/**
 * Deduplicates resolved recall hints while preserving their original order.
 *
 * @param hints - Candidate recall hints from reference resolution or media continuity.
 * @returns Lowercased ordered hint list with duplicates removed.
 */
function dedupeRecallHints(hints: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const hint of hints) {
    const normalized = hint.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

/**
 * Detects strong direct overlap between the current turn and one episode candidate.
 *
 * @param candidate - Recall candidate under evaluation.
 * @param directTerms - Directly extracted terms from the current user turn.
 * @returns `true` when the turn overlaps both the episode entity and a concrete situation detail.
 */
function hasStrongDirectEpisodeOverlap(
  candidate: ContextualRecallCandidate,
  directTerms: readonly string[]
): boolean {
  if (candidate.kind !== "episode") {
    return false;
  }

  const entityTerms = tokenizeTopicTerms((candidate.entityRefs ?? []).join(" "));
  const detailTerms = tokenizeTopicTerms([
    candidate.topicLabel,
    candidate.episodeSummary ?? ""
  ].join(" "))
    .filter((term) => !GENERIC_RECALL_DETAIL_TERMS.has(term))
    .filter((term) => !entityTerms.includes(term));
  const directEntityOverlap = directTerms.filter((term) => entityTerms.includes(term)).length;
  const directDetailOverlap = directTerms.filter((term) => detailTerms.includes(term)).length;
  return directEntityOverlap > 0 && directDetailOverlap > 0;
}

/**
 * Suppresses weak contextual recall revivals when the current turn lacks a real recall cue.
 */
function shouldSuppressWeakContextualRecall(
  candidate: ContextualRecallCandidate,
  resolvedReference: ReturnType<typeof resolveContextualReferenceHints>,
  mediaRecallHints: readonly string[] = []
): boolean {
  const directTerms = resolvedReference.directTerms;
  const candidateTerms = tokenizeTopicTerms([
    candidate.topicLabel,
    candidate.episodeSummary ?? "",
    ...(candidate.entityRefs ?? [])
  ].join(" "));
  const mediaOverlap = mediaRecallHints.filter((term) => candidateTerms.includes(term)).length;

  if (resolvedReference.hasRecallCue) {
    return false;
  }
  if (mediaOverlap >= 2) {
    return false;
  }
  if (hasStrongDirectEpisodeOverlap(candidate, directTerms)) {
    return false;
  }
  if (!resolvedReference.usedFallbackContext) {
    return true;
  }
  const directOverlap = directTerms.filter((term) => candidateTerms.includes(term)).length;
  return directOverlap <= 1;
}

/**
 * Resolves one bounded in-conversation contextual recall opportunity for the current user turn.
 *
 * @param session - Conversation session providing prior turns and stack state.
 * @param userInput - Current raw user message before execution wrapping.
 * @param queryContinuityEpisodes - Optional bounded episodic-memory query capability.
 * @param media - Optional interpreted media envelope that may provide continuity cues.
 * @returns One grounded recall candidate, or `null` when no bounded recall should be offered.
 */
export async function resolveContextualRecallCandidate(
  session: ConversationSession,
  userInput: string,
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes,
  media?: ConversationInboundMediaEnvelope | null
): Promise<ContextualRecallCandidate | null> {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return null;
  }

  const stack = resolveConversationStack(session);
  const resolvedReference = resolveContextualReferenceHints({
    userInput: normalizedInput,
    recentTurns: session.conversationTurns,
    threads: stack.threads
  });
  const mediaHints = buildMediaContinuityHints(media);
  const userTokens = dedupeRecallHints(
    resolvedReference.resolvedHints.length > 0
      ? [...resolvedReference.resolvedHints, ...mediaHints.recallHints]
      : [...tokenizeTopicTerms(normalizedInput), ...mediaHints.recallHints]
  );
  if (userTokens.length === 0) {
    return null;
  }

  const nowMs = Date.parse(session.updatedAt);
  const pausedThreadCandidate = Number.isFinite(nowMs)
    ? buildPausedThreadRecallCandidate(session, stack, userTokens, nowMs)
    : null;
  const episodeCandidates = await buildEpisodeRecallCandidates(
    session,
    stack,
    userTokens,
    queryContinuityEpisodes
  );
  const bestCandidate = selectBestContextualRecallCandidate([
    ...(pausedThreadCandidate ? [pausedThreadCandidate] : []),
    ...episodeCandidates
  ]);
  if (!bestCandidate) {
    return null;
  }

  if (shouldSuppressWeakContextualRecall(bestCandidate, resolvedReference, mediaHints.recallHints)) {
    return null;
  }

  if (hasRecentDuplicateAssistantRecall(session, bestCandidate, userTokens)) {
    return null;
  }

  return bestCandidate;
}

/**
 * Builds the bounded execution-input block for one contextual recall opportunity.
 *
 * @param session - Conversation session providing prior turns and stack state.
 * @param userInput - Current raw user message before execution wrapping.
 * @param queryContinuityEpisodes - Optional bounded episodic-memory query capability.
 * @param queryContinuityFacts - Optional bounded continuity fact query capability.
 * @param media - Optional interpreted media envelope that may provide continuity cues.
 * @returns Instruction block appended to execution input, or `null` when no recall applies.
 */
export async function buildContextualRecallBlock(
  session: ConversationSession,
  userInput: string,
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  media?: ConversationInboundMediaEnvelope | null
): Promise<string | null> {
  const normalizedInput = normalizeWhitespace(userInput);
  const stack = resolveConversationStack(session);
  const resolvedReference = resolveContextualReferenceHints({
    userInput: normalizedInput,
    recentTurns: session.conversationTurns,
    threads: stack.threads
  });
  const mediaHints = buildMediaContinuityHints(media);
  const candidate = await resolveContextualRecallCandidate(
    session,
    userInput,
    queryContinuityEpisodes,
    media
  );
  if (!candidate) {
    return null;
  }

  const resolvedHints = dedupeRecallHints(
    resolvedReference.resolvedHints.length > 0
      ? [...resolvedReference.resolvedHints, ...mediaHints.recallHints]
      : [...tokenizeTopicTerms(normalizedInput), ...mediaHints.recallHints]
  );
  const supportingEpisodes = queryContinuityEpisodes && resolvedHints.length > 0
    ? await queryContinuityEpisodes({
      stack,
      entityHints: resolvedHints,
      maxEpisodes: 3
    }).catch(() => [])
    : [];
  const supportingFacts = queryContinuityFacts && resolvedHints.length > 0
    ? await queryContinuityFacts({
      stack,
      entityHints: resolvedHints,
      maxFacts: 3
    }).catch(() => [])
    : [];
  const synthesis = buildRecallSynthesis(supportingEpisodes, supportingFacts);
  const mediaCueLine = mediaHints.recallHints.length > 0
    ? [`- Media continuity cues: ${mediaHints.recallHints.join(", ")}`]
    : [];
  const mediaEvidenceLine = mediaHints.evidence.length > 0
    ? [`- Media cue sources: ${mediaHints.evidence.join(", ")}`]
    : [];

  if (candidate.kind === "episode") {
    return [
      "Contextual recall opportunity (optional):",
      "- The user naturally re-mentioned a person or topic tied to an older unresolved situation.",
      `- Relevant situation: ${candidate.topicLabel}`,
      `- Situation summary: ${candidate.episodeSummary ?? candidate.supportingCue}`,
      `- Prior cue: ${candidate.supportingCue}`,
      `- Situation status: ${candidate.episodeStatus ?? "unresolved"}`,
      `- Related open loops: ${candidate.openLoopCount}`,
      `- Last mentioned: ${candidate.lastTouchedAt}`,
      ...mediaCueLine,
      ...mediaEvidenceLine,
      ...(resolvedReference.usedFallbackContext
        ? [`- Resolved from context: ${resolvedReference.evidence.join(", ")}`]
        : []),
      ...(synthesis
        ? [
            `- Supporting memory hypothesis: ${synthesis.summary}`,
            ...synthesis.evidence.slice(0, 3).map(
              (evidence) => `- Evidence: ${evidence.kind} | ${evidence.label} | ${evidence.detail}`
            )
          ]
        : []),
      "- Response rule: if it fits naturally, ask at most one brief follow-up about this specific older situation before returning to the current request.",
      "- Do not ask if it would feel repetitive, overly intrusive, or derail the current request."
    ].join("\n");
  }

  return [
    "Contextual recall opportunity (optional):",
    `- The user just re-mentioned an older paused topic: ${candidate.topicLabel}`,
    `- Prior thread cue: ${candidate.supportingCue}`,
    `- Open loops on that thread: ${candidate.openLoopCount}`,
    `- Last touched: ${candidate.lastTouchedAt}`,
    ...mediaCueLine,
    ...mediaEvidenceLine,
    ...(resolvedReference.usedFallbackContext
      ? [`- Resolved from context: ${resolvedReference.evidence.join(", ")}`]
      : []),
    ...(synthesis
      ? [
          `- Supporting memory hypothesis: ${synthesis.summary}`,
          ...synthesis.evidence.slice(0, 2).map(
            (evidence) => `- Evidence: ${evidence.kind} | ${evidence.label} | ${evidence.detail}`
          )
        ]
      : []),
    "- Response rule: if it fits naturally, you may ask one brief follow-up about that older unresolved thread before continuing.",
    "- Do not force the detour if the current request is clearly unrelated.",
    "- Do not repeat a recent follow-up the assistant already asked."
  ].join("\n");
}
