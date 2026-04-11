/**
 * @fileoverview Legacy compatibility wrapper for bounded continuity synthesis.
 */

import type {
  BoundedMemorySynthesis,
  MemorySynthesisEpisodeRecord,
  MemorySynthesisFactRecord
} from "./contracts";
import type { TemporalMemorySynthesis } from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import { buildRecallSynthesis } from "./recallSynthesis";

/**
 * Preserves the continuity synthesis entrypoint while requiring canonical temporal synthesis.
 *
 * @param temporalSynthesis - Canonical temporal synthesis for this continuity request.
 * @param episodes - Continuity-linked remembered situations.
 * @param facts - Candidate bounded profile facts.
 * @returns Best bounded synthesis, or `null` when support stays weak.
 */
export function buildContinuityMemorySynthesis(
  temporalSynthesis: TemporalMemorySynthesis | null,
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): BoundedMemorySynthesis | null {
  return buildRecallSynthesis(temporalSynthesis, episodes, facts);
}
