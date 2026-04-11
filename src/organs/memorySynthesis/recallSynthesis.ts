/**
 * @fileoverview Recall-facing bounded synthesis helpers.
 */

import type { TemporalMemorySynthesis } from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import type {
  BoundedMemorySynthesisShadowParity,
  BoundedMemorySynthesis,
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./contracts";
import {
  adaptTemporalMemorySynthesisToBoundedMemorySynthesis,
  buildLegacyCompatibleTemporalSynthesis
} from "./temporalSynthesisAdapter";
import { selectPrimaryEpisodeSupportCandidate } from "./temporalSynthesisAdapterLegacySupport";

/**
 * Serializes the bounded recall decision shape for Phase 7 shadow-parity comparison.
 *
 * @param synthesis - Bounded recall synthesis under comparison.
 * @returns Deterministic serialized decision shape.
 */
function serializeRecallDecisionShape(synthesis: BoundedMemorySynthesis): string {
  return JSON.stringify({
    answerMode: synthesis.temporalSynthesis.answerMode,
    currentState: synthesis.temporalSynthesis.currentState,
    historicalContext: synthesis.temporalSynthesis.historicalContext,
    contradictionNotes: synthesis.temporalSynthesis.contradictionNotes,
    laneBoundaries: synthesis.laneBoundaries.map((lane) => ({
      laneId: lane.laneId,
      domainLane: lane.domainLane,
      semanticMode: lane.semanticMode,
      relevanceScope: lane.relevanceScope,
      scopedThreadKeys: lane.scopedThreadKeys,
      answerMode: lane.answerMode,
      dominantLane: lane.dominantLane,
      supportingLanes: lane.supportingLanes,
      overflowNote: lane.overflowNote,
      degradedNotes: lane.degradedNotes
    }))
  });
}

/**
 * Compares temporal recall output against the compatibility fallback on both decision shape and
 * rendered split-view support lines.
 *
 * @param synthesis - Primary temporal-driven bounded synthesis.
 * @param compatibilityShadow - Compatibility fallback synthesis built from legacy episode/fact inputs.
 * @returns Bounded shadow-parity result for Phase 7 cutover checks.
 */
function compareRecallShadowParity(
  synthesis: BoundedMemorySynthesis,
  compatibilityShadow: BoundedMemorySynthesis | null
): BoundedMemorySynthesisShadowParity {
  if (!compatibilityShadow) {
    return {
      compared: true,
      decisionMatches: false,
      renderMatches: false,
      mismatchedFields: ["compatibility_suppressed"]
    };
  }

  const mismatchedFields: string[] = [];
  if (synthesis.temporalSynthesis.answerMode !== compatibilityShadow.temporalSynthesis.answerMode) {
    mismatchedFields.push("answer_mode");
  }
  if (
    JSON.stringify(synthesis.temporalSynthesis.currentState) !==
    JSON.stringify(compatibilityShadow.temporalSynthesis.currentState)
  ) {
    mismatchedFields.push("current_state");
  }
  if (
    JSON.stringify(synthesis.temporalSynthesis.historicalContext) !==
    JSON.stringify(compatibilityShadow.temporalSynthesis.historicalContext)
  ) {
    mismatchedFields.push("historical_context");
  }
  if (
    JSON.stringify(synthesis.temporalSynthesis.contradictionNotes) !==
    JSON.stringify(compatibilityShadow.temporalSynthesis.contradictionNotes)
  ) {
    mismatchedFields.push("contradiction_notes");
  }
  if (serializeRecallDecisionShape(synthesis) !== serializeRecallDecisionShape(compatibilityShadow)) {
    mismatchedFields.push("lane_boundaries");
  }

  const renderMatches =
    JSON.stringify(renderRecallSynthesisSupportLines(synthesis)) ===
    JSON.stringify(renderRecallSynthesisSupportLines(compatibilityShadow));
  if (!renderMatches) {
    mismatchedFields.push("rendered_split_view");
  }

  return {
    compared: true,
    decisionMatches: mismatchedFields.every((field) => field === "rendered_split_view"),
    renderMatches,
    mismatchedFields: [...new Set(mismatchedFields)]
  };
}

/**
 * Renders one compact temporal lane line for bounded recall prompt guidance.
 *
 * @param label - Canonical temporal lane label.
 * @param lines - Lane lines already synthesized by the temporal core.
 * @param maxLines - Maximum number of entries to surface for this lane.
 * @returns Single prompt-facing line for the lane with a fail-closed `none` placeholder.
 */
function renderRecallTemporalSection(
  label: "Current State" | "Historical Context" | "Contradiction Notes",
  lines: readonly string[],
  maxLines: number
): string {
  const boundedLines = lines.slice(0, maxLines);
  return `- ${label}: ${boundedLines.length > 0 ? boundedLines.join("; ") : "none"}`;
}

/**
 * Produces one bounded recall synthesis for inline conversation follow-up.
 *
 * This helper consumes already-derived temporal synthesis for live runtime callers. The older
 * compatibility adapter remains bounded to explicit shadow-parity comparison instead of
 * participating as a second runtime owner of recall decisions.
 *
 * @param temporalSynthesis - Canonical temporal synthesis for this recall surface.
 * @param episodes - Continuity-linked episodes under consideration.
 * @param facts - Continuity-linked facts under consideration.
 * @returns Best bounded synthesis, or `null` when support is too weak.
 */
export function buildRecallSynthesis(
  temporalSynthesis: TemporalMemorySynthesis | null,
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): BoundedMemorySynthesis | null {
  if (!temporalSynthesis) {
    return null;
  }
  const primaryEpisodeCandidate = selectPrimaryEpisodeSupportCandidate(episodes, facts);
  if (primaryEpisodeCandidate !== null && primaryEpisodeCandidate.score < 4 && facts.length === 0) {
    return null;
  }
  const synthesis = adaptTemporalMemorySynthesisToBoundedMemorySynthesis(
    temporalSynthesis,
    episodes,
    facts
  );
  const compatibilityShadow = buildLegacyCompatibleTemporalSynthesis(
    episodes,
    facts
  );
  return {
    ...synthesis,
    shadowParity: compareRecallShadowParity(synthesis, compatibilityShadow)
  };
}

/**
 * Renders one compact split-view recall support bundle from the canonical temporal synthesis.
 *
 * @param synthesis - Bounded recall synthesis produced for the current turn.
 * @returns Prompt-facing split-view lines for current, historical, and contradiction context.
 */
export function renderRecallSynthesisSupportLines(
  synthesis: BoundedMemorySynthesis | null
): readonly string[] {
  if (!synthesis) {
    return [];
  }
  return [
    renderRecallTemporalSection("Current State", synthesis.temporalSynthesis.currentState, 2),
    renderRecallTemporalSection("Historical Context", synthesis.temporalSynthesis.historicalContext, 1),
    renderRecallTemporalSection("Contradiction Notes", synthesis.temporalSynthesis.contradictionNotes, 1)
  ];
}
