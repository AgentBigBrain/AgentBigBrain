/**
 * @fileoverview Legacy bounded-output helpers for the temporal memory synthesis adapter.
 */

import type { TemporalMemorySynthesis } from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import type {
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

export interface LegacyEpisodeSupportCandidate {
  episode: MemorySynthesisEpisodeRecord;
  supportingFacts: readonly MemorySynthesisFactRecord[];
  openLoopCount: number;
  entitySupport: number;
  score: number;
  confidence: number;
}

/**
 * Builds one episode support candidate with deterministic support and confidence scoring.
 *
 * **Why it exists:**
 * The adapter still needs a primary episode for legacy UI surfaces, so this helper keeps that
 * bounded heuristic centralized.
 *
 * **What it talks to:**
 * - Uses `selectSupportingFactsForEpisode` (import `selectSupportingFactsForEpisode`) from `./episodeFactReconciliation`.
 *
 * @param episode - Episode candidate under scoring.
 * @param facts - Legacy fact candidates available for support.
 * @returns Episode support candidate with bounded score metadata.
 */
export function buildLegacyEpisodeSupportCandidate(
  episode: MemorySynthesisEpisodeRecord,
  facts: readonly MemorySynthesisFactRecord[]
): LegacyEpisodeSupportCandidate {
  const supportingFacts = selectSupportingFactsForEpisode(episode, facts, 2);
  const openLoopCount = episode.openLoopLinks.filter((entry) => entry.status === "open").length;
  const entitySupport = episode.entityLinks.length;
  const score =
    (supportingFacts.length * 4) +
    (openLoopCount * 3) +
    entitySupport +
    EPISODE_STATUS_WEIGHT[episode.status];
  return {
    episode,
    supportingFacts,
    openLoopCount,
    entitySupport,
    score,
    confidence: Number(
      Math.min(
        0.95,
        0.42 +
          (supportingFacts.length * 0.12) +
          (openLoopCount * 0.1) +
          (entitySupport * 0.04) +
          (EPISODE_STATUS_WEIGHT[episode.status] * 0.04)
      ).toFixed(2)
    )
  };
}

/**
 * Selects the primary legacy episode support candidate.
 *
 * **Why it exists:**
 * The legacy bounded output wants one representative episode, so the ranking rule should remain
 * deterministic and isolated.
 *
 * **What it talks to:**
 * - Uses `buildLegacyEpisodeSupportCandidate` (import `buildLegacyEpisodeSupportCandidate`) from `./temporalSynthesisAdapterLegacySupport`.
 *
 * @param episodes - Legacy episode candidates.
 * @param facts - Legacy fact candidates available for support.
 * @returns Highest-ranked support candidate, or `null` when none exist.
 */
export function selectPrimaryEpisodeSupportCandidate(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): LegacyEpisodeSupportCandidate | null {
  const candidates = episodes
    .map((episode) => buildLegacyEpisodeSupportCandidate(episode, facts))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.confidence !== right.confidence) {
        return right.confidence - left.confidence;
      }
      return left.episode.title.localeCompare(right.episode.title);
    });
  return candidates[0] ?? null;
}

/**
 * Builds bounded legacy evidence cards from canonical temporal synthesis plus support candidates.
 *
 * **Why it exists:**
 * The adapter must keep legacy evidence explainable without letting each caller assemble its own
 * hybrid evidence list.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param synthesis - Canonical temporal synthesis result.
 * @param primaryEpisodeCandidate - Selected legacy primary episode candidate, if any.
 * @param fallbackFacts - Fallback fact set used when no episode support candidate exists.
 * @returns Bounded legacy evidence records.
 */
export function buildEvidence(
  synthesis: TemporalMemorySynthesis,
  primaryEpisodeCandidate: LegacyEpisodeSupportCandidate | null,
  fallbackFacts: readonly MemorySynthesisFactRecord[]
): readonly MemorySynthesisEvidence[] {
  const evidence: MemorySynthesisEvidence[] = [];
  if (primaryEpisodeCandidate) {
    evidence.push({
      kind: "episode",
      label: primaryEpisodeCandidate.episode.title,
      detail: primaryEpisodeCandidate.episode.summary
    });
  }
  if (primaryEpisodeCandidate && primaryEpisodeCandidate.openLoopCount > 0) {
    evidence.push({
      kind: "open_loop",
      label: "open loops",
      detail: `${primaryEpisodeCandidate.openLoopCount} unresolved follow-up ${primaryEpisodeCandidate.openLoopCount === 1 ? "signal" : "signals"} remain linked to this situation`
    });
  }
  if (primaryEpisodeCandidate && primaryEpisodeCandidate.entitySupport > 0) {
    evidence.push({
      kind: "entity_link",
      label: "entity linkage",
      detail: primaryEpisodeCandidate.episode.entityLinks.map((entry) => entry.canonicalName).join(", ")
    });
  }
  const supportingFacts = primaryEpisodeCandidate?.supportingFacts ?? fallbackFacts.slice(0, 2);
  for (const fact of supportingFacts) {
    evidence.push({
      kind: "fact",
      label: fact.key,
      detail: fact.value
    });
  }
  for (const note of synthesis.contradictionNotes.slice(0, 1)) {
    evidence.push({
      kind: "fact",
      label: "contradiction",
      detail: note
    });
  }
  while (evidence.length < 3) {
    const nextLine =
      synthesis.currentState[evidence.length - 1] ??
      synthesis.historicalContext[evidence.length - 1] ??
      null;
    if (nextLine === null) {
      break;
    }
    evidence.push({
      kind: "fact",
      label: "temporal",
      detail: nextLine
    });
  }
  return evidence;
}

/**
 * Derives the bounded legacy summary string from the canonical temporal synthesis.
 *
 * **Why it exists:**
 * The adapter still exposes one summary string, so the prioritization of current, historical, and
 * contradiction lines must stay centralized.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param synthesis - Canonical temporal synthesis result.
 * @returns Legacy summary string.
 */
export function deriveSummary(synthesis: TemporalMemorySynthesis): string {
  if (synthesis.answerMode === "quarantined_identity") {
    return "Identity remains quarantined; current truth is intentionally withheld.";
  }
  if (synthesis.currentState.length > 0) {
    return [
      synthesis.currentState.join("; "),
      ...(synthesis.historicalContext[0] ? [synthesis.historicalContext[0]] : [])
    ].join(" | ");
  }
  if (synthesis.historicalContext.length > 0) {
    return synthesis.historicalContext.join("; ");
  }
  if (synthesis.contradictionNotes.length > 0) {
    return synthesis.contradictionNotes.join("; ");
  }
  return "Insufficient evidence for a bounded temporal summary.";
}

/**
 * Derives the fallback legacy confidence from the canonical answer mode.
 *
 * **Why it exists:**
 * When no primary episode candidate exists, the adapter still needs a bounded confidence number.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param answerMode - Canonical temporal answer mode.
 * @returns Legacy fallback confidence.
 */
export function deriveConfidence(answerMode: TemporalMemorySynthesis["answerMode"]): number {
  switch (answerMode) {
    case "current":
      return 0.86;
    case "historical":
      return 0.74;
    case "ambiguous":
      return 0.52;
    case "quarantined_identity":
      return 0.4;
    default:
      return 0.28;
  }
}
