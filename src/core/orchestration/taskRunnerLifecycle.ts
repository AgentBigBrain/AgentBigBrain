/**
 * @fileoverview Lifecycle helpers for blocked task-runner outcomes and mission stop limits.
 */

import { type ExecutionReceiptStore } from "../advancedAutonomyRuntime";
import { type BrainConfig } from "../config";
import { type ActionRunResult, type TaskRunResult } from "../types";
import { type GovernanceMemoryStore } from "../governanceMemory";
import { type AppendRuntimeTraceEventInput } from "../runtimeTraceLogger";
import {
  advanceMissionPhase,
  registerMissionActionOutcome,
  type MissionStateV1,
  type MissionStopLimitsV1
} from "../stage6_75MissionStateMachine";
import { appendExecutionReceipt, appendGovernanceEvent } from "./taskRunnerPersistence";
import { resolveDeterministicFrameworkLifecycleActionLimit } from "./deterministicFrameworkLifecyclePolicy";

type TraceDetails = Record<string, string | number | boolean | null>;

export interface RecordBlockedActionOutcomeInput {
  actionResult: ActionRunResult;
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
  attemptResults: ActionRunResult[];
  governanceMemoryStore: GovernanceMemoryStore;
  idempotencyKey: string;
  missionState: MissionStateV1;
  outputLength?: number;
  proposalId?: string | null;
  taskId: string;
  traceDetails?: TraceDetails;
}

export interface RecordApprovedActionOutcomeInput {
  actionResult: ActionRunResult;
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
  attemptResults: ActionRunResult[];
  executionReceiptStore: ExecutionReceiptStore;
  governanceMemoryStore: GovernanceMemoryStore;
  idempotencyKey: string;
  missionState: MissionStateV1;
  outputLength: number;
  planTaskId: string;
  proposalId?: string | null;
  taskId: string;
}

/**
 * Builds deterministic mission stop limits from runtime config.
 *
 * @param config - Runtime brain config.
 * @param plan - Plan being executed by the task runner.
 * @returns Mission stop limits used by the task runner.
 */
export function buildTaskRunnerMissionStopLimits(
  config: BrainConfig,
  plan: TaskRunResult["plan"]
): MissionStopLimitsV1 {
  return {
    maxActions: Math.max(
      1,
      resolveDeterministicFrameworkLifecycleActionLimit(
        plan,
        config.limits.maxActionsPerTask
      )
    ),
    maxDenies: Math.max(1, config.limits.maxPlanAttemptsPerTask * 2),
    maxBytes: 1_048_576
  };
}

/**
 * Records one blocked action result, optional trace telemetry, governance memory, and mission-state advance.
 *
 * @param input - Blocked action lifecycle inputs.
 * @returns Advanced mission state after the blocked action is registered.
 */
export async function recordBlockedActionOutcome(
  input: RecordBlockedActionOutcomeInput
): Promise<MissionStateV1> {
  input.attemptResults.push(input.actionResult);

  if (input.traceDetails) {
    await input.appendTraceEvent({
      eventType: "constraint_blocked",
      taskId: input.taskId,
      actionId: input.actionResult.action.id,
      proposalId: input.proposalId ?? undefined,
      mode: input.actionResult.mode,
      details: input.traceDetails
    });
  }

  await appendGovernanceEvent({
    taskId: input.taskId,
    proposalId: input.proposalId ?? null,
    actionResult: input.actionResult,
    governanceMemoryStore: input.governanceMemoryStore,
    appendTraceEvent: input.appendTraceEvent
  });

  const missionRegistration = registerMissionActionOutcome(
    input.missionState,
    input.idempotencyKey,
    input.outputLength ?? 0,
    true
  );
  return advanceMissionPhase(missionRegistration.nextState);
}

/**
 * Records one approved action result, receipt persistence, governance memory, and mission-state advance.
 *
 * @param input - Approved action lifecycle inputs.
 * @returns Advanced mission state after the approved action is registered.
 */
export async function recordApprovedActionOutcome(
  input: RecordApprovedActionOutcomeInput
): Promise<MissionStateV1> {
  input.attemptResults.push(input.actionResult);

  await appendGovernanceEvent({
    taskId: input.taskId,
    proposalId: input.proposalId ?? null,
    actionResult: input.actionResult,
    governanceMemoryStore: input.governanceMemoryStore,
    appendTraceEvent: input.appendTraceEvent
  });

  await appendExecutionReceipt({
    taskId: input.taskId,
    planTaskId: input.planTaskId,
    proposalId: input.proposalId ?? null,
    actionResult: input.actionResult,
    executionReceiptStore: input.executionReceiptStore
  });

  const missionRegistration = registerMissionActionOutcome(
    input.missionState,
    input.idempotencyKey,
    input.outputLength,
    false
  );
  return advanceMissionPhase(missionRegistration.nextState);
}
