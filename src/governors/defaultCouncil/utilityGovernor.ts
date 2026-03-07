/**
 * @fileoverview Implements the default utility governor.
 */

import { approve, normalize, rejectWithCategory } from "./common";
import { DefaultGovernor } from "./contracts";
import { getModelAdvisoryRejection } from "./modelAdvisory";

export const utilityGovernor: DefaultGovernor = {
  id: "utility",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps goal-alignment checks explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses shared advisory helpers from this subsystem.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `Promise<import("./contracts").DefaultGovernorVote>` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("utility", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    if (!context.task.goal.trim()) {
      return rejectWithCategory(
        "utility",
        "Task has no goal, utility cannot be established.",
        "UTILITY_ALIGNMENT"
      );
    }

    if (
      proposal.action.type === "self_modify" &&
      !normalize(context.task.goal).includes("improve")
    ) {
      return rejectWithCategory(
        "utility",
        "Self-modification is not clearly tied to the user goal for this request.",
        "UTILITY_ALIGNMENT"
      );
    }

    return approve("utility", "Action appears useful relative to task goal.");
  }
};
