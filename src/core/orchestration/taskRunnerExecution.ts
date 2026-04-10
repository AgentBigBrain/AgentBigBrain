/**
 * @fileoverview Canonical task-runner execution flow for approved actions.
 */

import { estimateActionCostUsd } from "../actionCostPolicy";
import { type AppendRuntimeTraceEventInput } from "../runtimeTraceLogger";
import { throwIfAborted } from "../runtimeAbort";
import { type Stage686RuntimeActionEngine } from "../stage6_86/runtimeActions";
import { createConnectorReceiptV1 } from "../stage6_75ConnectorPolicy";
import {
  type ActionRunResult,
  type ConstraintViolation,
  type ExecutorExecutionOutcome,
  type MasterDecision
} from "../types";
import { type ToolExecutorOrgan } from "../../organs/executor";
import { type TaskRunnerConnectorReceiptSeed } from "./taskRunnerNetworkPreflight";
import {
  buildApprovedActionResult,
  buildBlockedActionResult
} from "./taskRunnerSummary";

type Metadata = Record<string, string | number | boolean | null>;
type TaskRunnerExecutor = Pick<ToolExecutorOrgan, "prepare" | "executeWithOutcome" | "consumeShellExecutionTelemetry">;
type Stage686Runtime = Pick<Stage686RuntimeActionEngine, "execute">;
type ShellExecutionTelemetry = ReturnType<ToolExecutorOrgan["consumeShellExecutionTelemetry"]>;

export interface ExecuteTaskRunnerActionInput {
  action: ActionRunResult["action"];
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
  combinedVotes: ActionRunResult["votes"];
  connectorReceiptInput?: TaskRunnerConnectorReceiptSeed | null;
  decision: MasterDecision;
  deterministicActionId: string;
  executor: TaskRunnerExecutor;
  missionAttemptId: number;
  missionPhase: string;
  mode: ActionRunResult["mode"];
  proposalId: string;
  signal?: AbortSignal;
  stage686RuntimeActionEngine: Stage686Runtime;
  taskId: string;
  userInput: string;
}

export interface ExecuteTaskRunnerActionResult {
  actionResult: ActionRunResult;
  approvedEstimatedCostDeltaUsd: number;
  blockedTraceDetails?: Metadata;
  outputLength: number;
}

/**
 * Executes one approved task-runner action and normalizes the blocked/success result contract.
 *
 * @param input - Approved-action execution inputs and runtime collaborators.
 * @returns Canonical blocked or approved action result plus trace metadata and cost delta.
 */
