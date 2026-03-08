/**
 * @fileoverview Recall-facing bounded synthesis helpers.
 */

import type {
  BoundedMemorySynthesis,
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./contracts";
import { buildContinuityMemorySynthesis } from "./continuitySynthesis";

/**
 * Produces one bounded recall synthesis for inline conversation follow-up.
 *
 * @param episodes - Continuity-linked episodes under consideration.
 * @param facts - Continuity-linked facts under consideration.
 * @returns Best bounded synthesis, or `null` when support is too weak.
 */
export function buildRecallSynthesis(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): BoundedMemorySynthesis | null {
  return buildContinuityMemorySynthesis(episodes, facts);
}
