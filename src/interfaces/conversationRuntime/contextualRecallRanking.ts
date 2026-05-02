/**
 * @fileoverview Ranks bounded contextual-recall candidates for active conversation turns.
 */

import type { ProfileEpisodeStatus } from "../../core/profileMemory";
import type { SourceAuthority } from "../../core/sourceAuthority";
import type {
  MemoryPlannerAuthority,
  MemoryRetrievalMode
} from "../../organs/memoryContext/contracts";

export interface ContextualRecallCandidate {
  kind: "thread" | "episode";
  threadKey: string;
  topicLabel: string;
  supportingCue: string;
  openLoopCount: number;
  lastTouchedAt: string;
  relevanceScore: number;
  matchSource?: "thread_context" | "open_loop_resume";
  matchedOpenLoopId?: string;
  matchedHintTerms?: readonly string[];
  episodeId?: string;
  episodeStatus?: ProfileEpisodeStatus;
  episodeSummary?: string;
  entityRefs?: readonly string[];
  retrievalMode: MemoryRetrievalMode;
  sourceAuthority: SourceAuthority;
  plannerAuthority: MemoryPlannerAuthority;
  currentTruthAuthority: boolean;
}

const EPISODE_STATUS_PRIORITY: Record<ProfileEpisodeStatus, number> = {
  unresolved: 3,
  outcome_unknown: 2,
  partially_resolved: 1,
  resolved: 0,
  no_longer_relevant: 0
};

/**
 * Computes the deterministic ranking score for one contextual-recall candidate.
 *
 * @param candidate - Candidate under evaluation.
 * @returns Stable numeric ranking score.
 */
function computeContextualRecallScore(candidate: ContextualRecallCandidate): number {
  const kindWeight = candidate.kind === "episode" ? 10 : 0;
  const statusWeight = candidate.episodeStatus
    ? EPISODE_STATUS_PRIORITY[candidate.episodeStatus] * 2
    : 0;
  const openLoopWeight = candidate.openLoopCount * 0.5;
  const openLoopResumeWeight = candidate.matchSource === "open_loop_resume" ? 2 : 0;
  const recencyValue = Date.parse(candidate.lastTouchedAt);
  const recencyWeight = Number.isFinite(recencyValue)
    ? recencyValue / 1_000_000_000_000
    : 0;
  return candidate.relevanceScore + kindWeight + statusWeight + openLoopWeight + openLoopResumeWeight + recencyWeight;
}

/**
 * Selects the best bounded contextual-recall candidate for the current user turn.
 *
 * @param candidates - Candidate set assembled from paused-thread and episodic-memory signals.
 * @returns Best candidate, or `null` when no bounded recall is worth surfacing.
 */
export function selectBestContextualRecallCandidate(
  candidates: readonly ContextualRecallCandidate[]
): ContextualRecallCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates]
    .sort((left, right) => {
      const scoreDelta =
        computeContextualRecallScore(right) - computeContextualRecallScore(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      if (left.kind !== right.kind) {
        return left.kind === "episode" ? -1 : 1;
      }
      if (left.lastTouchedAt !== right.lastTouchedAt) {
        return right.lastTouchedAt.localeCompare(left.lastTouchedAt);
      }
      if (left.topicLabel !== right.topicLabel) {
        return left.topicLabel.localeCompare(right.topicLabel);
      }
      return left.threadKey.localeCompare(right.threadKey);
    })[0] ?? null;
}
