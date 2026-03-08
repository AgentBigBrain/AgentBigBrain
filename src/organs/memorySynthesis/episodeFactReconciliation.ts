/**
 * @fileoverview Matches bounded profile facts against continuity-linked episode records.
 */

import {
  extractContextualRecallTerms,
  extractPlanningQueryTerms
} from "../../core/languageRuntime/queryIntentTerms";
import type {
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./contracts";

/**
 * Selects the strongest supporting facts for one remembered situation.
 *
 * @param episode - Continuity-linked episode under evaluation.
 * @param facts - Candidate bounded profile facts.
 * @param maxFacts - Maximum supporting facts to keep.
 * @returns Supporting facts ordered by deterministic relevance.
 */
export function selectSupportingFactsForEpisode(
  episode: MemorySynthesisEpisodeRecord,
  facts: readonly MemorySynthesisFactRecord[],
  maxFacts = 2
): readonly MemorySynthesisFactRecord[] {
  const episodeTerms = new Set<string>([
    ...extractContextualRecallTerms(episode.title),
    ...extractContextualRecallTerms(episode.summary),
    ...episode.entityRefs.flatMap((entry) => extractPlanningQueryTerms(entry)),
    ...episode.entityLinks.flatMap((entry) => extractPlanningQueryTerms(entry.canonicalName))
  ]);

  return facts
    .map((fact) => ({
      fact,
      score: scoreFactForEpisode(fact, episodeTerms)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return Date.parse(right.fact.lastUpdatedAt) - Date.parse(left.fact.lastUpdatedAt);
    })
    .slice(0, Math.max(1, maxFacts))
    .map((entry) => entry.fact);
}

/**
 * Scores a fact for relevance against one episode surface.
 *
 * @param fact - Fact under evaluation.
 * @param episodeTerms - Stable term set describing the episode.
 * @returns Deterministic relevance score.
 */
function scoreFactForEpisode(
  fact: MemorySynthesisFactRecord,
  episodeTerms: ReadonlySet<string>
): number {
  const keyTerms = extractPlanningQueryTerms(fact.key);
  const valueTerms = extractContextualRecallTerms(fact.value);
  let score = 0;

  for (const term of keyTerms) {
    if (episodeTerms.has(term)) {
      score += 4;
    }
  }
  for (const term of valueTerms) {
    if (episodeTerms.has(term)) {
      score += 6;
    }
  }

  if (score > 0 && fact.key.startsWith("contact.")) {
    score += 2;
  }
  return score;
}
