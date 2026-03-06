/**
 * @fileoverview Provides deterministic support helpers for TaskRunner governance, execution, and receipt persistence flows.
 */

import { codeReviewGovernor } from "../governors/codeReviewGovernor";
import { GovernorContext } from "../governors/types";
import { ModelClient, ModelUsageSnapshot } from "../models/types";
import { ToolExecutorOrgan } from "../organs/executor";
import { selectModelForGovernor, selectModelForRole } from "./modelRouting";
import {
  ActionRunResult,
  BrainState,
  ConstraintViolation,
  ExecutorExecutionOutcome,
  GovernanceBlockCategory,
  GovernanceMemoryEvent,
  GovernanceMemoryReadView,
  GovernanceProposal,
  GovernorVote,
  ProfileMemoryStatus,
  TaskRunResult,
  VerificationCategoryV1
} from "./types";
import { GovernanceMemoryStore } from "./governanceMemory";
import { AppendRuntimeTraceEventInput } from "./runtimeTraceLogger";
import { extractImmutableTarget, hasExplicitImmutableTouch } from "./immutableTargetPolicy";
import { makeId } from "./ids";
import { containsAgentPulseRequestMarker, extractActiveRequestSegment } from "./currentRequestExtraction";
import { isVerificationClaimPrompt, resolveVerificationCategoryFromPrompt } from "./verificationPromptClassifier";
import { ExecutionReceiptStore } from "./advancedAutonomyRuntime";
import { BrainConfig } from "./config";

/**
 * Converts an unknown metadata field into a trimmed non-empty string when possible.
 *
 * @param value - Candidate metadata value from planner/action params.
 * @returns Trimmed string when present, otherwise `null`.
 */
export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves verification category from the active user request segment.
 *
 * @param userInput - Full task user input (potentially wrapped with context markers).
 * @returns Verification category used by quality-gate enforcement.
 */
export function resolveVerificationCategoryForPrompt(
  userInput: string
): VerificationCategoryV1 {
  const promptText = extractActiveRequestSegment(userInput);
  return resolveVerificationCategoryFromPrompt(promptText);
}

/**
 * Determines whether respond-action verification gating should be enforced for this prompt.
 *
 * @param userInput - Full task user input.
 * @returns `true` when this prompt is an explicit completion-claim request.
 */
export function shouldEnforceVerificationGateForRespond(userInput: string): boolean {
  if (containsAgentPulseRequestMarker(userInput)) {
    return false;
  }
  const currentRequest = extractActiveRequestSegment(userInput);
  return isVerificationClaimPrompt(currentRequest);
}

/**
 * Returns a deterministic zeroed model-usage snapshot.
 *
 * @returns Usage snapshot with all counters initialized to zero.
 */
export function emptyUsageSnapshot(): ModelUsageSnapshot {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };
}

/**
 * Computes non-negative usage deltas between two model-usage snapshots.
 *
 * @param start - Snapshot captured before execution.
 * @param end - Snapshot captured after execution.
 * @returns Delta snapshot used for cumulative spend guards.
 */
export function diffUsageSnapshot(
  start: ModelUsageSnapshot,
  end: ModelUsageSnapshot
): ModelUsageSnapshot {
  return {
    calls: Math.max(0, end.calls - start.calls),
    promptTokens: Math.max(0, end.promptTokens - start.promptTokens),
    completionTokens: Math.max(0, end.completionTokens - start.completionTokens),
    totalTokens: Math.max(0, end.totalTokens - start.totalTokens),
    estimatedSpendUsd: Number(Math.max(0, end.estimatedSpendUsd - start.estimatedSpendUsd).toFixed(8))
  };
}

/**
 * Maps an action result to one deterministic governance-block category.
 *
 * @param result - Action result to classify.
 * @returns Block category for governance memory/audit surfaces.
 */
export function resolveBlockCategory(result: ActionRunResult): GovernanceBlockCategory {
  if (result.approved) {
    return "none";
  }

  if (result.executionStatus && result.executionStatus !== "success") {
    return "runtime";
  }

  if (
    result.blockedBy.includes("ACTION_EXECUTION_FAILED") ||
    result.violations.some((violation) => violation.code === "ACTION_EXECUTION_FAILED")
  ) {
    return "runtime";
  }

  if (result.violations.length > 0) {
    return "constraints";
  }

  if (result.votes.length > 0) {
    return "governance";
  }

  return "runtime";
}

/**
 * Converts a typed executor outcome into a fail-closed runtime violation when execution did not succeed.
 *
 * @param action - Planned action that was executed.
 * @param outcome - Typed executor outcome emitted by ToolExecutorOrgan.
 * @returns Typed execution/block violation, or `null` when outcome status is `success`.
 */
export function resolveExecutionOutcomeViolation(
  action: TaskRunResult["plan"]["actions"][number],
  outcome: ExecutorExecutionOutcome
): ConstraintViolation | null {
  if (outcome.status === "success") {
    return null;
  }

  const fallbackMessage =
    outcome.status === "blocked"
      ? `Approved ${action.type} action was blocked during execution.`
      : `Approved ${action.type} action failed during execution.`;
  return {
    code: outcome.failureCode ?? "ACTION_EXECUTION_FAILED",
    message: outcome.output.trim() || fallbackMessage
  };
}

