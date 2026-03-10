/**
 * @fileoverview Canonical outbound-federation execution helper for the orchestrator entrypoint.
 */

import { selectModelForRole } from "../modelRouting";
import {
  evaluateFederatedOutboundPolicy,
  type FederatedOutboundRuntimeConfig
} from "../federatedOutboundDelegation";
import { type BrainConfig } from "../config";
import { type StateStore } from "../stateStore";
import { type PersonalityStore } from "../personalityStore";
import { type ReflectionOrgan } from "../../organs/reflection";
import { type ModelUsageSnapshot } from "../../models/types";
import { type FederatedHttpClient } from "../../interfaces/federatedClient";
import {
  type FederatedOutboundRuntimeConfigResolver,
  type TaskRunnerDependencies
} from "./contracts";
import { deriveFailureTaxonomyFromRun } from "./orchestratorReceipts";
import {
  persistLearningSignals,
  type PersistLearningSignalsDependencies
} from "./orchestratorLearning";
import { diffUsageSnapshot } from "../taskRunnerSupport";
import { type TaskRequest, type TaskRunResult } from "../types";

export interface MaybeRunOutboundFederatedTaskDependencies {
  appendTraceEvent: TaskRunnerDependencies["appendTraceEvent"];
  config: BrainConfig;
  createFederatedClient: (input: {
    baseUrl: string;
    timeoutMs: number;
    auth: {
      externalAgentId: string;
      sharedSecret: string;
    };
  }) => FederatedHttpClient;
  personalityStore?: Pick<PersonalityStore, "applyRunReward">;
  readModelUsageSnapshot: () => ModelUsageSnapshot;
  reflection: Pick<ReflectionOrgan, "reflectOnTask">;
  resolveFederatedOutboundRuntimeConfig: FederatedOutboundRuntimeConfigResolver;
  stateStore: Pick<StateStore, "appendRun">;
  workflowLearningDeps: PersistLearningSignalsDependencies;
}

/**
 * Attempts explicit outbound federated delegation before local planning/execution.
 *
 * @param deps - Outbound federation collaborators and persistence sinks.
 * @param task - Current task request.
 * @param startedAtIso - Task start timestamp.
 * @param startedAtMs - Task start time in epoch milliseconds.
 * @param usageStart - Model usage snapshot captured at task start.
 * @returns Delegated task run result or `null` when local execution should continue.
 */
