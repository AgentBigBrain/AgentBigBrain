/**
 * @fileoverview Implements the default resource governor.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { approve, rejectWithCategory } from "./common";
import { DefaultGovernor } from "./contracts";
import { getModelAdvisoryRejection } from "./modelAdvisory";

export const resourceGovernor: DefaultGovernor = {
  id: "resource",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps cost-bound checks explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../../core/actionCostPolicy`.
   * - Uses shared advisory helpers from this subsystem.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `Promise<import("./contracts").DefaultGovernorVote>` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("resource", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    const deterministicCostUsd = estimateActionCostUsd({
      type: proposal.action.type,
      params: proposal.action.params
    });
    if (deterministicCostUsd > context.config.limits.maxEstimatedCostUsd) {
      return rejectWithCategory(
        "resource",
        `Deterministic cost ${deterministicCostUsd.toFixed(2)} exceeds configured limit.`,
        "RESOURCE_BUDGET"
      );
    }
    return approve("resource", "Estimated resource usage is within limit.");
  }
};