/**
 * Summarizes council votes into stable yes/no counts and dissenting governor ids.
 *
 * @param votes - Governor votes collected for one action proposal.
 * @returns Vote summary tuple used by governance event persistence.
 */
export function summarizeVotes(votes: GovernorVote[]): {
  yesVotes: number;
  noVotes: number;
  dissentGovernorIds: GovernorVote["governorId"][];
} {
  const yesVotes = votes.filter((vote) => vote.approve).length;
  const dissentVotes = votes.filter((vote) => !vote.approve);
  return {
    yesVotes,
    noVotes: dissentVotes.length,
    dissentGovernorIds: dissentVotes.map((vote) => vote.governorId)
  };
}

/**
 * Reads current model-usage counters from the model client when supported.
 *
 * @param modelClient - Runtime model client used by TaskRunner.
 * @returns Snapshot from provider client or zeroed fallback snapshot.
 */
export function readModelUsageSnapshot(modelClient: ModelClient): ModelUsageSnapshot {
  if (typeof modelClient.getUsageSnapshot === "function") {
    return modelClient.getUsageSnapshot();
  }
  return emptyUsageSnapshot();
}

/**
 * Runs executor preflight output preparation and converts failures into non-fatal null output.
 *
 * @param executor - Runtime executor used by TaskRunner.
 * @param action - Planned action being prepared.
 * @returns Prepared output string, or `null` when preflight preparation fails.
 */
export async function prepareActionOutput(
  executor: ToolExecutorOrgan,
  action: TaskRunResult["plan"]["actions"][number]
): Promise<string | null> {
  try {
    return await executor.prepare(action);
  } catch (error) {
    console.error(
      `[Executor] non-fatal action preparation failure for action ${action.id}: ${(error as Error).message}`
    );
    return null;
  }
}

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
 * Evaluates the code-review governor with timeout/failure fail-closed semantics.
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

export interface AppendGovernanceEventInput {
  taskId: string;
  proposalId: string | null;
  actionResult: ActionRunResult;
  governanceMemoryStore: GovernanceMemoryStore;
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
}

/**
 * Persists one governance memory event and emits aligned trace telemetry.
 *
 * @param input - Governance event persistence dependencies and action result.
 * @returns Persisted governance memory event.
 */
export async function appendGovernanceEvent(
  input: AppendGovernanceEventInput
): Promise<GovernanceMemoryEvent> {
  const {
    taskId,
    proposalId,
    actionResult,
    governanceMemoryStore,
    appendTraceEvent
  } = input;
  const voteSummary = summarizeVotes(actionResult.votes);
  const decisionThreshold = actionResult.decision?.threshold ?? null;
  const event = await governanceMemoryStore.appendEvent({
    taskId,
    proposalId,
    actionId: actionResult.action.id,
    actionType: actionResult.action.type,
    mode: actionResult.mode,
    outcome: actionResult.approved ? "approved" : "blocked",
    blockCategory: resolveBlockCategory(actionResult),
    blockedBy: actionResult.blockedBy,
    violationCodes: actionResult.violations.map((violation) => violation.code),
    yesVotes: actionResult.decision?.yesVotes ?? voteSummary.yesVotes,
    noVotes: actionResult.decision?.noVotes ?? voteSummary.noVotes,
    threshold: decisionThreshold,
    dissentGovernorIds: actionResult.decision
      ? actionResult.decision.dissent.map((vote) => vote.governorId)
      : voteSummary.dissentGovernorIds
  });
  await appendTraceEvent({
    eventType: "governance_event_persisted",
    taskId,
    actionId: actionResult.action.id,
    proposalId: proposalId ?? undefined,
    governanceEventId: event.id,
    mode: actionResult.mode,
    details: {
      outcome: event.outcome,
      blockCategory: event.blockCategory,
      yesVotes: event.yesVotes,
      noVotes: event.noVotes
    }
  });
  return event;
}

export interface AppendExecutionReceiptInput {
  taskId: string;
  planTaskId: string;
  proposalId: string | null;
  actionResult: ActionRunResult;
  executionReceiptStore: ExecutionReceiptStore;
}

/**
 * Persists one approved-action execution receipt with non-fatal error handling.
 *
 * @param input - Execution receipt dependencies and approved/blocked action result.
 * @returns Promise resolving when receipt append completes (or is safely skipped).
 */
export async function appendExecutionReceipt(input: AppendExecutionReceiptInput): Promise<void> {
  const {
    taskId,
    planTaskId,
    proposalId,
    actionResult,
    executionReceiptStore
  } = input;
  if (!actionResult.approved) {
    return;
  }

  try {
    await executionReceiptStore.appendApprovedActionReceipt({
      taskId,
      planTaskId,
      proposalId,
      actionResult
    });
  } catch (error) {
    console.error(
      `[ExecutionReceipt] non-fatal receipt write failure for action ${actionResult.action.id}: ${(error as Error).message}`
    );
  }
}
