/**
 * @fileoverview Executes per-action governance and execution loop phases for a task plan.
 */

import { resolveExecutionMode } from "./executionMode";
import { throwIfAborted } from "./runtimeAbort";
import type {
  ActionRunResult,
  ApprovalGrantV1
} from "./types";
import { isConstraintViolationCode } from "./types";
import { evaluateVerificationGate } from "./stage6_85QualityGatePolicy";
import {
  buildInitialMissionState,
  createMissionCheckpoint,
  evaluateMissionStopDecision,
  MissionStopLimitsV1
} from "./stage6_75MissionStateMachine";
import {
  diffUsageSnapshot,
  normalizeOptionalString,
  readModelUsageSnapshot,
  resolveVerificationCategoryForPrompt,
  shouldEnforceVerificationGateForRespond
} from "./taskRunnerSupport";
import { buildGovernorContext } from "./orchestration/taskRunnerProposal";
import { Stage686RuntimeActionEngine } from "./stage6_86/runtimeActions";
import {
  type RunPlanActionsInput,
  type TaskRunnerDependencies
} from "./orchestration/contracts";
import {
  buildTaskRunnerMissionStopLimits,
  recordApprovedActionOutcome,
  recordBlockedActionOutcome
} from "./orchestration/taskRunnerLifecycle";
import {
  evaluateDependentWorkspaceExecutionBlock,
  evaluateDependentLiveRunTargetBlock,
  rememberFailedManagedProcessStartTarget,
  rememberFailedWorkspaceExecutionDependency,
  type FailedManagedProcessStartTarget
} from "./orchestration/taskRunnerLiveRunGuards";
import {
  applyLiveRunTargetOverrides,
  applyRuntimeInspectionTargetOverrides,
  rememberLiveRunTargetOverride,
  type LoopbackTargetOverride
} from "./orchestration/taskRunnerLiveRunOverrides";
import {
  buildBlockedActionResult
} from "./orchestration/taskRunnerSummary";
import { evaluateTaskRunnerPreflight } from "./orchestration/taskRunnerPreflight";
import { type TaskRunnerConnectorReceiptSeed } from "./orchestration/taskRunnerNetworkPreflight";
import { evaluateTaskRunnerGovernance } from "./orchestration/taskRunnerGovernance";
import {
  executeTaskRunnerAction
} from "./orchestration/taskRunnerExecution";

export type { RunPlanActionsInput, TaskRunnerDependencies } from "./orchestration/contracts";

export class TaskRunner {
  private readonly stage686RuntimeActionEngine: Stage686RuntimeActionEngine;

  /**
   * Initializes `TaskRunner` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Stores collaborators injected by `buildBrain`/orchestration wiring for later runtime use.
   *
   * @param deps - Runtime dependencies for governance, execution, receipts, and tracing.
   */
  constructor(private readonly deps: TaskRunnerDependencies) {
    this.stage686RuntimeActionEngine =
      deps.stage686RuntimeActionEngine ??
      new Stage686RuntimeActionEngine({
        backend: deps.config.persistence.ledgerBackend,
        sqlitePath: deps.config.persistence.ledgerSqlitePath,
        exportJsonOnWrite: deps.config.persistence.exportJsonOnWrite
      });
  }

