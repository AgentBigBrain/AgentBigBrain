/**
 * @fileoverview Implements the default ethics governor.
 */

import { classifySafetyAbuseText } from "../safetyLexicon";
import { approve, normalize, rejectWithCategory, SAFETY_LEXICON_RULE_CONTEXT } from "./common";
import { DefaultGovernor } from "./contracts";
import { getModelAdvisoryRejection } from "./modelAdvisory";

export const ethicsGovernor: DefaultGovernor = {
  id: "ethics",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps ethical-abuse screening explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `classifySafetyAbuseText` (import `classifySafetyAbuseText`) from `../safetyLexicon`.
   * - Uses shared advisory helpers from this subsystem.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `Promise<import("./contracts").DefaultGovernorVote>` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("ethics", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    const combinedText = normalize(`${proposal.action.description} ${proposal.rationale}`);
    const abuseClassification = classifySafetyAbuseText(
      combinedText,
      SAFETY_LEXICON_RULE_CONTEXT
    );
    if (abuseClassification.category === "ABUSE_SIGNAL") {
      return rejectWithCategory(
        "ethics",
        "Proposal language indicates harmful or abusive intent.",
        "ABUSE_MALWARE_OR_FRAUD"
      );
    }
    return approve("ethics", "No clear ethical abuse signals found.");
  }
};
