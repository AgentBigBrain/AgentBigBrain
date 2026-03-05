/**
 * @fileoverview Aggregates council votes into a final approve/reject decision.
 */

import { MasterDecision, GovernorVote } from "../core/types";

export class MasterGovernor {
/**
 * Initializes `MasterGovernor` with deterministic runtime dependencies.
 *
 * **Why it exists:**
 * Captures required dependencies at initialization time so runtime behavior remains explicit.
 *
 * **What it talks to:**
 * - Stores the council approval threshold used by `review`.
 *
 * @param threshold - Minimum number of approving votes required for final approval.
 */
constructor(private readonly threshold: number) {}

/**
 * Implements review behavior used by `masterGovernor`.
 *
 * **Why it exists:**
 * Keeps `review` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 * - Uses `MasterDecision` (import `MasterDecision`) from `../core/types`.
 *
 * @param votes - Value for votes.
 * @returns Computed `MasterDecision` result.
 */
review(votes: GovernorVote[]): MasterDecision {
    const yesVotes = votes.filter((vote) => vote.approve).length;
    const noVotes = votes.length - yesVotes;
    const dissent = votes.filter((vote) => !vote.approve);

    return {
      approved: yesVotes >= this.threshold,
      yesVotes,
      noVotes,
      threshold: this.threshold,
      dissent
    };
  }
}

