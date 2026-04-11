/**
 * @fileoverview Planner-facing bounded synthesis rendering.
 */

import type { TemporalMemorySynthesis } from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";

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
 * Builds one bounded planner-facing temporal split-view block.
 *
 * Live planner callers now hand this renderer canonical temporal synthesis directly instead of
 * rebuilding planner text from compatibility episode/fact arrays inside the renderer itself.
 *
 * @param synthesis - Canonical temporal synthesis for the current planner request.
 * @returns Multi-line synthesis block or empty string when support is weak.
 */
export function buildPlannerContextSynthesisBlock(
  synthesis: TemporalMemorySynthesis | null
): string {
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
