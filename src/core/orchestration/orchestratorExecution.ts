/**
 * @fileoverview Canonical local task execution flow for the core orchestrator.
 */

import { type ModelUsageSnapshot } from "../../models/types";
import { buildMissionPostmortem, evaluateRetryBudget, type RetryBudgetDecision } from "../stage6_85RecoveryPolicy";
import { throwIfAborted } from "../runtimeAbort";
import { diffUsageSnapshot, renderModelUsageSummary } from "../taskRunnerSupport";
import { type AppendRuntimeTraceEventInput } from "../runtimeTraceLogger";
import { type BrainConfig } from "../config";
import { type BrainState, type MissionCheckpointV1, type ProfileMemoryStatus, type TaskRunResult } from "../types";
import { type TaskRunner } from "../taskRunner";
import {
  buildMissionCheckpoint,
  deriveFailureTaxonomyFromRun,
  resolveMissionFailureBlockCode,
  resolveMissionFailureRootCause,
  shouldEmitMissionPostmortem
} from "./orchestratorReceipts";

export interface ExecuteLocalOrchestratorTaskInput {
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
  buildReplanInput: (
    profileAwareUserInput: string,
    governanceFeedback: string,
    nextAttempt: number
  ) => string;
  config: BrainConfig;
  extractGovernanceReplanFeedback: (results: TaskRunResult["actionResults"]) => string | null;
  planForAttempt: (userInput: string, attemptNumber: number) => Promise<TaskRunResult["plan"]>;
  profileAwareUserInput: string;
  profileMemoryStatus: ProfileMemoryStatus;
  readModelUsageSnapshot: () => ModelUsageSnapshot;
  signal?: AbortSignal;
  startedAtIso: string;
  startedAtMs: number;
  state: BrainState;
  task: TaskRunResult["task"];
  taskRunner: Pick<TaskRunner, "runPlanActions">;
  usageStart: ModelUsageSnapshot;
}

/**
 * Executes the local planner -> task-runner -> retry loop and assembles the canonical task summary.
 *
 * @param input - Local orchestration dependencies and retry-loop collaborators.
 * @returns Completed local task run result with postmortem/taxonomy fields populated.
 */
