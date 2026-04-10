/**
 * @fileoverview Adapts legacy bounded memory-synthesis inputs onto the canonical temporal core.
 */

import {
  synthesizeProfileMemoryTemporalEvidence
} from "../../core/profileMemoryRuntime/profileMemoryTemporalSynthesis";
import type { TemporalMemorySynthesis } from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import type {
  BoundedMemorySynthesis,
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./contracts";
import {
  buildCompatibilitySlice,
  toLaneBoundary
} from "./temporalSynthesisAdapterCompatibilitySupport";
import {
  buildEvidence,
  deriveConfidence,
  deriveSummary,
  selectPrimaryEpisodeSupportCandidate
} from "./temporalSynthesisAdapterLegacySupport";

/**
 * Builds the canonical temporal synthesis for legacy continuity fact and episode inputs.
 */
export function buildTemporalMemorySynthesisFromCompatibilityRecords(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): TemporalMemorySynthesis | null {
  if (episodes.length === 0 && facts.length === 0) {
    return null;
  }
  return synthesizeProfileMemoryTemporalEvidence(
    buildCompatibilitySlice(episodes, facts)
  );
}

/**
 * Adapts the canonical temporal synthesis into the legacy bounded synthesis surface.
 */
export function adaptTemporalMemorySynthesisToBoundedMemorySynthesis(
  synthesis: TemporalMemorySynthesis,
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): BoundedMemorySynthesis {
  const primaryEpisodeCandidate = selectPrimaryEpisodeSupportCandidate(episodes, facts);
  const primaryEpisode = primaryEpisodeCandidate?.episode ?? {
    episodeId: "temporal_adapter_episode_none",
    title: synthesis.currentState[0] ?? synthesis.historicalContext[0] ?? "profile memory",
    summary: deriveSummary(synthesis),
    status: synthesis.answerMode === "historical" ? "resolved" : "unresolved",
    lastMentionedAt: new Date(0).toISOString(),
    entityRefs: [],
    entityLinks: [],
    openLoopLinks: []
  };
  const laneBoundaries = synthesis.laneMetadata.map((lane) =>
    toLaneBoundary(lane, {
      semanticMode: synthesis.proof.semanticMode,
      relevanceScope: synthesis.proof.relevanceScope,
      scopedThreadKeys: []
    })
  );
  return {
    contractMode: "legacy_adapter_only",
    topicLabel: primaryEpisode.title,
    summary: deriveSummary(synthesis),
    confidence: primaryEpisodeCandidate?.confidence ?? deriveConfidence(synthesis.answerMode),
    openLoopCount: primaryEpisodeCandidate?.openLoopCount ??
      primaryEpisode.openLoopLinks.filter((entry) => entry.status === "open").length,
    primaryEpisode,
    supportingFacts: [...(primaryEpisodeCandidate?.supportingFacts ?? facts.slice(0, 3))],
    evidence: buildEvidence(synthesis, primaryEpisodeCandidate, facts),
    decisionRecords: facts
      .map((fact) => fact.decisionRecord)
      .filter((record): record is NonNullable<typeof record> => record !== undefined),
    temporalSynthesis: synthesis,
    laneBoundaries
  };
}

/**
 * Builds the legacy bounded synthesis output by first running the canonical temporal core.
 */
export function buildLegacyCompatibleTemporalSynthesis(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): BoundedMemorySynthesis | null {
  const synthesis = buildTemporalMemorySynthesisFromCompatibilityRecords(episodes, facts);
  if (!synthesis) {
    return null;
  }
  const primaryEpisodeCandidate = selectPrimaryEpisodeSupportCandidate(episodes, facts);
  if (
    primaryEpisodeCandidate !== null &&
    primaryEpisodeCandidate.score < 4 &&
    facts.length === 0
  ) {
    return null;
  }
  return adaptTemporalMemorySynthesisToBoundedMemorySynthesis(synthesis, episodes, facts);
}