export async function executeTaskRunnerAction(
  input: ExecuteTaskRunnerActionInput
): Promise<ExecuteTaskRunnerActionResult> {
  throwIfAborted(input.signal);
  const executionStartedAtMs = Date.now();
  const stage686Execution = await input.stage686RuntimeActionEngine.execute({
    taskId: input.taskId,
    proposalId: input.proposalId,
    missionId: input.taskId,
    missionAttemptId: input.missionAttemptId,
    userInput: input.userInput,
    action: input.action
  });

  let preparedOutput: string | null = null;
  let usedPreparedOutput = false;
  let output: string;
  let shellExecutionTelemetry: ShellExecutionTelemetry | undefined;
  let executionOutcome: ExecutorExecutionOutcome;
  let stage686ExecutionMetadata: Metadata | undefined;
  let stage686TraceDetails: Metadata | undefined;

  if (stage686Execution) {
    output = stage686Execution.output;
    stage686ExecutionMetadata = stage686Execution.executionMetadata;
    stage686TraceDetails = stage686Execution.traceDetails;
    executionOutcome = stage686Execution.approved
      ? {
        status: "success",
        output: stage686Execution.output,
        executionMetadata: stage686ExecutionMetadata
      }
      : {
        status: "blocked",
        output: stage686Execution.output,
        failureCode: stage686Execution.violationCode ?? "ACTION_EXECUTION_FAILED",
        executionMetadata: stage686ExecutionMetadata
      };
  } else {
    throwIfAborted(input.signal);
    preparedOutput = await prepareActionOutput(input.executor, input.action);
    usedPreparedOutput = preparedOutput !== null;
    if (preparedOutput !== null) {
      executionOutcome = {
        status: "success",
        output: preparedOutput
      };
    } else {
      executionOutcome = await input.executor.executeWithOutcome(
        input.action,
        input.signal,
        input.taskId
      );
      shellExecutionTelemetry = input.executor.consumeShellExecutionTelemetry(input.action.id) ?? undefined;
    }
    output = executionOutcome.output;
  }

  const executionFailureViolation = resolveExecutionOutcomeViolation(input.action, executionOutcome);
  if (executionFailureViolation) {
    const failureMetadata = {
      ...(executionOutcome.executionMetadata ?? {}),
      ...(shellExecutionTelemetry
        ? { ...shellExecutionTelemetry } as Metadata
        : {}),
      ...(stage686ExecutionMetadata ?? {})
    };
    const executionMetadata = Object.keys(failureMetadata).length > 0
      ? failureMetadata
      : undefined;
    return {
      actionResult: buildBlockedActionResult({
        action: input.action,
        mode: input.mode,
        output,
        executionStatus: executionOutcome.status,
        executionFailureCode: executionFailureViolation.code,
        executionMetadata,
        blockedBy: [executionFailureViolation.code],
        violations: [executionFailureViolation],
        votes: input.combinedVotes,
        decision: input.decision
      }),
      approvedEstimatedCostDeltaUsd: 0,
      blockedTraceDetails: {
        blockCode: executionFailureViolation.code,
        blockCategory: "runtime",
        ...(stage686TraceDetails ?? {})
      },
      outputLength: output.length
    };
  }

  const connectorReceipt = input.connectorReceiptInput
    ? createConnectorReceiptV1({
      connector: input.connectorReceiptInput.connector,
      operation: input.connectorReceiptInput.operation,
      requestPayload: input.connectorReceiptInput.requestPayload,
      responseMetadata: input.connectorReceiptInput.responseMetadata,
      externalIds: input.connectorReceiptInput.externalIds,
      observedAt: new Date().toISOString()
    })
    : null;

  await input.appendTraceEvent({
    eventType: "action_executed",
    taskId: input.taskId,
    actionId: input.action.id,
    proposalId: input.proposalId,
    mode: input.mode,
    durationMs: Date.now() - executionStartedAtMs,
    details: {
      usedPreparedOutput,
      outputLength: output.length,
      shellProfileFingerprint: shellExecutionTelemetry?.shellProfileFingerprint ?? null,
      shellSpawnSpecFingerprint: shellExecutionTelemetry?.shellSpawnSpecFingerprint ?? null,
      shellKind: shellExecutionTelemetry?.shellKind ?? null,
      shellExecutable: shellExecutionTelemetry?.shellExecutable ?? null,
      shellTimeoutMs: shellExecutionTelemetry?.shellTimeoutMs ?? null,
      shellEnvMode: shellExecutionTelemetry?.shellEnvMode ?? null,
      shellEnvKeyCount: shellExecutionTelemetry?.shellEnvKeyCount ?? null,
      shellEnvRedactedKeyCount: shellExecutionTelemetry?.shellEnvRedactedKeyCount ?? null,
      shellExitCode: shellExecutionTelemetry?.shellExitCode ?? null,
      shellSignal: shellExecutionTelemetry?.shellSignal ?? null,
      shellTimedOut: shellExecutionTelemetry?.shellTimedOut ?? null,
      shellStdoutDigest: shellExecutionTelemetry?.shellStdoutDigest ?? null,
      shellStderrDigest: shellExecutionTelemetry?.shellStderrDigest ?? null,
      shellStdoutBytes: shellExecutionTelemetry?.shellStdoutBytes ?? null,
      shellStderrBytes: shellExecutionTelemetry?.shellStderrBytes ?? null,
      shellStdoutTruncated: shellExecutionTelemetry?.shellStdoutTruncated ?? null,
      shellStderrTruncated: shellExecutionTelemetry?.shellStderrTruncated ?? null,
      missionAttemptId: input.missionAttemptId,
      missionPhase: input.missionPhase,
      deterministicActionId: input.deterministicActionId,
      connector: connectorReceipt?.connector ?? null,
      connectorOperation: connectorReceipt?.operation ?? null,
      connectorExternalIdCount: connectorReceipt?.externalIds.length ?? null,
      ...(stage686TraceDetails ?? {})
    }
  });

  const approvedExecutionMetadata: Metadata = {
    ...(executionOutcome.executionMetadata ?? {}),
    ...(shellExecutionTelemetry
      ? { ...shellExecutionTelemetry } as Metadata
      : {}),
    ...(stage686ExecutionMetadata ?? {}),
    missionAttemptId: input.missionAttemptId,
    missionPhase: input.missionPhase,
    deterministicActionId: input.deterministicActionId
  };
  if (connectorReceipt) {
    approvedExecutionMetadata.stage675Connector = connectorReceipt.connector;
    approvedExecutionMetadata.stage675ConnectorOperation = connectorReceipt.operation;
    approvedExecutionMetadata.stage675ConnectorRequestFingerprint =
      connectorReceipt.requestFingerprint;
    approvedExecutionMetadata.stage675ConnectorResponseFingerprint =
      connectorReceipt.responseFingerprint;
    approvedExecutionMetadata.stage675ConnectorObservedAt = connectorReceipt.observedAt;
    approvedExecutionMetadata.stage675ConnectorExternalIdCount = connectorReceipt.externalIds.length;
  }

  return {
    actionResult: buildApprovedActionResult({
      action: input.action,
      mode: input.mode,
      output,
      executionStatus: executionOutcome.status,
      executionMetadata: Object.keys(approvedExecutionMetadata).length > 0
        ? approvedExecutionMetadata
        : undefined,
      votes: input.combinedVotes,
      decision: input.decision
    }),
    approvedEstimatedCostDeltaUsd: estimateActionCostUsd({
      type: input.action.type,
      params: input.action.params
    }),
    outputLength: output.length
  };
}

/**
 * Attempts the executor's lightweight preparation path without failing the whole task-runner loop.
 *
 * @param executor - Executor that may support prepared output for some action types.
 * @param action - Action to prepare before full execution.
 * @returns Prepared output text when available, otherwise `null`.
 */
async function prepareActionOutput(
  executor: TaskRunnerExecutor,
  action: ActionRunResult["action"]
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

/**
 * Converts a typed executor outcome into a fail-closed runtime violation when execution did not succeed.
 *
 * @param action - Planned action that was executed.
 * @param outcome - Typed executor outcome emitted by the executor organ.
 * @returns Typed execution/block violation, or `null` when outcome status is `success`.
 */
function resolveExecutionOutcomeViolation(
  action: ActionRunResult["action"],
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
