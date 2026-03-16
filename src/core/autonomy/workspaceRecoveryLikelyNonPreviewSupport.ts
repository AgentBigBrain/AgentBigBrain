/**
 * @fileoverview Shared likely non-preview holder clarification wording for bounded workspace recovery.
 */

import { buildLikelyNonPreviewClarificationSignal } from "./workspaceRecoverySignalBuilders";
import {
  buildLikelyNonPreviewHolderSetDescription,
  formatNamedHolderExamples
} from "./workspaceRecoveryNarration";

interface BuildLikelyNonPreviewClarificationArgs {
  matchedRuleId: string;
  reasoning: string;
  leadIn: string;
  candidatePids: readonly number[];
  candidateKinds: readonly string[];
  candidateNames: readonly string[];
  blockedFolderPaths?: readonly string[];
}

/**
 * Builds one bounded likely non-preview holder clarification signal from inspected candidate
 * names and pids.
 *
 * @param args - Structured likely-holder clarification inputs.
 * @returns Normalized clarification signal.
 */
export function buildWorkspaceRecoveryLikelyNonPreviewClarification(
  args: BuildLikelyNonPreviewClarificationArgs
) {
  const holderExamples = formatNamedHolderExamples(args.candidateNames);
  const holderCountLead = buildLikelyNonPreviewHolderSetDescription(
    args.candidateKinds,
    args.candidatePids.length
  );
  const holderPidClause =
    args.candidatePids.length > 0
      ? ` Candidate pid${args.candidatePids.length > 1 ? "s" : ""}: ${args.candidatePids.join(", ")}.`
      : "";
  return buildLikelyNonPreviewClarificationSignal({
    matchedRuleId: args.matchedRuleId,
    reasoning: args.reasoning,
    question:
      args.leadIn +
      holderExamples +
      holderPidClause +
      " They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?",
    recoveryInstruction:
      `Recovery instruction: stop only ${holderCountLead} if those likely local non-preview holders are still active: ` +
      args.candidatePids.map((pid) => `pid=${pid}`).join(", ") +
      ". Do not broaden beyond those inspected pids or stop apps by name. Verify they stopped, then retry the original folder-organization request. If any holder no longer matches, explain that plainly instead of guessing.",
    untrackedCandidatePids: args.candidatePids,
    untrackedCandidateKinds: args.candidateKinds,
    untrackedCandidateNames: args.candidateNames,
    blockedFolderPaths: args.blockedFolderPaths
  });
}
