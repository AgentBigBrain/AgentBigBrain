/**
 * @fileoverview Manages the continuous autonomous execution loop for resolving complex goals without user input.
 */

import { BrainOrchestrator } from "./orchestrator";
import { MAIN_AGENT_ID } from "./agentIdentity";
import { makeId } from "./ids";
import { isAbortError } from "./runtimeAbort";
import { TaskRequest, TaskRunResult } from "./types";
import { type AutonomousNextStepModelOutput, ModelClient } from "../models/types";
import { BrainConfig } from "./config";
import { humanizeAutonomousStopReason } from "./autonomy/stopReasonText";
import {
    EMPTY_NEXT_STEP_REASON_CODE, EXECUTION_STYLE_STALL_REASON_CODE, GENERIC_STALL_REASON_CODE,
    MAX_ITERATIONS_REASON_CODE, MAX_MANAGED_PROCESS_READINESS_FAILURES,
    MISSION_REQUIREMENT_PROCESS_STOP, MISSION_REQUIREMENT_SIDE_EFFECT,
    TASK_EXECUTION_FAILED_REASON_CODE, formatReasonWithCode, type MissionEvidenceCounters
} from "./autonomy/contracts";
import { buildMissionCompletionContract } from "./autonomy/missionContract";
import {
    buildManagedProcessStopRetryInput, buildMissionEvidenceRetryInput,
    countApprovedArtifactMutationActions, countApprovedBrowserOpenProofActions,
    countApprovedBrowserProofActions, countApprovedManagedProcessStopActions,
    countApprovedReadinessProofActions, countApprovedRealSideEffectActions,
    countApprovedTargetPathTouchActions, mapRequirementToReasonCode, resolveMissingMissionRequirements
} from "./autonomy/missionEvidence";
import { formatManagedProcessNeverReadyReason, resolveLiveVerificationBlockedAbortReason } from "./autonomy/completionGate";
import { describeLoopbackTarget, hasReadinessNotReadyFailure, resolveTrackedLoopbackTarget, type LoopbackTargetHint } from "./autonomy/liveRunRecovery";
import {
    cleanupManagedProcessLease,
    findApprovedManagedProcessCheckResult,
    resolveTrackedManagedProcessLeaseId,
    resolveTrackedManagedProcessStartContext,
    type ApprovedManagedProcessStartContext
} from "./autonomy/loopCleanupPolicy";
import { formatLiveRunCompletionReasoning } from "./autonomy/agentLoopModelPolicy";
import { buildAutonomousUserTurnGateReason } from "./autonomy/agentLoopUserTurnGate";
import {
    buildRetryingStateMessage, buildVerificationStateMessage, buildWorkingStateMessage,
    buildWorkspaceRecoveryStateMessage
} from "./autonomy/agentLoopProgress";
import { evaluateAutonomousNextStepPolicy, evaluateProactiveAutonomousGoalPolicy, hasMissionStopLimitReached } from "./autonomy/agentLoopRuntimeSupport";
import type { AutonomousLoopCallbacks } from "./autonomy/agentLoopRuntimeSupport";
import {
    buildWorkspaceRecoveryAbortReason,
    deriveWorkspaceRecoveryInspectionSignal,
    deriveWorkspaceRecoverySignal,
    hasApprovedWorkspaceRecoveryMoveAction,
    hasApprovedWorkspaceRecoveryStopProcessAction
} from "./autonomy/workspaceRecoveryPolicy";
import {
    buildWorkspaceRecoveryNextUserInput,
    buildWorkspaceRecoveryPostInspectionRetryInput,
    buildWorkspaceRecoveryPostShutdownRetryInput,
    containsWorkspaceRecoveryPostInspectionRetryMarker,
    containsWorkspaceRecoveryStopExactMarker
} from "./autonomy/workspaceRecoveryCommandBuilders";
import { resolveStructuredRecoveryRuntimeDecision } from "./autonomy/structuredRecoveryRuntime";

export type { AutonomousLoopCallbacks, AutonomousLoopState, AutonomousLoopStateUpdate } from "./autonomy/agentLoopRuntimeSupport";
export class AutonomousLoop {
    /** Initializes the autonomous loop with explicit orchestration, model, and runtime dependencies. */
    constructor(private readonly orchestrator: BrainOrchestrator, private readonly modelClient: ModelClient, private readonly config: BrainConfig) {}

