/**
 * @fileoverview Canonical task-runner proposal and governor-context helpers.
 */

import { codeReviewGovernor } from "../../governors/codeReviewGovernor";
import { type GovernorContext } from "../../governors/types";
import { type ModelClient } from "../../models/types";
import { type BrainConfig } from "../config";
import { makeId } from "../ids";
import { extractImmutableTarget, hasExplicitImmutableTouch } from "../immutableTargetPolicy";
import { selectModelForGovernor, selectModelForRole } from "../modelRouting";
import {
  type BrainState,
  type GovernanceMemoryReadView,
  type GovernanceProposal,
  type GovernorVote,
  type ProfileMemoryStatus,
  type TaskRunResult
} from "../types";

export interface BuildGovernorContextInput {
  task: TaskRunResult["task"];
  state: BrainState;
  governanceMemory: GovernanceMemoryReadView;
  profileMemoryStatus: ProfileMemoryStatus;
  config: BrainConfig;
  modelClient: ModelClient;
}

/**
 * Builds the governor evaluation context passed to council voters.
 *
 * @param input - Task/state/memory context and runtime collaborators.
 * @returns Deterministic governor context object.
 */
export function buildGovernorContext(input: BuildGovernorContextInput): GovernorContext {
  const {
    task,
    state,
    governanceMemory,
    profileMemoryStatus,
    config,
    modelClient
  } = input;
  return {
    task,
    state,
    governanceMemory,
    profileMemoryStatus,
    config,
    model: selectModelForRole("governor", config),
    modelClient
  };
}

/**
 * Builds one governance proposal from a planner action with immutable-touch detection.
 *
 * @param task - Task metadata owning this action.
 * @param action - Planned action to wrap in a proposal.
 * @param config - Runtime brain config containing immutable keyword policy.
 * @returns Governance proposal used in council voting.
 */
export function buildProposal(
  task: TaskRunResult["task"],
  action: TaskRunResult["plan"]["actions"][number],
  config: BrainConfig
): GovernanceProposal {
  const target = extractImmutableTarget(action);
  const touchesImmutableFromTarget = config.dna.immutableKeywords.some((keyword) =>
    target.toLowerCase().includes(keyword.toLowerCase())
  );
  const touchesImmutable = hasExplicitImmutableTouch(action) || touchesImmutableFromTarget;

  return {
    id: makeId("proposal"),
    taskId: task.id,
    requestedBy: "planner",
    rationale: `Task goal: ${task.goal}. Execute action: ${action.description}`,
    action,
    touchesImmutable
  };
}

/**
 * Evaluates the code-review governor with timeout or failure fail-closed semantics.
 *
 * @param proposal - Governance proposal for create-skill preflight.
 * @param context - Shared governor context.
 * @param timeoutMs - Timeout bound for code-review evaluation.
 * @returns Deterministic code-review governor vote.
 */
export async function evaluateCodeReview(
  proposal: GovernanceProposal,
  context: GovernorContext,
  timeoutMs: number
): Promise<GovernorVote> {
  return new Promise<GovernorVote>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      resolve({
        governorId: "codeReview",
        approve: false,
        reason: "Code review governor timeout.",
        confidence: 1
      });
    }, timeoutMs);

    codeReviewGovernor
      .evaluate(proposal, {
        ...context,
        model: selectModelForGovernor("codeReview", context.config)
      })
      .then((vote) => {
        clearTimeout(timeoutHandle);
        resolve(vote);
      })
      .catch(() => {
        clearTimeout(timeoutHandle);
        resolve({
          governorId: "codeReview",
          approve: false,
          reason: "Code review governor failure.",
          confidence: 1
        });
      });
  });
}
