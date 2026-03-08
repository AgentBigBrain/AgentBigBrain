/**
 * @fileoverview Canonical governance-event and execution-receipt persistence helpers for task-runner outcomes.
 */

import { type ExecutionReceiptStore } from "../advancedAutonomyRuntime";
import { type GovernanceMemoryStore } from "../governanceMemory";
import { type AppendRuntimeTraceEventInput } from "../runtimeTraceLogger";
import {
  type ActionRunResult,
  type GovernanceBlockCategory,
  type GovernanceMemoryEvent
} from "../types";

export interface AppendGovernanceEventInput {
  taskId: string;
  proposalId: string | null;
  actionResult: ActionRunResult;
  governanceMemoryStore: GovernanceMemoryStore;
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
}

export interface AppendExecutionReceiptInput {
  taskId: string;
  planTaskId: string;
  proposalId: string | null;
  actionResult: ActionRunResult;
  executionReceiptStore: ExecutionReceiptStore;
}

/**
 * Maps an action result to one deterministic governance-block category.
 *
 * @param result - Action result to classify.
 * @returns Block category for governance memory and audit surfaces.
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
 * Summarizes council votes into stable yes/no counts and dissenting governor ids.
 *
 * @param votes - Governor votes collected for one action proposal.
 * @returns Vote summary tuple used by governance event persistence.
 */
export function summarizeVotes(votes: ActionRunResult["votes"]): {
  yesVotes: number;
  noVotes: number;
  dissentGovernorIds: ActionRunResult["votes"][number]["governorId"][];
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

/**
 * Persists one approved-action execution receipt with non-fatal error handling.
 *
 * @param input - Execution receipt dependencies and approved or blocked action result.
 * @returns Promise resolving when receipt append completes, or is safely skipped.
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