    /** Delegates autonomous next-step evaluation so tests can exercise the exact loop policy. */
    private async evaluateNextStep(overarchingGoal: string, lastResult: TaskRunResult, missionEvidence: MissionEvidenceCounters, trackedManagedProcessLeaseId: string | null, trackedLoopbackTarget: LoopbackTargetHint | null): Promise<AutonomousNextStepModelOutput> {
        return await evaluateAutonomousNextStepPolicy(
            this.modelClient,
            this.config,
            overarchingGoal,
            lastResult,
            missionEvidence,
            trackedManagedProcessLeaseId,
            null,
            trackedLoopbackTarget
        );
    }

    /** Runs the bounded autonomous loop, including retries, proof gates, cleanup, and optional daemon rollover. */
    async run(
        overarchingGoal: string,
        callbacks?: AutonomousLoopCallbacks,
        signal?: AbortSignal,
        daemonGoalRolloverLimit?: number,
        initialGoalInput?: string | null
    ): Promise<void> {
        let currentOverarchingGoal = overarchingGoal;
        let daemonGoalRollovers = 0;
        let currentLoopInitialInput =
            typeof initialGoalInput === "string" && initialGoalInput.trim().length > 0
                ? initialGoalInput.trim()
                : null;
        /* eslint-disable no-constant-condition */
        while (true) {
            console.log(`\n======================================================`);
            console.log(`[Autonomous Loop Started] Goal: "${currentOverarchingGoal}"`);
            console.log(`======================================================\n`);
            await callbacks?.onStateChange?.({
                state: "starting",
                iteration: 0,
                message:
                    "I'm taking this end to end now. I'll keep going until it's done or I hit a real blocker."
            });

            let currentInput = currentLoopInitialInput ?? currentOverarchingGoal;
            let iteration = 0;
            const maxIterations = this.config.limits.maxAutonomousIterations;
            const maxConsecutiveZeroProgressIterations =
                this.config.limits.maxAutonomousConsecutiveNoProgressIterations;
            const unlimited = maxIterations <= 0;
            let consecutiveZeroProgress = 0;
            const missionContract = buildMissionCompletionContract(currentOverarchingGoal);
            let missionEvidence: MissionEvidenceCounters = {
                realSideEffects: 0,
                targetPathTouches: 0,
                artifactMutations: 0,
                readinessProofs: 0,
                browserProofs: 0,
                browserOpenProofs: 0,
                processStopProofs: 0
            };
            let trackedManagedProcessLeaseId: string | null = null;
            let trackedManagedProcessStartContext: ApprovedManagedProcessStartContext | null = null;
            let trackedLoopbackTarget: LoopbackTargetHint | null = null;
            let readinessFailureLeaseId: string | null = null;
            let readinessFailureCount = 0;
            const structuredRecoveryAttemptCounts = new Map<string, number>();
            let goalMetInCurrentLoop = false;
            const abortCurrentLoop = async (
                reason: string,
                currentIteration: number,
                cleanupManagedProcess = false
            ): Promise<void> => {
                if (cleanupManagedProcess && trackedManagedProcessLeaseId) {
                    await cleanupManagedProcessLease(
                        this.orchestrator,
                        currentOverarchingGoal,
                        trackedManagedProcessLeaseId
                    );
                    trackedManagedProcessLeaseId = null;
                }
                console.log(`\n[Autonomous Loop Aborted] ${humanizeAutonomousStopReason(reason)}\n`);
                await callbacks?.onStateChange?.({
                    state: "stopped",
                    iteration: currentIteration,
                    message: humanizeAutonomousStopReason(reason)
                });
                await callbacks?.onGoalAborted?.(reason, currentIteration);
                goalMetInCurrentLoop = true;
            };

            while (unlimited || iteration < maxIterations) {
                if (signal?.aborted) {
                    const reason = "Cancelled by user.";
                    if (trackedManagedProcessLeaseId) {
                        await cleanupManagedProcessLease(
                            this.orchestrator,
                            currentOverarchingGoal,
                            trackedManagedProcessLeaseId
                        );
                        trackedManagedProcessLeaseId = null;
                    }
                    console.log(`\n[Autonomous Loop Cancelled] ${reason}\n`);
                    await callbacks?.onGoalAborted?.(reason, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }

                iteration++;
                console.log(`\n--- [Iteration ${iteration}] Executing Subtask ---`);
                console.log(`> Request: "${currentInput}"\n`);
                await callbacks?.onStateChange?.({
                    state: "working",
                    iteration,
                    message: buildWorkingStateMessage(iteration, currentInput)
                });
                await callbacks?.onIterationStart?.(iteration, currentInput);

                const task: TaskRequest = {
                    id: makeId("task"),
                    agentId: MAIN_AGENT_ID,
                    goal: currentOverarchingGoal,
                    userInput: currentInput,
                    createdAt: new Date().toISOString()
                };

                let result: TaskRunResult;
                try {
                    result = await this.orchestrator.runTask(task, { signal });
                } catch (error) {
                    if (signal?.aborted || isAbortError(error)) {
                        const reason = "Cancelled by user.";
                        if (trackedManagedProcessLeaseId) {
                            await cleanupManagedProcessLease(
                                this.orchestrator,
                                currentOverarchingGoal,
                                trackedManagedProcessLeaseId
                            );
                            trackedManagedProcessLeaseId = null;
                        }
                        console.log(`\n[Autonomous Loop Cancelled] ${reason}\n`);
                        await callbacks?.onGoalAborted?.(reason, iteration);
                        goalMetInCurrentLoop = true;
                        break;
                    }
                    const errorMessage = (error as Error).message || "Unknown runtime error.";
                    const reason = formatReasonWithCode(
                        TASK_EXECUTION_FAILED_REASON_CODE,
                        `Iteration ${iteration} failed before completion: ${errorMessage}`
                    );
                    await abortCurrentLoop(reason, iteration, true);
                    break;
                }
                const approved = result.actionResults.filter(r => r.approved).length;
                const approvedRealSideEffects = countApprovedRealSideEffectActions(result);
                const approvedTargetPathTouches = countApprovedTargetPathTouchActions(
                    result,
                    missionContract.targetPathHints
                );
                const approvedArtifactMutations = countApprovedArtifactMutationActions(result);
                const approvedReadinessProofs = countApprovedReadinessProofActions(
                    result,
                    missionContract.requireBrowserProof ||
                        missionContract.requireBrowserOpenProof
                );
                const approvedBrowserProofs = countApprovedBrowserProofActions(result);
                const approvedBrowserOpenProofs = countApprovedBrowserOpenProofActions(result);
                const approvedProcessStopProofs = countApprovedManagedProcessStopActions(result);
                const missingBefore = resolveMissingMissionRequirements(missionContract, missionEvidence);
                missionEvidence = {
                    realSideEffects: missionEvidence.realSideEffects + approvedRealSideEffects,
                    targetPathTouches: missionEvidence.targetPathTouches + approvedTargetPathTouches,
                    artifactMutations: missionEvidence.artifactMutations + approvedArtifactMutations,
                    readinessProofs: missionEvidence.readinessProofs + approvedReadinessProofs,
                    browserProofs: missionEvidence.browserProofs + approvedBrowserProofs,
                    browserOpenProofs:
                        missionEvidence.browserOpenProofs + approvedBrowserOpenProofs,
                    processStopProofs:
                        missionEvidence.processStopProofs + approvedProcessStopProofs
                };
                trackedManagedProcessLeaseId = resolveTrackedManagedProcessLeaseId(
                    trackedManagedProcessLeaseId,
                    result
                );
                trackedManagedProcessStartContext = resolveTrackedManagedProcessStartContext(
                    trackedManagedProcessStartContext,
                    result
                );
                trackedLoopbackTarget = resolveTrackedLoopbackTarget(
                    trackedLoopbackTarget,
                    result
                );
                if (
                    missionContract.requireReadinessProof &&
                    trackedManagedProcessLeaseId &&
                    hasReadinessNotReadyFailure(result)
                ) {
                    if (readinessFailureLeaseId === trackedManagedProcessLeaseId) {
                        readinessFailureCount += 1;
                    } else {
                        readinessFailureLeaseId = trackedManagedProcessLeaseId;
                        readinessFailureCount = 1;
                    }
                } else if (
                    approvedReadinessProofs > 0 ||
                    !trackedManagedProcessLeaseId ||
                    findApprovedManagedProcessCheckResult(result)?.lifecycleStatus === "PROCESS_STOPPED"
                ) {
                    readinessFailureLeaseId = null;
                    readinessFailureCount = 0;
                }
                const missingAfter = resolveMissingMissionRequirements(missionContract, missionEvidence);
                const blocked = result.actionResults.filter(r => !r.approved).length;
                console.log(`\n[Iteration ${iteration} Completed] ${result.summary}`);
                await callbacks?.onIterationComplete?.(
                    iteration,
                    result.summary,
                    approved,
                    blocked,
                    result
                );

                if (signal?.aborted) {
                    const reason = "Cancelled by user.";
                    if (trackedManagedProcessLeaseId) {
                        await cleanupManagedProcessLease(
                            this.orchestrator,
                            currentOverarchingGoal,
                            trackedManagedProcessLeaseId
                        );
                        trackedManagedProcessLeaseId = null;
                    }
                    console.log(`\n[Autonomous Loop Cancelled] ${reason}\n`);
                    await callbacks?.onStateChange?.({
                        state: "stopped",
                        iteration,
                        message: humanizeAutonomousStopReason(reason)
                    });
                    await callbacks?.onGoalAborted?.(reason, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }

                if (hasMissionStopLimitReached(result)) {
                    const reason = formatReasonWithCode(
                        missionContract.executionStyle
                            ? EXECUTION_STYLE_STALL_REASON_CODE
                            : GENERIC_STALL_REASON_CODE,
                        "This run exhausted the mission retry budget before the remaining work could be completed."
                    );
                    await abortCurrentLoop(reason, iteration, true);
                    break;
                }

                if (
                    missionContract.requireReadinessProof &&
                    trackedManagedProcessLeaseId &&
                    readinessFailureLeaseId === trackedManagedProcessLeaseId &&
                    readinessFailureCount >= MAX_MANAGED_PROCESS_READINESS_FAILURES
                ) {
                    const reason = formatManagedProcessNeverReadyReason(
                        describeLoopbackTarget(trackedLoopbackTarget)
                    );
                    await abortCurrentLoop(reason, iteration, true);
                    break;
                }

                const liveVerificationAbortReason = resolveLiveVerificationBlockedAbortReason(
                    result,
                    missionContract,
                    missingAfter
                );
                if (liveVerificationAbortReason) {
                    await abortCurrentLoop(liveVerificationAbortReason, iteration, true);
                    break;
                }

                const liveRunEvidenceComplete =
                    missionContract.executionStyle &&
                    missingAfter.length === 0 &&
                    (
                        missionContract.requireReadinessProof ||
                        missionContract.requireBrowserProof ||
                        missionContract.requireBrowserOpenProof ||
                        missionContract.requireProcessStopProof
                    );
                if (liveRunEvidenceComplete) {
                    const reasoning = formatLiveRunCompletionReasoning(missionContract);
                    console.log(`\n======================================================`);
                    console.log(`[Autonomous Loop Finished] Goal Met!`);
                    console.log(`Reasoning: ${reasoning}`);
                    console.log(`======================================================\n`);
                    await callbacks?.onGoalMet?.(reasoning, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }

                const workspaceRecoverySignal = deriveWorkspaceRecoverySignal(result);
                if (workspaceRecoverySignal) {
                    if (
                        containsWorkspaceRecoveryPostInspectionRetryMarker(currentInput) &&
                        workspaceRecoverySignal.recommendedAction === "inspect_first"
                    ) {
                        const reason =
                            "Autonomous recovery stopped because I retried the move after inspection and it was still blocked, but I still could not prove a safe exact holder to shut down automatically.";
                        await abortCurrentLoop(reason, iteration, false);
                        break;
                    }
                    if (
                        workspaceRecoverySignal.recommendedAction === "clarify_before_exact_non_preview_shutdown" ||
                        workspaceRecoverySignal.recommendedAction === "clarify_before_likely_non_preview_shutdown" ||
                        workspaceRecoverySignal.recommendedAction === "clarify_before_untracked_shutdown" ||
                        workspaceRecoverySignal.recommendedAction === "stop_no_live_holders_found"
                    ) {
                        const reason = buildWorkspaceRecoveryAbortReason(workspaceRecoverySignal);
                        await abortCurrentLoop(reason, iteration, false);
                        break;
                    }

                    console.log(`\n[Recovery] ${workspaceRecoverySignal.reasoning}`);
                    await callbacks?.onStateChange?.({
                        state: "retrying",
                        iteration,
                        message: buildWorkspaceRecoveryStateMessage(workspaceRecoverySignal),
                        recoveryKind: "workspace_auto_recovery"
                    });
                    currentInput = buildWorkspaceRecoveryNextUserInput(
                        currentOverarchingGoal,
                        workspaceRecoverySignal
                    );
                    continue;
                }

                const inspectionOnlyWorkspaceRecoverySignal =
                    deriveWorkspaceRecoveryInspectionSignal(result);
                if (inspectionOnlyWorkspaceRecoverySignal) {
                    if (
                        inspectionOnlyWorkspaceRecoverySignal.recommendedAction === "clarify_before_exact_non_preview_shutdown" ||
                        inspectionOnlyWorkspaceRecoverySignal.recommendedAction === "clarify_before_likely_non_preview_shutdown" ||
                        inspectionOnlyWorkspaceRecoverySignal.recommendedAction === "clarify_before_untracked_shutdown" ||
                        inspectionOnlyWorkspaceRecoverySignal.recommendedAction === "stop_no_live_holders_found"
                    ) {
                        const reason = buildWorkspaceRecoveryAbortReason(
                            inspectionOnlyWorkspaceRecoverySignal
                        );
                        await abortCurrentLoop(reason, iteration, false);
                        break;
                    }
                    console.log(`\n[Recovery] ${inspectionOnlyWorkspaceRecoverySignal.reasoning}`);
                    await callbacks?.onStateChange?.({
                        state: "retrying",
                        iteration,
                        message: buildWorkspaceRecoveryStateMessage(
                            inspectionOnlyWorkspaceRecoverySignal
                        ),
                        recoveryKind: "workspace_auto_recovery"
                    });
                    currentInput =
                        inspectionOnlyWorkspaceRecoverySignal.recommendedAction ===
                        "retry_after_inspection"
                            ? buildWorkspaceRecoveryPostInspectionRetryInput(
                                currentOverarchingGoal
                            )
                            : buildWorkspaceRecoveryNextUserInput(
                                currentOverarchingGoal,
                                inspectionOnlyWorkspaceRecoverySignal
                            );
                    continue;
                }

                if (
                    containsWorkspaceRecoveryStopExactMarker(currentInput) &&
                    hasApprovedWorkspaceRecoveryStopProcessAction(result) &&
                    !hasApprovedWorkspaceRecoveryMoveAction(result)
                ) {
                    await callbacks?.onStateChange?.({
                        state: "retrying",
                        iteration,
                        message:
                            "I shut down the exact tracked holders that were blocking the move. I'm retrying the folder move now and will verify what changed.",
                        recoveryKind: "workspace_auto_recovery"
                    });
                    currentInput = buildWorkspaceRecoveryPostShutdownRetryInput(
                        currentOverarchingGoal
                    );
                    continue;
                }

                const structuredRecoveryDecision = resolveStructuredRecoveryRuntimeDecision({
                    overarchingGoal: currentOverarchingGoal,
                    missionContract,
                    missingRequirements: missingAfter,
                    result,
                    attemptCounts: structuredRecoveryAttemptCounts,
                    trackedManagedProcessLeaseId,
                    trackedManagedProcessStartContext,
                    trackedLoopbackTarget
                });
                if (structuredRecoveryDecision.outcome === "abort") {
                    await abortCurrentLoop(
                        structuredRecoveryDecision.reason,
                        iteration,
                        structuredRecoveryDecision.cleanupManagedProcess
                    );
                    break;
                }
                if (structuredRecoveryDecision.outcome === "retry") {
                    const previousAttempts =
                        structuredRecoveryAttemptCounts.get(
                            structuredRecoveryDecision.fingerprint
                        ) ?? 0;
                    structuredRecoveryAttemptCounts.set(
                        structuredRecoveryDecision.fingerprint,
                        previousAttempts + 1
                    );
                    console.log(`\n[Structured Recovery] ${structuredRecoveryDecision.reasoning}`);
                    await callbacks?.onStateChange?.({
                        state: "retrying",
                        iteration,
                        message: structuredRecoveryDecision.progressMessage,
                        recoveryKind: "structured_executor_recovery",
                        recoveryClass: structuredRecoveryDecision.recoveryClass,
                        recoveryFingerprint: structuredRecoveryDecision.fingerprint
                    });
                    currentInput = structuredRecoveryDecision.nextUserInput;
                    continue;
                }

                const madeProgress = missionContract.executionStyle
                    ? missingAfter.length < missingBefore.length
                    : approved > 0;
                if (!madeProgress) {
                    consecutiveZeroProgress++;
                } else {
                    consecutiveZeroProgress = 0;
                }

                if (consecutiveZeroProgress >= maxConsecutiveZeroProgressIterations) {
                    const blockCodes = result.actionResults
                        .filter(r => !r.approved && r.blockedBy)
                        .map(r => r.blockedBy)
                        .join(", ");
                    const reasonCode = missionContract.executionStyle
                        ? EXECUTION_STYLE_STALL_REASON_CODE
                        : GENERIC_STALL_REASON_CODE;
                    const missingRequirements = resolveMissingMissionRequirements(
                        missionContract,
                        missionEvidence
                    );
                    const reason = formatReasonWithCode(
                        reasonCode,
                        (
                            missionContract.executionStyle
                                ? `Stuck: ${consecutiveZeroProgress} consecutive iterations without reducing the remaining mission requirements. `
                                : `Stuck: ${consecutiveZeroProgress} consecutive iterations with 0 approved actions. `
                        ) +
                        `Missing requirement(s): ${missingRequirements.join(", ") || "none"}. ` +
                        `Block reason(s): ${blockCodes || "unknown"}. Stopping to avoid waste.`
                    );
                    if (trackedManagedProcessLeaseId) {
                        await cleanupManagedProcessLease(
                            this.orchestrator,
                            currentOverarchingGoal,
                            trackedManagedProcessLeaseId
                        );
                        trackedManagedProcessLeaseId = null;
                    }
                    console.log(`\n[Autonomous Loop Stuck] ${reason}\n`);
                    await callbacks?.onGoalAborted?.(reason, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }

                const nextStep = await evaluateAutonomousNextStepPolicy(
                    this.modelClient,
                    this.config,
                    currentOverarchingGoal,
                    result,
                    missionEvidence,
                    trackedManagedProcessLeaseId,
                    trackedManagedProcessStartContext,
                    trackedLoopbackTarget
                );
                const missingRequirements = resolveMissingMissionRequirements(
                    missionContract,
                    missionEvidence
                );
                const completionGateBlocked =
                    missionContract.executionStyle &&
                    nextStep.isGoalMet &&
                    missingRequirements.length > 0;

                if (completionGateBlocked) {
                    const primaryMissingRequirement =
                        missingRequirements[0] ?? MISSION_REQUIREMENT_SIDE_EFFECT;
                    const gateReason = formatReasonWithCode(
                        mapRequirementToReasonCode(primaryMissingRequirement),
                        `Goal completion deferred: missing mission requirement(s) ${missingRequirements.join(
                            ", "
                        )}.`
                    );
                    console.log(`\n[Evaluation] Goal completion deferred by deterministic execution gate.`);
                    console.log(`Reasoning: ${gateReason}`);
                    await callbacks?.onStateChange?.({
                        state: "verifying",
                        iteration,
                        message: buildVerificationStateMessage(missingRequirements)
                    });
                    currentInput =
                        primaryMissingRequirement === MISSION_REQUIREMENT_PROCESS_STOP &&
                        trackedManagedProcessLeaseId
                            ? buildManagedProcessStopRetryInput(trackedManagedProcessLeaseId)
                            : nextStep.nextUserInput && nextStep.nextUserInput.trim().length > 0
                                ? nextStep.nextUserInput
                                : buildMissionEvidenceRetryInput(
                                    currentOverarchingGoal,
                                    missingRequirements,
                                    missionContract.targetPathHints,
                                    missionContract.requireBrowserProof ||
                                        missionContract.requireBrowserOpenProof
                                );
                    continue;
                }

                if (nextStep.isGoalMet) {
                    console.log(`\n======================================================`);
                    console.log(`[Autonomous Loop Finished] Goal Met!`);
                    console.log(`Reasoning: ${nextStep.reasoning}`);
                    console.log(`======================================================\n`);
                    await callbacks?.onStateChange?.({
                        state: "completed",
                        iteration,
                        message: nextStep.reasoning
                    });
                    await callbacks?.onGoalMet?.(nextStep.reasoning, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }

                const userTurnGateReason = buildAutonomousUserTurnGateReason(
                    nextStep.reasoning,
                    nextStep.nextUserInput ?? ""
                );
                if (userTurnGateReason) {
                    await abortCurrentLoop(userTurnGateReason, iteration, false);
                    break;
                }

                if (!nextStep.nextUserInput || nextStep.nextUserInput.trim() === "") {
                    const reason = formatReasonWithCode(
                        EMPTY_NEXT_STEP_REASON_CODE,
                        "Output was empty or invalid. Human intervention may be needed."
                    );
                    await abortCurrentLoop(reason, iteration, true);
                    break;
                }

                console.log(`\n[Evaluation] Goal not met yet. Scheduling next sub-task...`);
                console.log(`Reasoning: ${nextStep.reasoning}`);
                await callbacks?.onStateChange?.({
                    state: "retrying",
                    iteration,
                    message: buildRetryingStateMessage(
                        nextStep.reasoning,
                        currentInput
                    )
                });
                currentInput = nextStep.nextUserInput;
            }

            if (!goalMetInCurrentLoop) {
                const missingRequirements = resolveMissingMissionRequirements(
                    missionContract,
                    missionEvidence
                );
                if (
                    missionContract.requireProcessStopProof &&
                    trackedManagedProcessLeaseId &&
                    missingRequirements.length === 1 &&
                    missingRequirements[0] === MISSION_REQUIREMENT_PROCESS_STOP
                ) {
                    const cleanupResult = await cleanupManagedProcessLease(
                        this.orchestrator,
                        currentOverarchingGoal,
                        trackedManagedProcessLeaseId
                    );
                    if (cleanupResult) {
                        missionEvidence = {
                            ...missionEvidence,
                            processStopProofs:
                                missionEvidence.processStopProofs +
                                countApprovedManagedProcessStopActions(cleanupResult)
                        };
                        trackedManagedProcessLeaseId = resolveTrackedManagedProcessLeaseId(
                            trackedManagedProcessLeaseId,
                            cleanupResult
                        );
                        trackedManagedProcessStartContext = resolveTrackedManagedProcessStartContext(
                            trackedManagedProcessStartContext,
                            cleanupResult
                        );
                        if (
                            resolveMissingMissionRequirements(
                                missionContract,
                                missionEvidence
                            ).length === 0
                        ) {
                            const reasoning = formatLiveRunCompletionReasoning(missionContract);
                            console.log(`\n======================================================`);
                            console.log(`[Autonomous Loop Finished] Goal Met!`);
                            console.log(`Reasoning: ${reasoning}`);
                            console.log(`======================================================\n`);
                            await callbacks?.onStateChange?.({
                                state: "completed",
                                iteration,
                                message: reasoning
                            });
                            await callbacks?.onGoalMet?.(reasoning, iteration);
                            goalMetInCurrentLoop = true;
                        }
                    }
                }
            }

            if (!goalMetInCurrentLoop) {
                const reason = formatReasonWithCode(
                    MAX_ITERATIONS_REASON_CODE,
                    `Reached maximum iterations (${maxIterations}) for goal.`
                );
                if (trackedManagedProcessLeaseId) {
                    await cleanupManagedProcessLease(
                        this.orchestrator,
                        currentOverarchingGoal,
                        trackedManagedProcessLeaseId
                    );
                    trackedManagedProcessLeaseId = null;
                }
                console.log(`\n[Autonomous Loop Terminated] ${reason}\n`);
                await callbacks?.onStateChange?.({
                    state: "stopped",
                    iteration,
                    message: humanizeAutonomousStopReason(reason)
                });
                await callbacks?.onGoalAborted?.(reason, iteration);
            }

            if (!this.config.runtime.isDaemonMode) {
                return;
            }

            if (
                typeof daemonGoalRolloverLimit === "number" &&
                daemonGoalRolloverLimit > 0 &&
                daemonGoalRollovers >= daemonGoalRolloverLimit
            ) {
                console.log(
                    `\n[Daemon Mode] Reached rollover limit (${daemonGoalRolloverLimit}). Stopping.\n`
                );
                return;
            }

            console.log(`\n[Daemon Mode] Generating new proactive goal to run 24/7...\n`);
            try {
                const nextGoalResult = await evaluateProactiveAutonomousGoalPolicy(
                    this.modelClient,
                    this.config,
                    currentOverarchingGoal
                );
                currentOverarchingGoal = nextGoalResult.proactiveGoal;
                currentLoopInitialInput = null;
                daemonGoalRollovers += 1;
                console.log(`[Daemon Mode] Next Proactive Goal: ${currentOverarchingGoal}`);
                console.log(`[Daemon Mode] Reasoning: ${nextGoalResult.reasoning}`);
            } catch (error) {
                console.error(`[Daemon Mode] Error generating proactive goal. Retrying in 5 seconds...`, error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

}
