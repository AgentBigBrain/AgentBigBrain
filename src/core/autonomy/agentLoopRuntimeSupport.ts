/**
 * @fileoverview Shared callback contracts and delegate helpers for the autonomous loop entrypoint.
 */

import type { BrainConfig } from "../config";
import type { TaskRunResult } from "../types";
import type { ModelClient } from "../../models/types";
import {
  evaluateAutonomousNextStep,
  evaluateProactiveAutonomousGoal
} from "./agentLoopModelPolicy";
import {
  hasTaskRunResultBlockCode,
  type MissionEvidenceCounters,
  type RecoveryFailureClass
} from "./contracts";
import type { LoopbackTargetHint } from "./liveRunRecovery";
import type { ApprovedManagedProcessStartContext } from "./loopCleanupPolicy";

/**
 * Optional callbacks for observing autonomous loop progress.
 *
 * @remarks
 * Interface transports use these hooks to surface iteration progress without coupling themselves to
 * the inner loop implementation details.
 */
export interface AutonomousLoopCallbacks {
  onIterationStart?: (iteration: number, input: string) => Promise<void> | void;
  onIterationComplete?: (
    iteration: number,
    summary: string,
    approved: number,
    blocked: number,
    result: TaskRunResult
  ) => Promise<void> | void;
  onStateChange?: (update: AutonomousLoopStateUpdate) => Promise<void> | void;
  onGoalMet?: (reasoning: string, totalIterations: number) => Promise<void> | void;
  onGoalAborted?: (reason: string, totalIterations: number) => Promise<void> | void;
}

/**
 * Stable user-facing autonomous loop states surfaced through session and transport layers.
 */
export type AutonomousLoopState =
  | "starting"
  | "working"
  | "retrying"
  | "verifying"
  | "waiting_for_user"
  | "completed"
  | "stopped";

export type AutonomousLoopRecoveryKind =
  | "structured_executor_recovery"
  | "workspace_auto_recovery";

/**
 * Human-readable state update emitted during one autonomous loop run.
 */
export interface AutonomousLoopStateUpdate {
  state: AutonomousLoopState;
  iteration: number;
  message: string;
  recoveryKind?: AutonomousLoopRecoveryKind | null;
  recoveryClass?: RecoveryFailureClass | null;
  recoveryFingerprint?: string | null;
}

/**
 * Delegates autonomous next-step evaluation to the extracted autonomy policy helper.
 *
 * @param modelClient - Model client used for the next-step policy evaluation.
 * @param config - Runtime configuration passed through to the model-policy helper.
 * @param overarchingGoal - Current mission goal text.
 * @param lastResult - Latest task result from the autonomous loop.
 * @param missionEvidence - Cumulative deterministic mission evidence so far.
 * @param trackedManagedProcessLeaseId - Tracked managed-process lease, if any.
 * @param trackedManagedProcessStartContext - Tracked approved `start_process` context, if any.
 * @param trackedLoopbackTarget - Tracked loopback target, if any.
 * @returns Promise resolving to the next-step policy decision.
 */
export async function evaluateAutonomousNextStepPolicy(
  modelClient: ModelClient,
  config: BrainConfig,
  overarchingGoal: string,
  lastResult: TaskRunResult,
  missionEvidence: MissionEvidenceCounters,
  trackedManagedProcessLeaseId: string | null,
  trackedManagedProcessStartContext: ApprovedManagedProcessStartContext | null,
  trackedLoopbackTarget: LoopbackTargetHint | null
) {
  return await evaluateAutonomousNextStep(
    modelClient,
    config,
    overarchingGoal,
    lastResult,
    missionEvidence,
    trackedManagedProcessLeaseId,
    trackedManagedProcessStartContext,
    trackedLoopbackTarget
  );
}

/**
 * Delegates proactive-goal generation to the extracted autonomy policy helper.
 *
 * @param modelClient - Model client used for proactive-goal generation.
 * @param config - Runtime configuration passed through to the model-policy helper.
 * @param previousGoal - Goal that just completed.
 * @returns Promise resolving to the next proactive goal decision.
 */
export async function evaluateProactiveAutonomousGoalPolicy(
  modelClient: ModelClient,
  config: BrainConfig,
  previousGoal: string
) {
  return await evaluateProactiveAutonomousGoal(modelClient, config, previousGoal);
}

/**
 * Detects the inner governed-task retry budget terminal condition so the outer autonomous loop does
 * not continue reasoning after the mission already exhausted its recovery budget.
 *
 * @param result - Latest autonomous-loop task result.
 * @returns `true` when the task result contains the terminal mission-stop block code.
 */
export function hasMissionStopLimitReached(result: TaskRunResult): boolean {
  return hasTaskRunResultBlockCode(result, "MISSION_STOP_LIMIT_REACHED");
}
