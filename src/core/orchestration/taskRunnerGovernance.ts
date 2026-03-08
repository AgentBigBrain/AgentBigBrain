/**
 * @fileoverview Canonical task-runner governance evaluation and preflight orchestration.
 */

import { MasterGovernor } from "../../governors/masterGovernor";
import { type Governor, type GovernorContext } from "../../governors/types";
import { runCouncilVote } from "../../governors/voteGate";
import {
  type ActionRunResult,
  FULL_COUNCIL_GOVERNOR_IDS,
  type GovernanceProposal,
  type GovernorId,
  type GovernorVote,
  type MasterDecision
} from "../types";
import { type AppendRuntimeTraceEventInput } from "../runtimeTraceLogger";
import { buildBlockedActionResult } from "./taskRunnerSummary";
import { evaluateCodeReview } from "./taskRunnerProposal";

type TraceDetails = Record<string, string | number | boolean | null>;

interface TaskRunnerGovernanceRuntime {
  evaluateCodeReview?: typeof evaluateCodeReview;
  runCouncilVote?: typeof runCouncilVote;
  createFastPathMasterGovernor?: (governorCount: number) => MasterGovernor;
}

export interface EvaluateTaskRunnerGovernanceInput {
  action: ActionRunResult["action"];
  mode: ActionRunResult["mode"];
  proposal: GovernanceProposal;
  taskId: string;
  governorContext: GovernorContext;
  governors: readonly Governor[];
  masterGovernor: MasterGovernor;
  fastPathGovernorIds: readonly GovernorId[];
  perGovernorTimeoutMs: number;
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
  runtime?: TaskRunnerGovernanceRuntime;
}

export interface TaskRunnerGovernanceOutcome {
  combinedVotes: GovernorVote[];
  decision?: MasterDecision;
  blockedResult?: ActionRunResult;
  blockedTraceDetails?: TraceDetails;
}

/**
 * Evaluates code-review preflight plus council voting for one task-runner action.
 *
 * @param input - Governance evaluation inputs for one planned action.
 * @returns Governance outcome including either approved decision data or one canonical blocked result.
 */
export async function evaluateTaskRunnerGovernance(
  input: EvaluateTaskRunnerGovernanceInput
): Promise<TaskRunnerGovernanceOutcome> {
  const evaluateCodeReviewImpl = input.runtime?.evaluateCodeReview ?? evaluateCodeReview;
  const runCouncilVoteImpl = input.runtime?.runCouncilVote ?? runCouncilVote;
  const createFastPathMasterGovernor =
    input.runtime?.createFastPathMasterGovernor ??
    ((governorCount: number) => new MasterGovernor(governorCount));

  const preflightVotes: GovernorVote[] = [];
  if (input.action.type === "create_skill") {
    const preflightStartedAtMs = Date.now();
    const codeReviewVote = await evaluateCodeReviewImpl(
      input.proposal,
      input.governorContext,
      input.perGovernorTimeoutMs
    );
    preflightVotes.push(codeReviewVote);
    await input.appendTraceEvent({
      eventType: "governance_voted",
      taskId: input.taskId,
      actionId: input.action.id,
      proposalId: input.proposal.id,
      mode: input.mode,
      durationMs: Date.now() - preflightStartedAtMs,
      details: {
        phase: "code_review_preflight",
        approved: codeReviewVote.approve,
        voteCount: 1,
        yesVotes: codeReviewVote.approve ? 1 : 0,
        noVotes: codeReviewVote.approve ? 0 : 1
      }
    });
    if (!codeReviewVote.approve) {
      return {
        combinedVotes: [...preflightVotes],
        blockedResult: buildBlockedActionResult({
          action: input.action,
          mode: input.mode,
          blockedBy: [codeReviewVote.governorId],
          votes: preflightVotes
        })
      };
    }
  }

  let votes: GovernorVote[] = [];
  let decision: MasterDecision | undefined;
  const voteStartedAtMs = Date.now();
  if (input.mode === "fast_path") {
    const fastGovernors = input.governors.filter((governor) =>
      input.fastPathGovernorIds.includes(governor.id)
    );
    if (fastGovernors.length === 0) {
      return {
        combinedVotes: [...preflightVotes],
        blockedResult: buildBlockedActionResult({
          action: input.action,
          mode: input.mode,
          blockedBy: ["GOVERNOR_SET_EMPTY"],
          violations: [
            {
              code: "GOVERNOR_SET_EMPTY",
              message:
                "Fast-path governance denied because no active governors matched fastPathGovernorIds."
            }
          ]
        }),
        blockedTraceDetails: {
          blockCode: "GOVERNOR_SET_EMPTY",
          blockCategory: "governance"
        }
      };
    }
    const fastVoteResult = await runCouncilVoteImpl(
      input.proposal,
      fastGovernors,
      input.governorContext,
      createFastPathMasterGovernor(fastGovernors.length),
      input.perGovernorTimeoutMs,
      {
        expectedGovernorIds: [...input.fastPathGovernorIds]
      }
    );
    votes = fastVoteResult.votes;
    decision = fastVoteResult.decision;
  } else {
    const councilResult = await runCouncilVoteImpl(
      input.proposal,
      [...input.governors],
      input.governorContext,
      input.masterGovernor,
      input.perGovernorTimeoutMs,
      {
        expectedGovernorIds: FULL_COUNCIL_GOVERNOR_IDS
      }
    );
    votes = councilResult.votes;
    decision = councilResult.decision;
  }

  await input.appendTraceEvent({
    eventType: "governance_voted",
    taskId: input.taskId,
    actionId: input.action.id,
    proposalId: input.proposal.id,
    mode: input.mode,
    durationMs: Date.now() - voteStartedAtMs,
    details: {
      phase: input.mode === "fast_path" ? "fast_path_council" : "escalation_council",
      approved: decision ? decision.approved : true,
      voteCount: votes.length,
      yesVotes: decision ? decision.yesVotes : votes.filter((vote) => vote.approve).length,
      noVotes: decision ? decision.noVotes : votes.filter((vote) => !vote.approve).length,
      threshold: decision?.threshold ?? null
    }
  });

  const combinedVotes = preflightVotes.concat(votes);
  if (!decision) {
    return {
      combinedVotes,
      blockedResult: buildBlockedActionResult({
        action: input.action,
        mode: input.mode,
        blockedBy: ["GOVERNANCE_DECISION_MISSING"],
        violations: [
          {
            code: "GOVERNANCE_DECISION_MISSING",
            message: "Governance decision missing after council vote; execution denied fail-closed."
          }
        ],
        votes: combinedVotes
      }),
      blockedTraceDetails: {
        blockCode: "GOVERNANCE_DECISION_MISSING",
        blockCategory: "governance"
      }
    };
  }

  if (!decision.approved) {
    const blockedResult = buildBlockedActionResult({
      action: input.action,
      mode: input.mode,
      blockedBy: combinedVotes
        .filter((vote) => !vote.approve)
        .map((vote) => vote.governorId),
      votes: combinedVotes,
      decision
    });
    return {
      combinedVotes,
      decision,
      blockedResult,
      blockedTraceDetails: {
        blockCode: blockedResult.blockedBy.join(",") || "GOVERNOR_REJECTED",
        blockCategory: "governance"
      }
    };
  }

  return {
    combinedVotes,
    decision
  };
}
