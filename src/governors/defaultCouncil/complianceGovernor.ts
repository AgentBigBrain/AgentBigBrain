/**
 * @fileoverview Implements the default compliance governor.
 */

import { approve, getParamString, normalize, rejectWithCategory } from "./common";
import { DefaultGovernor } from "./contracts";
import { getModelAdvisoryRejection } from "./modelAdvisory";

export const complianceGovernor: DefaultGovernor = {
  id: "compliance",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps compliance-policy checks explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses shared advisory helpers from this subsystem.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `Promise<import("./contracts").DefaultGovernorVote>` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("compliance", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    if (
      proposal.action.type === "network_write" &&
      !context.config.permissions.allowNetworkWriteAction
    ) {
      return rejectWithCategory(
        "compliance",
        "Network write is not enabled by policy.",
        "COMPLIANCE_POLICY"
      );
    }

    if (proposal.action.type === "write_file") {
      const targetPath = normalize(getParamString(proposal.action.params, "path") ?? "");
      const protectedPrefix = context.config.dna.protectedPathPrefixes.map((prefix) =>
        normalize(prefix)
      );
      if (protectedPrefix.some((prefix) => targetPath.startsWith(prefix))) {
        return rejectWithCategory(
          "compliance",
          "Write targets a policy-protected path.",
          "COMPLIANCE_POLICY"
        );
      }
    }

    return approve("compliance", "No compliance policy violation found.");
  }
};
