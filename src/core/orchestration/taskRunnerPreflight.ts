/**
 * @fileoverview Canonical task-runner preflight checks before governance voting.
 */

import { type BrainConfig } from "../config";
import { evaluateExplicitExecutionConstraintViolation } from "../explicitExecutionConstraints";
import { evaluateHardConstraints } from "../hardConstraints";
import { evaluateStage685RuntimeGuard } from "../stage6_85RuntimeGuards";
import type { ModelBillingMode } from "../../models/types";
import {
  type ActionRunResult,
  type ApprovalGrantV1,
  type GovernanceProposal,
  type TaskRunResult
} from "../types";
import { buildProposal } from "./taskRunnerProposal";
import { buildBlockedActionResult } from "./taskRunnerSummary";
import {
  evaluateTaskRunnerNetworkWritePreflight,
  type TaskRunnerConnectorReceiptSeed
} from "./taskRunnerNetworkPreflight";

type Metadata = Record<string, string | number | boolean | null>;

export interface EvaluateTaskRunnerPreflightInput {
  action: ActionRunResult["action"];
  approvalGrantById: ReadonlyMap<string, ApprovalGrantV1>;
  config: BrainConfig;
  cumulativeEstimatedCostUsd: number;
  estimatedModelSpendUsd: number;
  cumulativeModelCalls: number;
  modelBillingMode: ModelBillingMode;
  idempotencyKey: string;
  mode: ActionRunResult["mode"];
  nowIso: string;
  startedAtMs: number;
  task: TaskRunResult["task"];
}

export interface TaskRunnerPreflightBlockedOutcome {
  actionResult: ActionRunResult;
  traceDetails?: Metadata;
}

export interface EvaluateTaskRunnerPreflightResult {
  approvalGrant?: {
    approvalId: string;
    grant: ApprovalGrantV1;
  };
  blockedOutcome?: TaskRunnerPreflightBlockedOutcome;
  connectorReceiptInput?: TaskRunnerConnectorReceiptSeed | null;
  proposal?: GovernanceProposal;
}

/**
 * Applies deterministic task-runner preflight checks before governance voting begins.
 *
 * @param input - Task-runner action context plus approval and spend state.
 * @returns Blocked preflight outcome or the canonical proposal plus runtime receipts.
 */
export function evaluateTaskRunnerPreflight(
  input: EvaluateTaskRunnerPreflightInput
): EvaluateTaskRunnerPreflightResult {
  const runtimeLimitBlock = evaluateRuntimeLimitBlock(input);
  if (runtimeLimitBlock) {
    return { blockedOutcome: runtimeLimitBlock };
  }

  const explicitExecutionConstraintViolation = evaluateExplicitExecutionConstraintViolation(
    input.action,
    input.task.userInput
  );
  if (explicitExecutionConstraintViolation) {
    return {
      blockedOutcome: {
        actionResult: buildBlockedActionResult({
          action: input.action,
          mode: input.mode,
          blockedBy: [explicitExecutionConstraintViolation.code],
          violations: [explicitExecutionConstraintViolation]
        }),
        traceDetails: {
          blockCode: explicitExecutionConstraintViolation.code,
          blockCategory: "constraints"
        }
      }
    };
  }

  const proposal = buildProposal(input.task, input.action, input.config);
  const hardConstraintViolations = evaluateHardConstraints(proposal, input.config, {
    cumulativeEstimatedCostUsd: input.cumulativeEstimatedCostUsd
  });
  if (hardConstraintViolations.length > 0) {
    return {
      proposal,
      blockedOutcome: {
        actionResult: buildBlockedActionResult({
          action: input.action,
          mode: input.mode,
          blockedBy: hardConstraintViolations.map((violation) => violation.code),
          violations: hardConstraintViolations
        }),
        traceDetails: {
          blockCode: hardConstraintViolations[0]?.code ?? "CONSTRAINT_VIOLATION",
          blockCategory: "constraints",
          violationCount: hardConstraintViolations.length
        }
      }
    };
  }

  const stage685Guard = evaluateStage685RuntimeGuard(input.action);
  if (stage685Guard) {
    return {
      proposal,
      blockedOutcome: {
        actionResult: buildBlockedActionResult({
          action: input.action,
          mode: input.mode,
          blockedBy: [stage685Guard.violation.code],
          violations: [stage685Guard.violation]
        }),
        traceDetails: {
          blockCode: stage685Guard.violation.code,
          blockCategory: "constraints",
          conflictCode: stage685Guard.conflictCode
        }
      }
    };
  }

  if (input.action.type === "network_write") {
    return evaluateTaskRunnerNetworkWritePreflight({
      action: input.action,
      approvalGrantById: input.approvalGrantById,
      idempotencyKey: input.idempotencyKey,
      mode: input.mode,
      nowIso: input.nowIso,
      proposal,
      task: input.task
    });
  }

  return {
    proposal
  };
}

/**
 * Evaluates per-turn runtime deadline and model-spend limits before proposal creation.
 *
 * @param input - Preflight inputs containing current spend and deadline state.
 * @returns Blocked runtime outcome when a limit is exceeded, otherwise `null`.
 */
function evaluateRuntimeLimitBlock(
  input: EvaluateTaskRunnerPreflightInput
): TaskRunnerPreflightBlockedOutcome | null {
  if (Date.now() - input.startedAtMs > input.config.limits.perTurnDeadlineMs) {
    return {
      actionResult: buildBlockedActionResult({
        action: input.action,
        mode: input.mode,
        blockedBy: ["GLOBAL_DEADLINE_EXCEEDED"],
        violations: [
          {
            code: "GLOBAL_DEADLINE_EXCEEDED",
            message: `Turn exceeded ${input.config.limits.perTurnDeadlineMs}ms deadline.`
          }
        ]
      }),
      traceDetails: {
        blockCode: "GLOBAL_DEADLINE_EXCEEDED",
        blockCategory: "runtime"
      }
    };
  }

  if (
    input.modelBillingMode === "api_usd" &&
    input.estimatedModelSpendUsd > input.config.limits.maxCumulativeModelSpendUsd
  ) {
    return {
      actionResult: buildBlockedActionResult({
        action: input.action,
        mode: input.mode,
        blockedBy: ["MODEL_SPEND_LIMIT_EXCEEDED"],
        violations: [
          {
            code: "MODEL_SPEND_LIMIT_EXCEEDED",
            message:
              `Model spend ${input.estimatedModelSpendUsd.toFixed(6)} exceeds ` +
              `max ${input.config.limits.maxCumulativeModelSpendUsd.toFixed(2)}.`
          }
        ]
      }),
      traceDetails: {
        blockCode: "MODEL_SPEND_LIMIT_EXCEEDED",
        blockCategory: "runtime"
      }
    };
  }

  if (
    input.modelBillingMode !== "api_usd" &&
    input.cumulativeModelCalls > input.config.limits.maxCumulativeNonApiModelCalls
  ) {
    return {
      actionResult: buildBlockedActionResult({
        action: input.action,
        mode: input.mode,
        blockedBy: ["MODEL_CALL_LIMIT_EXCEEDED"],
        violations: [
          {
            code: "MODEL_CALL_LIMIT_EXCEEDED",
            message:
              `Model calls ${input.cumulativeModelCalls} exceed max ` +
              `${input.config.limits.maxCumulativeNonApiModelCalls}.`
          }
        ]
      }),
      traceDetails: {
        blockCode: "MODEL_CALL_LIMIT_EXCEEDED",
        blockCategory: "runtime"
      }
    };
  }

  return null;
}
