import { BrainConfig } from "../config";
import { GovernanceProposal } from "../types";

/**
 * Detects whether a self-modification proposal targets immutable governance controls.
 *
 * **Why it exists:**
 * Some control-plane files and keywords are never allowed to be changed by runtime proposals.
 * This guard enforces that boundary even if planner metadata does not explicitly flag immutability.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` from `../config`.
 * - Uses `GovernanceProposal` from `../types`.
 *
 * @param proposal - Candidate governance proposal under evaluation.
 * @param config - Active brain configuration containing immutable keyword policy.
 * @returns `true` when the proposal touches immutable targets/keywords.
 */
export function detectImmutableTouch(proposal: GovernanceProposal, config: BrainConfig): boolean {
  if (proposal.touchesImmutable) {
    return true;
  }

  const target = typeof proposal.action.params.target === "string" ? proposal.action.params.target : null;
  if (!target) {
    return false;
  }

  const normalizedTarget = target.toLowerCase();
  return config.dna.immutableKeywords.some((keyword) => normalizedTarget.includes(keyword));
}
