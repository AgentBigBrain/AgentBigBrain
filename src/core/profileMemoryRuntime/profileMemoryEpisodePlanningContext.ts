/**
 * @fileoverview Query-aware, non-sensitive planning-context selection for episodic memory.
 */

import type { ProfileMemoryState } from "../profileMemory";
import {
  extractEpisodePlanningQueryTerms as extractEpisodePlanningQueryTermsFromRuntime
} from "../languageRuntime/queryIntentTerms";
import { isTerminalProfileEpisodeStatus } from "./profileMemoryEpisodeState";
import { compareProfileEpisodesForLifecyclePriority } from "./profileMemoryEpisodeConsolidation";

/**
 * Extracts bounded lower-case query terms for episodic-memory ranking.
 *
 * @param queryInput - Current query text used for ranking.
 * @returns Stable ordered query terms.
 */
function extractEpisodePlanningQueryTerms(queryInput: string): readonly string[] {
  return extractEpisodePlanningQueryTermsFromRuntime(queryInput);
}

/**
 * Scores one episode for planning-context relevance against query terms.
 *
 * @param episode - Episodic-memory record under evaluation.
 * @param queryTerms - Current query terms.
 * @returns Deterministic relevance score.
 */
function scoreEpisodeForPlanningContext(
  episode: ProfileMemoryState["episodes"][number],
  queryTerms: readonly string[]
): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  const surface = [
    episode.title,
    episode.summary,
    ...episode.entityRefs,
    ...episode.tags
  ].join(" ").toLowerCase();

  let score = 0;
  for (const term of queryTerms) {
    if (episode.title.toLowerCase().includes(term)) {
      score += 6;
    }
    if (episode.summary.toLowerCase().includes(term)) {
      score += 4;
    }
    if (episode.entityRefs.some((entry) => entry.toLowerCase().includes(term))) {
      score += 5;
    }
    if (episode.tags.some((entry) => entry.toLowerCase().includes(term))) {
      score += 3;
    }
    if (surface.includes(term)) {
      score += 1;
    }
  }

  if (score > 0) {
    if (episode.status === "unresolved") {
      score += 3;
    } else if (episode.status === "partially_resolved" || episode.status === "outcome_unknown") {
      score += 2;
    }
  }

  return score;
}

/**
 * Renders one bounded episodic-memory line for planner/model grounding.
 *
 * @param episode - Episodic-memory record to render.
 * @returns Single-line situation summary.
 */
function renderEpisodePlanningLine(
  episode: ProfileMemoryState["episodes"][number]
): string {
  return `- situation: ${episode.title} | status=${episode.status} | observedAt=${episode.observedAt} | summary=${episode.summary}`;
}

/**
 * Builds bounded unresolved-situation planning context from episodic memory.
 *
 * @param state - Current normalized profile-memory state.
 * @param maxEpisodes - Maximum episode count to include.
 * @param queryInput - Current query text used for relevance ranking.
 * @returns Rendered episodic-memory planning context string.
 */
export function buildProfileEpisodePlanningContext(
  state: ProfileMemoryState,
  maxEpisodes: number,
  queryInput: string,
  nowIso = state.updatedAt,
  staleAfterDays = 90
): string {
  const selectedEpisodes = selectProfileEpisodesForPlanningQuery(
    state,
    maxEpisodes,
    queryInput,
    nowIso,
    staleAfterDays
  );
  if (selectedEpisodes.length === 0) {
    return "";
  }

  return selectedEpisodes.map((episode) => renderEpisodePlanningLine(episode)).join("\n");
}

/**
 * Selects bounded non-sensitive unresolved episodic-memory records for one planning query.
 *
 * @param state - Current normalized profile-memory state.
 * @param maxEpisodes - Maximum episode count to include.
 * @param queryInput - Current query text used for relevance ranking.
 * @param nowIso - Timestamp used for lifecycle tie-breaking.
 * @param staleAfterDays - Staleness policy used for lifecycle tie-breaking.
 * @returns Deterministically selected episode records.
 */
export function selectProfileEpisodesForPlanningQuery(
  state: ProfileMemoryState,
  maxEpisodes: number,
  queryInput: string,
  nowIso = state.updatedAt,
  staleAfterDays = 90
): readonly ProfileMemoryState["episodes"][number][] {
  const safeMaxEpisodes = Math.max(0, maxEpisodes);
  if (safeMaxEpisodes === 0) {
    return [];
  }

  const queryTerms = extractEpisodePlanningQueryTerms(queryInput);
  if (queryTerms.length === 0) {
    return [];
  }

  return state.episodes
    .filter((episode) => !episode.sensitive)
    .filter((episode) => !isTerminalProfileEpisodeStatus(episode.status))
    .map((episode) => ({
      episode,
      score: scoreEpisodeForPlanningContext(episode, queryTerms)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return compareProfileEpisodesForLifecyclePriority(
        left.episode,
        right.episode,
        staleAfterDays,
        nowIso
      );
    })
    .slice(0, safeMaxEpisodes)
    .map((entry) => entry.episode);
}