export async function executeLocalOrchestratorTask(
  input: ExecuteLocalOrchestratorTaskInput
): Promise<TaskRunResult> {
  throwIfAborted(input.signal);
  const actionResults: TaskRunResult["actionResults"] = [];
  const missionCheckpoints: MissionCheckpointV1[] = [];
  let cumulativeApprovedEstimatedCostUsd = 0;
  const maxPlanAttempts = Math.max(1, input.config.limits.maxPlanAttemptsPerTask);
  let attemptsExecuted = 0;
  let retryDecision: RetryBudgetDecision | null = null;
  let currentPlan = await input.planForAttempt(input.profileAwareUserInput, 1);

  for (let attempt = 1; attempt <= maxPlanAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    attemptsExecuted = attempt;
    const attemptOutcome = await input.taskRunner.runPlanActions({
      task: input.task,
      state: input.state,
      plan: currentPlan,
      startedAtMs: input.startedAtMs,
      cumulativeApprovedEstimatedCostUsd,
      modelUsageStart: input.usageStart,
      profileMemoryStatus: input.profileMemoryStatus,
      missionAttemptId: attempt,
      signal: input.signal
    });
    actionResults.push(...attemptOutcome.results);
    const checkpointObservedAtIso = new Date().toISOString();
    missionCheckpoints.push(
      ...attemptOutcome.results.map((result, index) =>
        buildMissionCheckpoint(
          input.task.id,
          attempt,
          result,
          missionCheckpoints.length + index + 1,
          checkpointObservedAtIso
        )
      )
    );
    cumulativeApprovedEstimatedCostUsd += attemptOutcome.approvedEstimatedCostDeltaUsd;

    const governanceFeedback = input.extractGovernanceReplanFeedback(attemptOutcome.results);
    if (!governanceFeedback) {
      break;
    }

    retryDecision = evaluateRetryBudget(attempt, maxPlanAttempts);
    if (!retryDecision.shouldRetry) {
      await input.appendTraceEvent({
        eventType: "constraint_blocked",
        taskId: input.task.id,
        details: {
          blockCode: retryDecision.blockCode,
          blockCategory: "runtime"
        }
      });
      break;
    }

    const replannedInput = input.buildReplanInput(
      input.profileAwareUserInput,
      governanceFeedback,
      retryDecision.nextAttempt
    );
    currentPlan = await input.planForAttempt(replannedInput, retryDecision.nextAttempt);
  }

  const approvedCount = actionResults.filter((result) => result.approved).length;
  const blockedCount = actionResults.length - approvedCount;
  const budgetBlockedCount = actionResults.filter((result) =>
    result.blockedBy.includes("COST_LIMIT_EXCEEDED") ||
    result.blockedBy.includes("CUMULATIVE_COST_LIMIT_EXCEEDED") ||
    result.blockedBy.includes("MODEL_SPEND_LIMIT_EXCEEDED")
  ).length;
  const completedAt = new Date().toISOString();
  const usageEnd = input.readModelUsageSnapshot();
  const usageDelta = diffUsageSnapshot(input.usageStart, usageEnd);
  const missionPostmortem =
    approvedCount === 0 &&
    blockedCount > 0 &&
    shouldEmitMissionPostmortem(actionResults, retryDecision)
      ? buildMissionPostmortem({
        missionId: input.task.id,
        missionAttemptId: attemptsExecuted,
        failedAt: completedAt,
        blockCode: resolveMissionFailureBlockCode(actionResults, retryDecision),
        rootCause: resolveMissionFailureRootCause(actionResults, retryDecision),
        checkpoints: missionCheckpoints
      })
      : null;

  const runResult: TaskRunResult = {
    task: input.task,
    plan: currentPlan,
    actionResults,
    summary:
      `Completed task with ${approvedCount} approved action(s) and ${blockedCount} blocked action(s) ` +
      `across ${attemptsExecuted} plan attempt(s). Estimated approved action cost ` +
      `${cumulativeApprovedEstimatedCostUsd.toFixed(2)}/${input.config.limits.maxCumulativeEstimatedCostUsd.toFixed(2)} USD.` +
      ` ${renderModelUsageSummary(usageDelta, input.config.limits.maxCumulativeModelSpendUsd)}` +
      (missionPostmortem
        ? ` Recovery postmortem: ${missionPostmortem.blockCode} (${missionPostmortem.rootCause}).`
        : "") +
      (input.profileMemoryStatus === "degraded_unavailable"
        ? " Agent Friend context unavailable (degraded_unavailable); continuing with core task mode."
        : "") +
      (budgetBlockedCount > 0
        ? ` Budget controls blocked ${budgetBlockedCount} action(s).`
        : ""),
    modelUsage: usageDelta,
    startedAt: input.startedAtIso,
    completedAt
  };
  const failureTaxonomy = deriveFailureTaxonomyFromRun(runResult);
  if (failureTaxonomy) {
    runResult.failureTaxonomy = failureTaxonomy;
  }

  await input.appendTraceEvent({
    eventType: "task_completed",
    taskId: input.task.id,
    durationMs: Date.now() - input.startedAtMs,
    details: {
      approvedCount,
      blockedCount,
      attemptsExecuted,
      estimatedApprovedCostUsd: Number(cumulativeApprovedEstimatedCostUsd.toFixed(4)),
      modelSpendUsd: Number(usageDelta.estimatedSpendUsd.toFixed(8)),
      modelBillingMode: usageDelta.billingMode,
      firstPrinciplesRequired: currentPlan.firstPrinciples?.required ?? false,
      firstPrinciplesTriggerCount: currentPlan.firstPrinciples?.triggerReasons.length ?? 0,
      workflowHintCount: currentPlan.learningHints?.workflowHintCount ?? 0,
      judgmentHintCount: currentPlan.learningHints?.judgmentHintCount ?? 0,
      failureCategory: failureTaxonomy?.failureCategory ?? null,
      failureCode: failureTaxonomy?.failureCode ?? null,
      retryStopBlockCode:
        retryDecision && !retryDecision.shouldRetry ? retryDecision.blockCode : null,
      postmortemBlockCode: missionPostmortem?.blockCode ?? null,
      lastDurableActionId: missionPostmortem?.lastDurableCheckpoint?.actionId ?? null
    }
  });

  return runResult;
}
