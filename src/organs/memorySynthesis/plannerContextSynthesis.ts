/**
 * @fileoverview Planner-facing bounded synthesis rendering.
 */

import type {
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./contracts";
import { buildContinuityMemorySynthesis } from "./continuitySynthesis";

/**
 * Builds one bounded planner-facing synthesis block from remembered situations and facts.
 *
 * @param episodes - Planner-relevant remembered situations.
 * @param facts - Planner-relevant facts.
 * @returns Multi-line synthesis block or empty string when support is weak.
 */
export function buildPlannerContextSynthesisBlock(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): string {
  const synthesis = buildContinuityMemorySynthesis(episodes, facts);
  if (!synthesis) {
    return "";
  }

  return [
    "- synthesized situation:",
    `  topic=${synthesis.topicLabel}`,
    `  confidence=${synthesis.confidence.toFixed(2)}`,
    `  summary=${synthesis.summary}`,
    ...synthesis.evidence.slice(0, 3).map(
      (evidence) => `  evidence=${evidence.kind}:${evidence.label} -> ${evidence.detail}`
    )
  ].join("\n");
}
