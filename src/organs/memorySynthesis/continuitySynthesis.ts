/**
 * @fileoverview Legacy compatibility wrapper for bounded continuity synthesis.
 */

import type {
  BoundedMemorySynthesis,
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./contracts";
import { buildLegacyCompatibleTemporalSynthesis } from "./temporalSynthesisAdapter";

/**
 * Preserves the legacy continuity entrypoint by delegating to the canonical temporal adapter.
 *
 * @param episodes - Continuity-linked remembered situations.
 * @param facts - Candidate bounded profile facts.
 * @returns Best bounded synthesis, or `null` when support stays weak.
 */
export function buildContinuityMemorySynthesis(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): BoundedMemorySynthesis | null {
  return buildLegacyCompatibleTemporalSynthesis(episodes, facts);
}