  /**
   * Executes one planner action list through constraints, council voting, and executor/runtime receipts.
   *
   * **Why it exists:**
   * This is the core governed action loop. Keeping it in one method preserves the exact order of
   * fail-closed checks (deadline, spend, hard constraints, stage guards, governance, verification
   * gate, execution, and ledger writes).
   *
   * **What it talks to:**
   * - Uses `MasterGovernor` (import `MasterGovernor`) from `../governors/masterGovernor`.
   * - Uses `runCouncilVote` (import `runCouncilVote`) from `../governors/voteGate`.
   * - Uses `resolveExecutionMode` (import `resolveExecutionMode`) from `./executionMode`.
   * - Uses `evaluateHardConstraints` (import `evaluateHardConstraints`) from `./hardConstraints`.
   * - Uses `evaluateStage675EgressPolicy` (import `evaluateStage675EgressPolicy`) from `./stage6_75EgressPolicy`.
   * - Additional imported collaborators are also used in this function body.
   *
   * @param input - Task/plan context and execution limits for this run.
   * @returns Per-action outcomes plus approved deterministic-cost delta for this plan attempt.
   */
  async runPlanActions(
    input: RunPlanActionsInput
  ): Promise<{ results: ActionRunResult[]; approvedEstimatedCostDeltaUsd: number }> {
    const {
      task,
      state,
      plan,
      missionAttemptId,
      startedAtMs,
      cumulativeApprovedEstimatedCostUsd,
      modelUsageStart,
      profileMemoryStatus,
      signal
    } = input;
    const attemptResults: ActionRunResult[] = [];
    let approvedEstimatedCostDeltaUsd = 0;
    let missionState = buildInitialMissionState(task.id, missionAttemptId);
    const deterministicActionIds = new Set<string>();
    const approvalGrantById = new Map<string, ApprovalGrantV1>();
    const connectorReceiptByActionId = new Map<string, TaskRunnerConnectorReceiptSeed>();
    let failedManagedProcessStartTargets: readonly FailedManagedProcessStartTarget[] = [];
    let failedWorkspaceExecutionDependencies:
      readonly import("./orchestration/taskRunnerLiveRunGuards").FailedWorkspaceExecutionDependency[] = [];
    let liveRunTargetOverrides: readonly LoopbackTargetOverride[] = [];
    const missionStopLimits: MissionStopLimitsV1 = buildTaskRunnerMissionStopLimits(
      this.deps.config,
      plan
    );

    for (const action of plan.actions) {
      throwIfAborted(signal);
      let effectiveAction = applyLiveRunTargetOverrides(
        action,
        liveRunTargetOverrides
      );
      effectiveAction = applyRuntimeInspectionTargetOverrides(
        effectiveAction,
        task.userInput
      );
      const mode = resolveExecutionMode(effectiveAction, this.deps.config);
      const dependentWorkspaceBlock = evaluateDependentWorkspaceExecutionBlock(
        effectiveAction,
        mode,
        failedWorkspaceExecutionDependencies
      );
      if (dependentWorkspaceBlock) {
        missionState = await recordBlockedActionOutcome({
          actionResult: dependentWorkspaceBlock.actionResult,
          appendTraceEvent: this.deps.appendTraceEvent,
          attemptResults,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          idempotencyKey: `${task.id}:${missionAttemptId}:${action.id}`,
          missionState,
          taskId: task.id,
          traceDetails: dependentWorkspaceBlock.traceDetails
        });
        continue;
      }
      const dependentLiveRunBlock = evaluateDependentLiveRunTargetBlock(
        effectiveAction,
        mode,
        failedManagedProcessStartTargets
      );
      if (dependentLiveRunBlock) {
        missionState = await recordBlockedActionOutcome({
          actionResult: dependentLiveRunBlock.actionResult,
          appendTraceEvent: this.deps.appendTraceEvent,
          attemptResults,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          idempotencyKey: `${task.id}:${missionAttemptId}:${action.id}`,
          missionState,
          taskId: task.id,
          traceDetails: dependentLiveRunBlock.traceDetails
        });
        continue;
      }
      const usageDelta = diffUsageSnapshot(
        modelUsageStart,
        readModelUsageSnapshot(this.deps.modelClient)
      );
      const nowIso = new Date().toISOString();
      const idempotencyKey =
        normalizeOptionalString(action.params.idempotencyKey) ??
        `${task.id}:${missionAttemptId}:${effectiveAction.id}`;
      const missionCheckpoint = createMissionCheckpoint(
        missionState,
        missionState.currentPhase,
        action.type,
        idempotencyKey,
        action.params,
        nowIso
      );
      const missionStopDecision = evaluateMissionStopDecision(missionState, missionStopLimits);
      if (missionStopDecision.shouldStop && missionStopDecision.blockCode) {
        const normalizedMissionStopCode = isConstraintViolationCode(missionStopDecision.blockCode)
          ? missionStopDecision.blockCode
          : "MISSION_STOP_LIMIT_REACHED";
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: [normalizedMissionStopCode],
          violations: [
            {
              code: normalizedMissionStopCode,
              message: missionStopDecision.reason
            }
          ],
          votes: []
        };
        missionState = await recordBlockedActionOutcome({
          actionResult: blockedResult,
          appendTraceEvent: this.deps.appendTraceEvent,
          attemptResults,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          idempotencyKey,
          missionState,
          taskId: task.id,
          traceDetails: {
            blockCode: normalizedMissionStopCode,
            blockCategory: "runtime",
            missionAttemptId,
            missionPhase: missionState.currentPhase
          }
        });
        continue;
      }
      if (missionState.seenIdempotencyKeys[idempotencyKey] === true) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: ["IDEMPOTENCY_KEY_REPLAY_DETECTED"],
          violations: [
            {
              code: "IDEMPOTENCY_KEY_REPLAY_DETECTED",
              message: "Action idempotency key replay detected; execution denied."
            }
          ],
          votes: []
        };
        missionState = await recordBlockedActionOutcome({
          actionResult: blockedResult,
          appendTraceEvent: this.deps.appendTraceEvent,
          attemptResults,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          idempotencyKey,
          missionState,
          taskId: task.id,
          traceDetails: {
            blockCode: "IDEMPOTENCY_KEY_REPLAY_DETECTED",
            blockCategory: "runtime",
            idempotencyKey
          }
        });
        continue;
      }
      if (deterministicActionIds.has(missionCheckpoint.actionId)) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: ["ACTION_ID_DUPLICATE_DETECTED"],
          violations: [
            {
              code: "ACTION_ID_DUPLICATE_DETECTED",
              message: "Deterministic mission action id duplicated within this mission attempt."
            }
          ],
          votes: []
        };
        missionState = await recordBlockedActionOutcome({
          actionResult: blockedResult,
          appendTraceEvent: this.deps.appendTraceEvent,
          attemptResults,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          idempotencyKey,
          missionState,
          taskId: task.id,
          traceDetails: {
            blockCode: "ACTION_ID_DUPLICATE_DETECTED",
            blockCategory: "runtime",
            deterministicActionId: missionCheckpoint.actionId
          }
        });
        continue;
      }
      deterministicActionIds.add(missionCheckpoint.actionId);
      const preflightOutcome = evaluateTaskRunnerPreflight({
        action: effectiveAction,
        approvalGrantById,
        config: this.deps.config,
        cumulativeEstimatedCostUsd:
          cumulativeApprovedEstimatedCostUsd + approvedEstimatedCostDeltaUsd,
        estimatedModelSpendUsd: usageDelta.estimatedSpendUsd,
        cumulativeModelCalls: usageDelta.calls,
        modelBillingMode: usageDelta.billingMode,
        idempotencyKey,
        mode,
        nowIso,
        startedAtMs,
        task
      });
      if (preflightOutcome.blockedOutcome) {
        missionState = await recordBlockedActionOutcome({
          actionResult: preflightOutcome.blockedOutcome.actionResult,
          appendTraceEvent: this.deps.appendTraceEvent,
          attemptResults,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          idempotencyKey,
          missionState,
          proposalId: preflightOutcome.proposal?.id,
          taskId: task.id,
          traceDetails: preflightOutcome.blockedOutcome.traceDetails
        });
        failedManagedProcessStartTargets = rememberFailedManagedProcessStartTarget(
          failedManagedProcessStartTargets,
          preflightOutcome.blockedOutcome.actionResult
        );
        failedWorkspaceExecutionDependencies = rememberFailedWorkspaceExecutionDependency(
          failedWorkspaceExecutionDependencies,
          preflightOutcome.blockedOutcome.actionResult
        );
        continue;
      }
      const proposal = preflightOutcome.proposal;
      if (!proposal) {
        throw new Error("TaskRunner preflight outcome missing proposal after successful evaluation.");
      }
      if (preflightOutcome.approvalGrant) {
        approvalGrantById.set(
          preflightOutcome.approvalGrant.approvalId,
          preflightOutcome.approvalGrant.grant
        );
      }
      if (preflightOutcome.connectorReceiptInput) {
        connectorReceiptByActionId.set(action.id, preflightOutcome.connectorReceiptInput);
      }

      const governanceMemory = await this.deps.governanceMemoryStore.getReadView();
      const governorContext = buildGovernorContext({
        task,
        state,
        governanceMemory,
        profileMemoryStatus,
        config: this.deps.config,
        modelClient: this.deps.modelClient
      });
      const governanceOutcome = await evaluateTaskRunnerGovernance({
        action: effectiveAction,
        mode,
        proposal,
        taskId: task.id,
        governorContext,
        governors: this.deps.governors,
        masterGovernor: this.deps.masterGovernor,
        fastPathGovernorIds: this.deps.config.governance.fastPathGovernorIds,
        perGovernorTimeoutMs: this.deps.config.limits.perGovernorTimeoutMs,
        appendTraceEvent: this.deps.appendTraceEvent
      });
      if (governanceOutcome.blockedResult) {
        missionState = await recordBlockedActionOutcome({
          actionResult: governanceOutcome.blockedResult,
          appendTraceEvent: this.deps.appendTraceEvent,
          attemptResults,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          idempotencyKey,
          missionState,
          proposalId: proposal.id,
          taskId: task.id,
          traceDetails: governanceOutcome.blockedTraceDetails
        });
        failedManagedProcessStartTargets = rememberFailedManagedProcessStartTarget(
          failedManagedProcessStartTargets,
          governanceOutcome.blockedResult
        );
        failedWorkspaceExecutionDependencies = rememberFailedWorkspaceExecutionDependency(
          failedWorkspaceExecutionDependencies,
          governanceOutcome.blockedResult
        );
        continue;
      }
      const combinedVotes = governanceOutcome.combinedVotes;
      const decision = governanceOutcome.decision;
      if (!decision) {
        throw new Error("TaskRunner governance outcome missing decision after successful evaluation.");
      }

      // Stage 6.85 verification gate enforcement applies only to explicit completion-claim prompts.
      if (action.type === "respond") {
        if (shouldEnforceVerificationGateForRespond(task.userInput)) {
          const category = resolveVerificationCategoryForPrompt(task.userInput);
          const proofRefs = attemptResults
            .filter((result) => result.approved && result.action.type !== "respond")
            .map((result) => `action:${result.action.id}`);

          const verificationGate = evaluateVerificationGate({
            gateId: "verification_gate_runtime_chat",
            category,
            proofRefs,
            waiverApproved: false
          });

          if (!verificationGate.passed) {
          const blockedResult = buildBlockedActionResult({
              action: effectiveAction,
              mode,
              blockedBy: ["VERIFICATION_GATE_FAILED"],
              violations: [
                {
                  code: "VERIFICATION_GATE_FAILED",
                  message:
                    `Task requires deterministic completion proofs for category '${category}', but none were provided. ` +
                    "The respond action is blocked to prevent false completion claims."
                }
              ],
              votes: combinedVotes,
              decision
            });
            missionState = await recordBlockedActionOutcome({
              actionResult: blockedResult,
              appendTraceEvent: this.deps.appendTraceEvent,
              attemptResults,
              governanceMemoryStore: this.deps.governanceMemoryStore,
              idempotencyKey,
              missionState,
              proposalId: proposal.id,
              taskId: task.id,
              traceDetails: {
                blockCode: "VERIFICATION_GATE_FAILED",
                blockCategory: "constraints"
              }
            });
            continue;
          }
        }
      }

      const executionResult = await executeTaskRunnerAction({
        action: effectiveAction,
        appendTraceEvent: this.deps.appendTraceEvent,
        combinedVotes,
        connectorReceiptInput: connectorReceiptByActionId.get(action.id) ?? null,
        decision,
        deterministicActionId: missionCheckpoint.actionId,
        executor: this.deps.executor,
        missionAttemptId,
        missionPhase: missionState.currentPhase,
        mode,
        proposalId: proposal.id,
        signal,
        stage686RuntimeActionEngine: this.stage686RuntimeActionEngine,
        taskId: task.id,
        userInput: task.userInput
      });
      if (!executionResult.actionResult.approved) {
        missionState = await recordBlockedActionOutcome({
          actionResult: executionResult.actionResult,
          appendTraceEvent: this.deps.appendTraceEvent,
          attemptResults,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          idempotencyKey,
          missionState,
          outputLength: executionResult.outputLength,
          proposalId: proposal.id,
          taskId: task.id,
          traceDetails: executionResult.blockedTraceDetails
        });
        failedManagedProcessStartTargets = rememberFailedManagedProcessStartTarget(
          failedManagedProcessStartTargets,
          executionResult.actionResult
        );
        failedWorkspaceExecutionDependencies = rememberFailedWorkspaceExecutionDependency(
          failedWorkspaceExecutionDependencies,
          executionResult.actionResult
        );
        continue;
      }
      liveRunTargetOverrides = rememberLiveRunTargetOverride(
        liveRunTargetOverrides,
        executionResult.actionResult
      );
      approvedEstimatedCostDeltaUsd += executionResult.approvedEstimatedCostDeltaUsd;
      missionState = await recordApprovedActionOutcome({
        actionResult: executionResult.actionResult,
        appendTraceEvent: this.deps.appendTraceEvent,
        attemptResults,
        executionReceiptStore: this.deps.executionReceiptStore,
        governanceMemoryStore: this.deps.governanceMemoryStore,
        idempotencyKey,
        missionState,
        outputLength: executionResult.outputLength,
        planTaskId: plan.taskId,
        proposalId: proposal.id,
        taskId: task.id
      });
    }

    return {
      results: attemptResults,
      approvedEstimatedCostDeltaUsd
    };
  }
}
