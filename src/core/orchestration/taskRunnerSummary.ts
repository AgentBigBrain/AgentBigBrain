/**
 * @fileoverview Canonical task-runner result builders for blocked and approved action outcomes.
 */

import {
  type ActionRunResult,
  type ConstraintViolation,
  type MasterDecision
} from "../types";

export interface BuildBlockedActionResultInput {
  action: ActionRunResult["action"];
  mode: ActionRunResult["mode"];
  blockedBy: ActionRunResult["blockedBy"];
  violations?: ConstraintViolation[];
  votes?: ActionRunResult["votes"];
  decision?: MasterDecision;
  output?: string;
  executionStatus?: ActionRunResult["executionStatus"];
  executionFailureCode?: ActionRunResult["executionFailureCode"];
  executionMetadata?: ActionRunResult["executionMetadata"];
}

export interface BuildApprovedActionResultInput {
  action: ActionRunResult["action"];
  mode: ActionRunResult["mode"];
  output: string;
  executionStatus?: ActionRunResult["executionStatus"];
  executionMetadata?: ActionRunResult["executionMetadata"];
  votes?: ActionRunResult["votes"];
  decision?: MasterDecision;
}

/**
 * Builds a blocked task-runner action result with stable defaults.
 *
 * @param input - Canonical blocked action result inputs.
 * @returns Blocked action result used by task-runner lifecycle helpers.
 */
export function buildBlockedActionResult(
  input: BuildBlockedActionResultInput
): ActionRunResult {
  return {
    action: input.action,
    mode: input.mode,
    approved: false,
    output: input.output,
    executionStatus: input.executionStatus,
    executionFailureCode: input.executionFailureCode,
    executionMetadata: input.executionMetadata,
    blockedBy: [...input.blockedBy],
    violations: [...(input.violations ?? [])],
    votes: [...(input.votes ?? [])],
    decision: input.decision
  };
}

/**
 * Builds an approved task-runner action result with stable defaults.
 *
 * @param input - Canonical approved action result inputs.
 * @returns Approved action result used by task-runner lifecycle helpers.
 */
export function buildApprovedActionResult(
  input: BuildApprovedActionResultInput
): ActionRunResult {
  return {
    action: input.action,
    mode: input.mode,
    approved: true,
    output: input.output,
    executionStatus: input.executionStatus,
    executionMetadata: input.executionMetadata,
    blockedBy: [],
    violations: [],
    votes: [...(input.votes ?? [])],
    decision: input.decision
  };
}
