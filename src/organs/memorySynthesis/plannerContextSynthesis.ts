/**
 * @fileoverview Planner-facing bounded synthesis rendering.
 */

import type { TemporalMemorySynthesis } from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import type {
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./contracts";
import { buildLegacyCompatibleTemporalSynthesis } from "./temporalSynthesisAdapter";

const MAX_PLANNER_CURRENT_STATE_LINES = 3;
const MAX_PLANNER_HISTORICAL_LINES = 2;
const MAX_PLANNER_CONTRADICTION_LINES = 2;

/**
 * Renders one bounded temporal lane section for planner-facing prompt injection.
 *
 * @param label - Canonical temporal lane label.
 * @param lines - Lane lines already synthesized by the temporal core.
 * @param maxLines - Maximum number of lines to emit for this section.
 * @returns Planner-facing section lines with a fail-closed `none` placeholder when empty.
 */
function renderPlannerTemporalSection(
  label: "Current State" | "Historical Context" | "Contradiction Notes",
  lines: readonly string[],
  maxLines: number
): readonly string[] {
  const boundedLines = lines.slice(0, maxLines);
  return [
    `${label}:`,
    ...(boundedLines.length > 0 ? boundedLines.map((line) => `- ${line}`) : ["- none"])
  ];
}

/**
 * Builds one bounded planner-facing synthesis block from remembered situations and facts.
 *
 * This renderer prefers already-derived temporal synthesis, but it retains a compatibility overload
 * so older adapter-only tests can still hand it legacy episode/fact records.
 *
 * @param synthesisOrEpisodes - Canonical temporal synthesis, or compatibility episodes.
 * @param facts - Planner-relevant facts when compatibility episodes are supplied.
 * @returns Multi-line synthesis block or empty string when support is weak.
 */
export function buildPlannerContextSynthesisBlock(
  synthesis: TemporalMemorySynthesis | null
): string;
/**
 * Builds one planner-facing temporal split-view block from compatibility records.
 *
 * @param episodes - Planner-relevant remembered situations.
 * @param facts - Planner-relevant facts.
 * @returns Multi-line synthesis block or empty string when support is weak.
 */
export function buildPlannerContextSynthesisBlock(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts?: readonly MemorySynthesisFactRecord[]
): string;
/**
 * Builds one bounded planner-facing temporal split-view block.
 *
 * @param synthesisOrEpisodes - Canonical temporal synthesis, or compatibility episodes.
 * @param facts - Planner-relevant facts when compatibility episodes are supplied.
 * @returns Multi-line synthesis block or empty string when support is weak.
 */
export function buildPlannerContextSynthesisBlock(
  synthesisOrEpisodes: TemporalMemorySynthesis | null | readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[] = []
): string {
  let synthesis: TemporalMemorySynthesis | null;
  if (Array.isArray(synthesisOrEpisodes)) {
    synthesis = buildLegacyCompatibleTemporalSynthesis(
      synthesisOrEpisodes,
      facts
    )?.temporalSynthesis ?? null;
  } else {
    synthesis = synthesisOrEpisodes as TemporalMemorySynthesis | null;
  }
  if (
    !synthesis ||
    (
      synthesis.currentState.length === 0 &&
      synthesis.historicalContext.length === 0 &&
      synthesis.contradictionNotes.length === 0
    )
  ) {
    return "";
  }

  return [
    "Temporal memory context (bounded):",
    ...renderPlannerTemporalSection(
      "Current State",
      synthesis.currentState,
      MAX_PLANNER_CURRENT_STATE_LINES
    ),
    ...renderPlannerTemporalSection(
      "Historical Context",
      synthesis.historicalContext,
      MAX_PLANNER_HISTORICAL_LINES
    ),
    ...renderPlannerTemporalSection(
      "Contradiction Notes",
      synthesis.contradictionNotes,
      MAX_PLANNER_CONTRADICTION_LINES
    )
  ].join("\n");
}
