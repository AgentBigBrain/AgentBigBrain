/**
 * @fileoverview Executes council voting with per-governor timeout handling.
 */

import { MasterGovernor } from "./masterGovernor";
import { Governor, GovernorContext } from "./types";
import {
  GovernanceProposal,
  GovernorRejectCategory,
  GovernorVote,
  GovernorId,
  isGovernorId
} from "../core/types";
import { selectModelForGovernor } from "../core/modelRouting";

/**
 * Resolves a promise with a deterministic timeout fallback.
 *
 * **Why it exists:**
 * Governor evaluation can stall or fail; this helper guarantees every vote path returns a value
 * within the configured deadline.
 *
 * **What it talks to:**
 * - Local `Promise`/`setTimeout` mechanics only.
 *
 * @param promise - Governor vote promise to await.
 * @param timeoutMs - Max wait time before fail-closed fallback is used.
 * @param fallback - Fallback value factory used on timeout or rejection.
 * @returns Promise resolving to either the vote value or fallback value.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      resolve(fallback());
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutHandle);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timeoutHandle);
        resolve(fallback());
      });
  });
}

/**
 * Evaluates governor reject category and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the governor reject category policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `GovernorRejectCategory` (import `GovernorRejectCategory`) from `../core/types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is GovernorRejectCategory` result.
 */
function isGovernorRejectCategory(value: unknown): value is GovernorRejectCategory {
  return (
    value === "ABUSE_MALWARE_OR_FRAUD" ||
    value === "SECURITY_BOUNDARY" ||
    value === "IDENTITY_INTEGRITY" ||
    value === "COMPLIANCE_POLICY" ||
    value === "RESOURCE_BUDGET" ||
    value === "RATIONALE_QUALITY" ||
    value === "UTILITY_ALIGNMENT" ||
    value === "MODEL_ADVISORY_BLOCK" ||
    value === "GOVERNOR_TIMEOUT_OR_FAILURE" ||
    value === "GOVERNOR_MALFORMED_VOTE" ||
    value === "GOVERNOR_MISSING" ||
    value === "OTHER_POLICY"
  );
}

/**
 * Evaluates governor vote shape and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the governor vote shape policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 * - Uses `isGovernorId` (import `isGovernorId`) from `../core/types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is GovernorVote` result.
 */
function isGovernorVoteShape(value: unknown): value is GovernorVote {
  if (!value || typeof value !== "object") {
    return false;
  }

  const vote = value as GovernorVote;
  return (
    isGovernorId(vote.governorId) &&
    typeof vote.approve === "boolean" &&
    typeof vote.reason === "string" &&
    typeof vote.confidence === "number" &&
    Number.isFinite(vote.confidence) &&
    (vote.rejectCategory === undefined || isGovernorRejectCategory(vote.rejectCategory))
  );
}

/**
 * Implements fallback vote behavior used by `voteGate`.
 *
 * **Why it exists:**
 * Keeps `fallback vote` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `GovernorId` (import `GovernorId`) from `../core/types`.
 * - Uses `GovernorRejectCategory` (import `GovernorRejectCategory`) from `../core/types`.
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param reason - Value for reason.
 * @param rejectCategory - Value for reject category.
 * @returns Computed `GovernorVote` result.
 */
function fallbackVote(
  governorId: GovernorId,
  reason: string,
  rejectCategory: GovernorRejectCategory
): GovernorVote {
  return {
    governorId,
    approve: false,
    reason,
    confidence: 1,
    rejectCategory
  };
}

/**
 * Normalizes governor vote into a stable shape for `voteGate` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for governor vote so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `GovernorId` (import `GovernorId`) from `../core/types`.
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 *
 * @param rawVote - Value for raw vote.
 * @param expectedGovernorId - Stable identifier used to reference an entity or record.
 * @returns Computed `GovernorVote` result.
 */
function normalizeGovernorVote(
  rawVote: unknown,
  expectedGovernorId: GovernorId
): GovernorVote {
  if (!isGovernorVoteShape(rawVote)) {
    return fallbackVote(
      expectedGovernorId,
      "Governor returned malformed vote payload.",
      "GOVERNOR_MALFORMED_VOTE"
    );
  }

  if (rawVote.governorId !== expectedGovernorId) {
    return fallbackVote(
      expectedGovernorId,
      "Governor returned mismatched governorId.",
      "GOVERNOR_MALFORMED_VOTE"
    );
  }

  return rawVote;
}

/**
 * Executes council vote as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the council vote runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `selectModelForGovernor` (import `selectModelForGovernor`) from `../core/modelRouting`.
 * - Uses `GovernanceProposal` (import `GovernanceProposal`) from `../core/types`.
 * - Uses `GovernorId` (import `GovernorId`) from `../core/types`.
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 * - Uses `MasterGovernor` (import `MasterGovernor`) from `./masterGovernor`.
 * - Uses `Governor` (import `Governor`) from `./types`.
 * - Additional imported collaborators are also used in this function body.
 *
 * @param proposal - Value for proposal.
 * @param governors - Value for governors.
 * @param context - Message/text content processed by this function.
 * @param masterGovernor - Value for master governor.
 * @param perGovernorTimeoutMs - Timestamp used for ordering, timeout, or recency decisions.
 * @param options - Optional tuning knobs for this operation.
 * @returns Ordered collection produced by this step.
 */
export async function runCouncilVote(
  proposal: GovernanceProposal,
  governors: Governor[],
  context: GovernorContext,
  masterGovernor: MasterGovernor,
  perGovernorTimeoutMs: number,
  options?: {
    expectedGovernorIds?: GovernorId[];
  }
): Promise<{
  votes: GovernorVote[];
  decision: ReturnType<MasterGovernor["review"]>;
}> {
  const votes = await Promise.all(
    governors.map((governor) =>
      // Per-governor model routing allows specialized policy models by risk lens.
      {
        const governorContext: GovernorContext = {
          ...context,
          model: selectModelForGovernor(governor.id, context.config)
        };
        return withTimeout(
          governor.evaluate(proposal, governorContext) as Promise<unknown>,
          perGovernorTimeoutMs,
          () =>
            fallbackVote(
              governor.id,
              "Governor timeout or failure.",
              "GOVERNOR_TIMEOUT_OR_FAILURE"
            )
        )
          .then((rawVote) => normalizeGovernorVote(rawVote, governor.id));
      }
    )
  );

  const expectedGovernorIds = options?.expectedGovernorIds ?? governors.map((governor) => governor.id);
  const expectedIdSet = new Set(expectedGovernorIds);
  const providedIdSet = new Set(governors.map((governor) => governor.id));
  const missingGovernorIds = [...expectedIdSet].filter((id) => !providedIdSet.has(id));

  for (const missingId of missingGovernorIds) {
    votes.push(
      fallbackVote(
        missingId,
        "Governor missing from council set.",
        "GOVERNOR_MISSING"
      )
    );
  }

  const decision = masterGovernor.review(votes);
  if (missingGovernorIds.length > 0) {
    decision.approved = false;
  }
  return { votes, decision };
}

