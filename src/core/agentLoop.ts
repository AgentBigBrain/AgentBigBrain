/**
 * @fileoverview Manages the continuous autonomous execution loop for resolving complex goals without user input.
 */

import { BrainOrchestrator } from "./orchestrator";
import { MAIN_AGENT_ID } from "./agentIdentity";
import { makeId } from "./ids";
import { isAbortError } from "./runtimeAbort";
import { TaskRequest, TaskRunResult } from "./types";
import { ModelClient } from "../models/types";
import { BrainConfig } from "./config";
import { humanizeAutonomousStopReason } from "./autonomy/stopReasonText";
import {
    EMPTY_NEXT_STEP_REASON_CODE,
    EXECUTION_STYLE_STALL_REASON_CODE,
    GENERIC_STALL_REASON_CODE,
    MAX_ITERATIONS_REASON_CODE,
    MAX_MANAGED_PROCESS_READINESS_FAILURES,
    MISSION_REQUIREMENT_PROCESS_STOP,
    MISSION_REQUIREMENT_SIDE_EFFECT,
    TASK_EXECUTION_FAILED_REASON_CODE,
    formatReasonWithCode,
    type MissionEvidenceCounters
} from "./autonomy/contracts";
import { buildMissionCompletionContract } from "./autonomy/missionContract";
import {
    buildManagedProcessStopRetryInput,
    buildMissionEvidenceRetryInput,
    countApprovedArtifactMutationActions,
    countApprovedBrowserProofActions,
    countApprovedManagedProcessStopActions,
    countApprovedReadinessProofActions,
    countApprovedRealSideEffectActions,
    countApprovedTargetPathTouchActions,
    mapRequirementToReasonCode,
    resolveMissingMissionRequirements
} from "./autonomy/missionEvidence";
import {
    formatManagedProcessNeverReadyReason,
    resolveLiveVerificationBlockedAbortReason
} from "./autonomy/completionGate";
import {
    describeLoopbackTarget,
    hasReadinessNotReadyFailure,
    resolveTrackedLoopbackTarget,
    type LoopbackTargetHint
} from "./autonomy/liveRunRecovery";
import {
    cleanupManagedProcessLease,
    findApprovedManagedProcessCheckResult,
    resolveTrackedManagedProcessLeaseId
} from "./autonomy/loopCleanupPolicy";
import {
    evaluateAutonomousNextStep,
    evaluateProactiveAutonomousGoal,
    formatLiveRunCompletionReasoning
} from "./autonomy/agentLoopModelPolicy";

/**
 * Optional callbacks for observing autonomous loop progress.
 * Used by interface adapters (Telegram, Discord) to deliver per-iteration updates.
 */
export interface AutonomousLoopCallbacks {
    onIterationStart?: (iteration: number, input: string) => Promise<void> | void;
    onIterationComplete?: (iteration: number, summary: string, approved: number, blocked: number) => Promise<void> | void;
    onGoalMet?: (reasoning: string, totalIterations: number) => Promise<void> | void;
    onGoalAborted?: (reason: string, totalIterations: number) => Promise<void> | void;
}

export class AutonomousLoop {
    /**
     * Initializes `AutonomousLoop` with deterministic runtime dependencies.
     *
     * **Why it exists:**
     * Captures required dependencies at initialization time so runtime behavior remains explicit.
     *
     * **What it talks to:**
     * - Uses `ModelClient` (import `ModelClient`) from `../models/types`.
     * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
     * - Uses `BrainOrchestrator` (import `BrainOrchestrator`) from `./orchestrator`.
     *
     * @param orchestrator - Value for orchestrator.
     * @param modelClient - Value for model client.
     * @param config - Configuration or policy settings applied here.
     */
    constructor(
        private readonly orchestrator: BrainOrchestrator,
        private readonly modelClient: ModelClient,
        private readonly config: BrainConfig
    ) { }

