/**
 * @fileoverview Builds one bounded synthesis hypothesis from episode, fact, and continuity signals.
 */

import type {
  BoundedMemorySynthesis,
  MemorySynthesisEpisodeRecord,
  MemorySynthesisEvidence,
  MemorySynthesisFactRecord
} from "./contracts";
import { selectSupportingFactsForEpisode } from "./episodeFactReconciliation";

const EPISODE_STATUS_WEIGHT: Record<MemorySynthesisEpisodeRecord["status"], number> = {
  unresolved: 3,
  outcome_unknown: 2,
  partially_resolved: 2,
  resolved: 0,
  no_longer_relevant: 0
};

/**
 * Builds one bounded synthesis hypothesis from continuity-linked episodes and supporting facts.
 *
 * @param episodes - Continuity-linked remembered situations.
 * @param facts - Candidate bounded profile facts.
 * @returns Best bounded synthesis, or `null` when support stays weak.
 */
export function buildContinuityMemorySynthesis(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): BoundedMemorySynthesis | null {
  const candidates = episodes
    .map((episode) => buildEpisodeSynthesisCandidate(episode, facts))
    .filter((candidate): candidate is BoundedMemorySynthesis => candidate !== null)
    .sort((left, right) => {
      if (left.confidence !== right.confidence) {
        return right.confidence - left.confidence;
      }
      return left.topicLabel.localeCompare(right.topicLabel);
    });
  return candidates[0] ?? null;
}

/**
 * Builds one synthesis candidate for a single episode.
 *
 * @param episode - Episode under evaluation.
 * @param facts - Candidate profile facts.
 * @returns Bounded synthesis candidate, or `null` when support stays weak.
 */
function buildEpisodeSynthesisCandidate(
  episode: MemorySynthesisEpisodeRecord,
  facts: readonly MemorySynthesisFactRecord[]
): BoundedMemorySynthesis | null {
  const supportingFacts = selectSupportingFactsForEpisode(episode, facts, 2);
  const openLoopCount = episode.openLoopLinks.filter((entry) => entry.status === "open").length;
  const entitySupport = episode.entityLinks.length;
  const score =
    (supportingFacts.length * 4) +
    (openLoopCount * 3) +
    entitySupport +
    EPISODE_STATUS_WEIGHT[episode.status];

  if (score < 4) {
    return null;
  }

  const evidence: MemorySynthesisEvidence[] = [
    {
      kind: "episode",
      label: episode.title,
      detail: episode.summary
    }
  ];

  if (openLoopCount > 0) {
    evidence.push({
      kind: "open_loop",
      label: "open loops",
      detail: `${openLoopCount} unresolved follow-up ${openLoopCount === 1 ? "signal" : "signals"} remain linked to this situation`
    });
  }

  if (entitySupport > 0) {
    evidence.push({
      kind: "entity_link",
      label: "entity linkage",
      detail: episode.entityLinks.map((entry) => entry.canonicalName).join(", ")
    });
  }

  for (const fact of supportingFacts) {
    evidence.push({
      kind: "fact",
      label: fact.key,
      detail: fact.value
    });
  }

  const confidence = Number(
    Math.min(
      0.95,
      0.42 +
        (supportingFacts.length * 0.12) +
        (openLoopCount * 0.1) +
        (entitySupport * 0.04) +
        (EPISODE_STATUS_WEIGHT[episode.status] * 0.04)
    ).toFixed(2)
  );

  const supportingFactSummary = supportingFacts.length > 0
    ? ` Supporting facts: ${supportingFacts
      .map((fact) => `${fact.key}=${fact.value}`)
      .join("; ")}.`
    : "";

  return {
    topicLabel: episode.title,
    summary:
      `${episode.summary}${supportingFactSummary}`.trim(),
    confidence,
    openLoopCount,
    primaryEpisode: episode,
    supportingFacts,
    evidence
  };
}
