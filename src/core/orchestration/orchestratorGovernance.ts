/**
 * @fileoverview Canonical governance-driven replan helpers for the core orchestrator.
 */

import { type ActionRunResult } from "../types";

/**
 * Extracts compact governor rejection notes to guide the next replan attempt.
 *
 * @param attemptResults - Action results from one planning attempt.
 * @returns Newline-joined rejection summary, or `null` when replanning is not needed.
 */
export function extractGovernanceReplanFeedback(
  attemptResults: readonly ActionRunResult[]
): string | null {
  if (attemptResults.some((result) => result.approved)) {
    return null;
  }

  const governanceBlocks = attemptResults.filter(
    (result) => !result.approved && result.violations.length === 0 && result.votes.length > 0
  );
  if (governanceBlocks.length === 0) {
    return null;
  }

  const notes = governanceBlocks.slice(0, 3).map((result) => {
    const voteReasons = result.votes
      .filter((vote) => !vote.approve)
      .slice(0, 4)
      .map((vote) => `${vote.governorId}: ${vote.reason}`)
      .join(" | ");
    return `${result.action.type}: ${voteReasons || "Blocked by governor policy."}`;
  });

  return notes.join("\n");
}

/**
 * Builds the planner prompt for the next governance-driven replan attempt.
 *
 * @param originalUserInput - Original user request text.
 * @param governanceFeedback - Governor rejection summary from prior attempt.
 * @param nextAttemptNumber - One-based attempt number about to be executed.
 * @returns Replan prompt string passed to planner.
 */
export function buildGovernanceReplanInput(
  originalUserInput: string,
  governanceFeedback: string,
  nextAttemptNumber: number
): string {
  return [
    originalUserInput,
    "",
    `Replan Attempt ${nextAttemptNumber}: the prior plan was blocked by governance.`,
    "Adjust the plan to satisfy governor policy while still accomplishing the user goal.",
    "Governance feedback:",
    governanceFeedback
  ].join("\n");
}
