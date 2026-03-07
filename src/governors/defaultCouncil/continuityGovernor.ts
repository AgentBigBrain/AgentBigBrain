/**
 * @fileoverview Implements the default continuity governor.
 */

import { approve, getParamString, normalize, rejectWithCategory } from "./common";
import { DefaultGovernor } from "./contracts";
import { getModelAdvisoryRejection } from "./modelAdvisory";

export const continuityGovernor: DefaultGovernor = {
  id: "continuity",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps identity-continuity checks explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses shared advisory helpers from this subsystem.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `Promise<import("./contracts").DefaultGovernorVote>` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("continuity", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    if (proposal.touchesImmutable) {
      return rejectWithCategory(
        "continuity",
        "Proposal attempts to modify immutable identity constraints.",
        "IDENTITY_INTEGRITY"
      );
    }

    const target = normalize(getParamString(proposal.action.params, "target") ?? "");
    const touchesImmutableKeyword = context.config.dna.immutableKeywords.some((keyword) =>
      target.includes(normalize(keyword))
    );
    if (touchesImmutableKeyword) {
      return rejectWithCategory(
        "continuity",
        "Target contains immutable keyword.",
        "IDENTITY_INTEGRITY"
      );
    }

    return approve("continuity", "Identity continuity remains intact.");
  }
};