    /**
     * Runs the autonomous goal-resolution loop with optional progress callbacks.
     * Each iteration plans, governs, and executes a subtask, then evaluates whether the goal is met.
     * Pass an {@link AbortSignal} to allow external cancellation (e.g. user "stop" command).
     * In daemon mode, an optional rollover limit can bound how many proactive goal hand-offs occur
     * before the loop exits.
     */
    async run(
        overarchingGoal: string,
        callbacks?: AutonomousLoopCallbacks,
        signal?: AbortSignal,
        daemonGoalRolloverLimit?: number
    ): Promise<void> {
        let currentOverarchingGoal = overarchingGoal;
        let daemonGoalRollovers = 0;

        /* eslint-disable no-constant-condition */
        while (true) {
            console.log(`\n======================================================`);
            console.log(`[Autonomous Loop Started] Goal: "${currentOverarchingGoal}"`);
            console.log(`======================================================\n`);

            let currentInput = currentOverarchingGoal;
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
                processStopProofs: 0
            };
            let trackedManagedProcessLeaseId: string | null = null;
            let trackedLoopbackTarget: LoopbackTargetHint | null = null;
            let readinessFailureLeaseId: string | null = null;
            let readinessFailureCount = 0;

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
                    missionContract.requireBrowserProof
                );
                const approvedBrowserProofs = countApprovedBrowserProofActions(result);
                const approvedProcessStopProofs = countApprovedManagedProcessStopActions(result);
                const missingBefore = resolveMissingMissionRequirements(missionContract, missionEvidence);
                missionEvidence = {
                    realSideEffects: missionEvidence.realSideEffects + approvedRealSideEffects,
                    targetPathTouches: missionEvidence.targetPathTouches + approvedTargetPathTouches,
                    artifactMutations: missionEvidence.artifactMutations + approvedArtifactMutations,
                    readinessProofs: missionEvidence.readinessProofs + approvedReadinessProofs,
                    browserProofs: missionEvidence.browserProofs + approvedBrowserProofs,
                    processStopProofs:
                        missionEvidence.processStopProofs + approvedProcessStopProofs
                };
                trackedManagedProcessLeaseId = resolveTrackedManagedProcessLeaseId(
                    trackedManagedProcessLeaseId,
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
                await callbacks?.onIterationComplete?.(iteration, result.summary, approved, blocked);

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

                const nextStep = await this.evaluateNextStep(
                    currentOverarchingGoal,
                    result,
                    missionEvidence,
                    trackedManagedProcessLeaseId,
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
                                    missionContract.requireBrowserProof
                                );
                    continue;
                }

                if (nextStep.isGoalMet) {
                    console.log(`\n======================================================`);
                    console.log(`[Autonomous Loop Finished] Goal Met!`);
                    console.log(`Reasoning: ${nextStep.reasoning}`);
                    console.log(`======================================================\n`);
                    await callbacks?.onGoalMet?.(nextStep.reasoning, iteration);
                    goalMetInCurrentLoop = true;
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
                const nextGoalResult = await this.evaluateProactiveGoal(currentOverarchingGoal);
                currentOverarchingGoal = nextGoalResult.proactiveGoal;
                daemonGoalRollovers += 1;
                console.log(`[Daemon Mode] Next Proactive Goal: ${currentOverarchingGoal}`);
                console.log(`[Daemon Mode] Reasoning: ${nextGoalResult.reasoning}`);
            } catch (error) {
                console.error(`[Daemon Mode] Error generating proactive goal. Retrying in 5 seconds...`, error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    /**
     * Delegates autonomous next-step evaluation to the extracted autonomy policy helper.
     *
     * **Why it exists:**
     * Runtime code and tests still depend on a stable `AutonomousLoop` method surface even though
     * the underlying model-policy logic now lives in the autonomy subsystem.
     *
     * **What it talks to:**
     * - Uses `evaluateAutonomousNextStep` (import `evaluateAutonomousNextStep`) from
     *   `./autonomy/agentLoopModelPolicy`.
     *
     * @param overarchingGoal - Current mission goal text.
     * @param lastResult - Latest task result from the autonomous loop.
     * @param missionEvidence - Cumulative deterministic mission evidence so far.
     * @param trackedManagedProcessLeaseId - Tracked managed-process lease, if any.
     * @param trackedLoopbackTarget - Tracked loopback target, if any.
     * @returns Promise resolving to the next-step policy decision.
     */
    private async evaluateNextStep(
        overarchingGoal: string,
        lastResult: TaskRunResult,
        missionEvidence: MissionEvidenceCounters,
        trackedManagedProcessLeaseId: string | null,
        trackedLoopbackTarget: LoopbackTargetHint | null
    ) {
        return await evaluateAutonomousNextStep(
            this.modelClient,
            this.config,
            overarchingGoal,
            lastResult,
            missionEvidence,
            trackedManagedProcessLeaseId,
            trackedLoopbackTarget
        );
    }

    /**
     * Delegates proactive-goal generation to the extracted autonomy policy helper.
     *
     * **Why it exists:**
     * Daemon-mode orchestration still expects a method on `AutonomousLoop`, while the actual model
     * prompt and fallback logic now live in the autonomy subsystem.
     *
     * **What it talks to:**
     * - Uses `evaluateProactiveAutonomousGoal` (import `evaluateProactiveAutonomousGoal`) from
     *   `./autonomy/agentLoopModelPolicy`.
     *
     * @param previousGoal - Goal that just completed.
     * @returns Promise resolving to the next proactive goal decision.
     */
    private async evaluateProactiveGoal(previousGoal: string) {
        return await evaluateProactiveAutonomousGoal(
            this.modelClient,
            this.config,
            previousGoal
        );
    }
}
