/**
 * @fileoverview Implements the default security governor.
 */

import { classifySafetyDestructiveCommandText } from "../safetyLexicon";
import {
  approve,
  getParamString,
  normalize,
  rejectWithCategory,
  SAFETY_LEXICON_RULE_CONTEXT
} from "./common";
import { DefaultGovernor } from "./contracts";
import { getModelAdvisoryRejection } from "./modelAdvisory";

export const securityGovernor: DefaultGovernor = {
  id: "security",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps security-boundary checks explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `classifySafetyDestructiveCommandText` (import `classifySafetyDestructiveCommandText`) from `../safetyLexicon`.
   * - Uses shared advisory helpers from this subsystem.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `Promise<import("./contracts").DefaultGovernorVote>` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("security", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    const action = proposal.action;
    if (action.type === "delete_file") {
      const targetPath = normalize(getParamString(action.params, "path") ?? "");
      const sandboxPrefix = normalize(context.config.dna.sandboxPathPrefix);
      if (!targetPath.startsWith(sandboxPrefix)) {
        return rejectWithCategory(
          "security",
          "Delete operation targets a path outside the sandbox.",
          "SECURITY_BOUNDARY"
        );
      }
    }

    if (action.type === "shell_command") {
      const command = normalize(getParamString(action.params, "command") ?? "");
      const destructiveClassification = classifySafetyDestructiveCommandText(
        command,
        SAFETY_LEXICON_RULE_CONTEXT
      );
      if (destructiveClassification.category === "DESTRUCTIVE_COMMAND_SIGNAL") {
        return rejectWithCategory(
          "security",
          "Shell command includes blocked destructive patterns.",
          "SECURITY_BOUNDARY"
        );
      }
    }

    if (action.type === "self_modify" && proposal.touchesImmutable) {
      return rejectWithCategory(
        "security",
        "Self-modification touches immutable system rules.",
        "IDENTITY_INTEGRITY"
      );
    }

    return approve("security", "No direct security violations detected.");
  }
};