export async function maybeRunOutboundFederatedTask(
  deps: MaybeRunOutboundFederatedTaskDependencies,
  task: TaskRequest,
  startedAtIso: string,
  startedAtMs: number,
  usageStart: ModelUsageSnapshot
): Promise<TaskRunResult | null> {
  let outboundConfig: FederatedOutboundRuntimeConfig;
  try {
    outboundConfig = deps.resolveFederatedOutboundRuntimeConfig(process.env);
  } catch (error) {
    await deps.appendTraceEvent({
      eventType: "constraint_blocked",
      taskId: task.id,
      details: {
        blockCode: "OUTBOUND_FEDERATION_CONFIG_INVALID",
        blockCategory: "runtime",
        fallbackLocal: true,
        reason: error instanceof Error ? error.message : String(error)
      }
    });
    return null;
  }

  const policyDecision = evaluateFederatedOutboundPolicy(task, outboundConfig);
  if (!policyDecision.intent) {
    return null;
  }

  if (!policyDecision.shouldDelegate || !policyDecision.target) {
    await deps.appendTraceEvent({
      eventType: "constraint_blocked",
      taskId: task.id,
      details: {
        blockCode: policyDecision.reasonCode,
        blockCategory: "runtime",
        fallbackLocal: true,
        reason: policyDecision.reason
      }
    });
    return null;
  }

  const target = policyDecision.target;
  const intent = policyDecision.intent;
  const quoteId = `${task.id}:${target.externalAgentId}:quote`;
  const client = deps.createFederatedClient({
    baseUrl: target.baseUrl,
    timeoutMs: target.awaitTimeoutMs,
    auth: {
      externalAgentId: target.externalAgentId,
      sharedSecret: target.sharedSecret
    }
  });

  const delegateResult = await client.delegate({
    quoteId,
    quotedCostUsd: intent.quotedCostUsd,
    goal: task.goal,
    userInput: intent.delegatedUserInput,
    requestedAt: task.createdAt
  });
  if (!delegateResult.ok || !delegateResult.taskId || !delegateResult.decision?.accepted) {
    await deps.appendTraceEvent({
      eventType: "constraint_blocked",
      taskId: task.id,
      details: {
        blockCode: "OUTBOUND_DELEGATION_DISPATCH_REJECTED",
        blockCategory: "runtime",
        fallbackLocal: true,
        httpStatus: delegateResult.httpStatus,
        reason:
          delegateResult.error ??
          delegateResult.decision?.reasons.join(" | ") ??
          "Outbound delegate call was not accepted."
      }
    });
    return null;
  }

  const pollResult = await client.awaitResult(delegateResult.taskId, {
    pollIntervalMs: target.pollIntervalMs,
    timeoutMs: target.awaitTimeoutMs
  });
  const remoteStatus = pollResult.result?.status ?? (pollResult.ok ? "pending" : "poll_failed");
  const remoteOutput = pollResult.result?.output ?? "";
  const remoteError =
    pollResult.result?.error ??
    (pollResult.ok ? null : pollResult.error ?? "Federated poll failed without error message.");
  const approved = pollResult.ok && pollResult.result?.status === "completed";
  const completedAtIso = new Date().toISOString();
  const usageEnd = deps.readModelUsageSnapshot();
  const usageDelta = diffUsageSnapshot(usageStart, usageEnd);

  const delegatedAction: TaskRunResult["plan"]["actions"][number] = {
    id: `federated_delegate_${task.id}`,
    type: "network_write",
    description: `Delegate task to federated target ${target.externalAgentId}.`,
    params: {
      endpoint: `${target.baseUrl}/federation/delegate`,
      externalAgentId: target.externalAgentId,
      quoteId,
      delegatedTaskId: delegateResult.taskId,
      quotedCostUsd: intent.quotedCostUsd,
      delegationMode: "federated_outbound_v1"
    },
    estimatedCostUsd: intent.quotedCostUsd
  };
  const actionResult: TaskRunResult["actionResults"][number] = {
    action: delegatedAction,
    mode: "escalation_path",
    approved,
    executionStatus: approved ? "success" : "failed",
    executionFailureCode: approved ? undefined : "ACTION_EXECUTION_FAILED",
    output: approved
      ? (remoteOutput.trim() || "Federated task completed with empty output payload.")
      : `Federated task did not complete successfully: ${remoteError ?? "unknown error"}`,
    executionMetadata: {
      outboundFederation: true,
      targetAgentId: target.externalAgentId,
      delegatedTaskId: delegateResult.taskId,
      remoteStatus
    },
    blockedBy: approved ? [] : ["ACTION_EXECUTION_FAILED"],
    violations: approved
      ? []
      : [
        {
          code: "ACTION_EXECUTION_FAILED",
          message:
            `Outbound federated task "${delegateResult.taskId}" failed with status "${remoteStatus}". ` +
            `Reason: ${remoteError ?? "unknown error"}.`
        }
      ],
    votes: []
  };
  const runResult: TaskRunResult = {
    task,
    plan: {
      taskId: task.id,
      plannerNotes:
        `Outbound federated delegation route selected for target "${target.externalAgentId}".`,
      actions: [delegatedAction]
    },
    actionResults: [actionResult],
    summary: approved
      ? `Delegated outbound task to "${target.externalAgentId}" (taskId=${delegateResult.taskId}) and received a completed result.`
      : `Delegated outbound task to "${target.externalAgentId}" (taskId=${delegateResult.taskId}) but remote execution failed (${remoteStatus}).`,
    modelUsage: usageDelta,
    startedAt: startedAtIso,
    completedAt: completedAtIso
  };
  const failureTaxonomy = deriveFailureTaxonomyFromRun(runResult);
  if (failureTaxonomy) {
    runResult.failureTaxonomy = failureTaxonomy;
  }

  await deps.appendTraceEvent({
    eventType: "action_executed",
    taskId: task.id,
    actionId: delegatedAction.id,
    mode: "escalation_path",
    details: {
      outboundFederation: true,
      targetAgentId: target.externalAgentId,
      delegatedTaskId: delegateResult.taskId,
      remoteStatus,
      outputLength: remoteOutput.length
    }
  });
  await deps.appendTraceEvent({
    eventType: "task_completed",
    taskId: task.id,
    durationMs: Date.now() - startedAtMs,
    details: {
      approvedCount: approved ? 1 : 0,
      blockedCount: approved ? 0 : 1,
      attemptsExecuted: 1,
      estimatedApprovedCostUsd: Number(intent.quotedCostUsd.toFixed(4)),
      modelSpendUsd: Number(usageDelta.estimatedSpendUsd.toFixed(8)),
      outboundFederation: true,
      targetAgentId: target.externalAgentId,
      delegatedTaskId: delegateResult.taskId,
      remoteStatus,
      failureCategory: failureTaxonomy?.failureCategory ?? null,
      failureCode: failureTaxonomy?.failureCode ?? null
    }
  });

  await deps.stateStore.appendRun(runResult);
  await persistLearningSignals(deps.workflowLearningDeps, runResult);

  if (deps.personalityStore) {
    try {
      await deps.personalityStore.applyRunReward(runResult);
    } catch (error) {
      console.error(
        `[Personality] non-fatal personality update failure for task ${task.id}: ${(error as Error).message}`
      );
    }
  }

  try {
    const reflectionModel = selectModelForRole("planner", deps.config);
    await deps.reflection.reflectOnTask(runResult, reflectionModel);
  } catch (error) {
    console.error(
      `[Reflection] non-fatal reflection failure for task ${task.id}: ${(error as Error).message}`
    );
  }

  return runResult;
}
