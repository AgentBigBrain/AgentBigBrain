/**
 * @fileoverview Implements the default logic governor.
 */

import { approve, rejectWithCategory } from "./common";
import { DefaultGovernor } from "./contracts";
import { getModelAdvisoryRejection } from "./modelAdvisory";

export const logicGovernor: DefaultGovernor = {
  id: "logic",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps rationale-quality checks explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses shared advisory helpers from this subsystem.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `Promise<import("./contracts").DefaultGovernorVote>` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("logic", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    if (proposal.rationale.trim().length < 20) {
      return rejectWithCategory(
        "logic",
        "Rationale is too short to justify the action.",
        "RATIONALE_QUALITY"
      );
    }
    if (proposal.action.description.trim().length < 10) {
      return rejectWithCategory(
        "logic",
        "Action description is too vague.",
        "RATIONALE_QUALITY"
      );
    }
    return approve("logic", "Rationale and action description are coherent.");
  }
};
