/**
 * @fileoverview Canonical bounded term extraction for memory, recall, and planning domains.
 */

import type { LanguageProfileId } from "./contracts";
import { tokenizeLanguageTerms } from "./tokenization";

/**
 * Extracts deterministic conversation-topic terms.
 *
 * @param text - Free-form text under analysis.
 * @param profileId - Optional language profile override.
 * @returns Stable conversation-topic terms.
 */
export function extractConversationTopicTerms(
  text: string,
  profileId?: LanguageProfileId
): readonly string[] {
  return tokenizeLanguageTerms({
    text,
    domain: "conversation_topic",
    profileId,
    minTokenLength: 3
  });
}

/**
 * Extracts deterministic contextual-recall terms.
 *
 * @param text - Free-form text under analysis.
 * @param profileId - Optional language profile override.
 * @returns Stable contextual-recall terms.
 */
export function extractContextualRecallTerms(
  text: string,
  profileId?: LanguageProfileId
): readonly string[] {
  return tokenizeLanguageTerms({
    text,
    domain: "contextual_recall",
    profileId,
    minTokenLength: 3
  });
}

/**
 * Extracts deterministic planning-query terms.
 *
 * @param text - Free-form text under analysis.
 * @param profileId - Optional language profile override.
 * @returns Stable planning-query terms.
 */
export function extractPlanningQueryTerms(
  text: string,
  profileId?: LanguageProfileId
): readonly string[] {
  return tokenizeLanguageTerms({
    text,
    domain: "planning_query",
    profileId,
    minTokenLength: 2,
    maxTokens: 12
  });
}

/**
 * Extracts deterministic episodic-memory planning query terms.
 *
 * @param text - Free-form text under analysis.
 * @param profileId - Optional language profile override.
 * @returns Stable episode-planning query terms.
 */
export function extractEpisodePlanningQueryTerms(
  text: string,
  profileId?: LanguageProfileId
): readonly string[] {
  return tokenizeLanguageTerms({
    text,
    domain: "episode_planning_query",
    profileId,
    minTokenLength: 3,
    maxTokens: 12
  });
}

/**
 * Extracts deterministic episode-linking terms.
 *
 * @param text - Free-form text under analysis.
 * @param profileId - Optional language profile override.
 * @returns Stable episode-linking terms.
 */
export function extractEpisodeLinkingTerms(
  text: string,
  profileId?: LanguageProfileId
): readonly string[] {
  return tokenizeLanguageTerms({
    text,
    domain: "episode_linking",
    profileId,
    minTokenLength: 3
  });
}

/**
 * Extracts deterministic semantic-memory concept terms.
 *
 * @param text - Free-form text under analysis.
 * @param profileId - Optional language profile override.
 * @returns Stable semantic concept terms.
 */
export function extractSemanticConceptTerms(
  text: string,
  profileId?: LanguageProfileId
): readonly string[] {
  return tokenizeLanguageTerms({
    text,
    domain: "semantic_concepts",
    profileId,
    minTokenLength: 4,
    maxTokens: 20
  });
}
