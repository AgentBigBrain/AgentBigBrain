/**
 * @fileoverview Resolves bounded contextual reference hints from active conversation state.
 */

import {
  extractContextualRecallTerms,
  extractConversationTopicTerms
} from "../../core/languageRuntime/queryIntentTerms";
import type { LanguageProfileId } from "../../core/languageRuntime/contracts";

const MAX_RESOLVED_HINTS = 6;
const MAX_RECENT_TURNS = 4;
const VAGUE_CALLBACK_PATTERNS: readonly RegExp[] = [
  /\bthat whole thing\b/i,
  /\bthat situation\b/i,
  /\bthat mess\b/i,
  /\bhow did that end up\b/i,
  /\bwhat happened with that\b/i,
  /\bdid (?:he|she|they|it) ever\b/i,
  /\bhow is (?:he|she|they)\b/i,
  /\bhear back\b/i
];
const CONTEXTUAL_RESUME_CUE_PATTERNS: readonly RegExp[] = [
  /\b(?:go|come)\s+back\s+to\b/i,
  /\bcircle\s+back\s+to\b/i,
  /\breturn\s+to\b/i,
  /\brevisit\b/i
];

export interface ContextualReferenceTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface ContextualReferenceThread {
  topicLabel: string;
  resumeHint: string;
  state: "active" | "paused" | "resolved";
  lastTouchedAt: string;
}

export interface ContextualReferenceResolutionRequest {
  userInput: string;
  recentTurns: readonly ContextualReferenceTurn[];
  threads: readonly ContextualReferenceThread[];
  profileId?: LanguageProfileId;
  maxHints?: number;
  memoryIntent?: "none" | "relationship_recall" | "profile_update" | "contextual_recall" | "document_derived_recall";
}

export interface ContextualReferenceResolution {
  directTerms: readonly string[];
  resolvedHints: readonly string[];
  evidence: readonly string[];
  usedFallbackContext: boolean;
  hasRecallCue: boolean;
}

const DIRECT_RECALL_CUE_PATTERNS: readonly RegExp[] = [
  /\bhow\s+is\s+[a-z][a-z' -]{1,40}\b/i,
  /\bhow\s+did\b/i,
  /\bdid\s+[a-z][a-z' -]{1,40}\s+ever\b/i,
  /\bclose(?:d)?\s+the\s+loop\b/i,
  /\bworth\s+revisiting\b/i,
  /\bcheck(?:ing)?\s+(?:back|in)\b/i
];

/**
 * Resolves bounded continuity hints from the current utterance plus nearby conversation context.
 *
 * @param request - User input and bounded surrounding context.
 * @returns Deterministic hint set for continuity-aware recall queries.
 */
export function resolveContextualReferenceHints(
  request: ContextualReferenceResolutionRequest
): ContextualReferenceResolution {
  const directTerms = extractContextualRecallTerms(request.userInput, request.profileId);
  const routeAllowsRecallExpansion =
    request.memoryIntent === "relationship_recall" ||
    request.memoryIntent === "contextual_recall";
  const hasRecallCue = routeAllowsRecallExpansion &&
    (DIRECT_RECALL_CUE_PATTERNS.some((pattern) => pattern.test(request.userInput))
      || VAGUE_CALLBACK_PATTERNS.some((pattern) => pattern.test(request.userInput))
      || CONTEXTUAL_RESUME_CUE_PATTERNS.some((pattern) => pattern.test(request.userInput)));
  if (!routeAllowsRecallExpansion) {
    return {
      directTerms,
      resolvedHints: directTerms.slice(0, request.maxHints ?? MAX_RESOLVED_HINTS),
      evidence: directTerms.length > 0 ? ["direct_terms"] : [],
      usedFallbackContext: false,
      hasRecallCue: false
    };
  }
  const shouldExpandContext =
    directTerms.length < 2 || hasRecallCue;
  if (!shouldExpandContext) {
    return {
      directTerms,
      resolvedHints: directTerms.slice(0, request.maxHints ?? MAX_RESOLVED_HINTS),
      evidence: ["direct_terms"],
      usedFallbackContext: false,
      hasRecallCue
    };
  }

  const scoredTerms = new Map<string, number>();
  const evidence = new Set<string>(directTerms.length > 0 ? ["direct_terms"] : []);
  for (const term of directTerms) {
    scoredTerms.set(term, (scoredTerms.get(term) ?? 0) + 6);
  }

  const recentTurns = [...request.recentTurns].slice(-MAX_RECENT_TURNS).reverse();
  recentTurns.forEach((turn, index) => {
    const weight = turn.role === "user" ? 5 - index : 3 - index;
    if (weight <= 0) {
      return;
    }
    const terms = extractConversationTopicTerms(turn.text, request.profileId);
    if (terms.length > 0) {
      evidence.add("recent_turn_context");
    }
    for (const term of terms) {
      scoredTerms.set(term, (scoredTerms.get(term) ?? 0) + weight);
    }
  });

  const pausedThreads = [...request.threads]
    .filter((thread) => thread.state === "paused")
    .sort((left, right) => Date.parse(right.lastTouchedAt) - Date.parse(left.lastTouchedAt))
    .slice(0, 3);
  pausedThreads.forEach((thread, index) => {
    const weight = 4 - index;
    if (weight <= 0) {
      return;
    }
    const terms = extractConversationTopicTerms(
      `${thread.topicLabel} ${thread.resumeHint}`,
      request.profileId
    );
    if (terms.length > 0) {
      evidence.add("paused_thread_context");
    }
    for (const term of terms) {
      scoredTerms.set(term, (scoredTerms.get(term) ?? 0) + weight);
    }
  });

  const resolvedHints = [...scoredTerms.entries()]
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, request.maxHints ?? MAX_RESOLVED_HINTS)
    .map(([term]) => term);

  return {
    directTerms,
    resolvedHints,
    evidence: [...evidence],
    usedFallbackContext: evidence.has("recent_turn_context") || evidence.has("paused_thread_context"),
    hasRecallCue
  };
}
