/**
 * @fileoverview Manages the continuous autonomous execution loop for resolving complex goals without user input.
 */

import { BrainOrchestrator } from "./orchestrator";
import { MAIN_AGENT_ID } from "./agentIdentity";
import { makeId } from "./ids";
import { isAbortError } from "./runtimeAbort";
import { TaskRequest, TaskRunResult } from "./types";
import {
    AutonomousNextStepModelOutput,
    ModelClient,
    ProactiveGoalModelOutput
} from "../models/types";
import { selectModelForRole } from "./modelRouting";
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
    buildManagedProcessCheckRecoveryInput,
    buildManagedProcessPortConflictRecoveryInput,
    buildManagedProcessStillRunningRetryInput,
    buildManagedProcessStoppedRecoveryInput,
    describeLoopbackTarget,
    findManagedProcessStartPortConflictFailure,
    goalExplicitlyRequiresLoopbackPort,
    hasReadinessNotReadyFailure,
    resolveTrackedLoopbackTarget,
    type LoopbackTargetHint
} from "./autonomy/liveRunRecovery";
import {
    cleanupManagedProcessLease,
    findApprovedManagedProcessCheckResult,
    findApprovedManagedProcessStartLeaseId,
    resolveTrackedManagedProcessLeaseId
} from "./autonomy/loopCleanupPolicy";

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

/**
 * Normalizes text for deterministic case-insensitive evidence checks.
 *
 * **Why it exists:**
 * Keeps lexical evidence matching stable across Windows/macOS/Linux path and command text shapes.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Source text to normalize.
 * @returns Lower-cased normalized text.
 */
function normalizeEvidenceText(input: string): string {
    return input.trim().toLowerCase();
}


/**
 * Detects whether a task result contains a specific execution failure code.
 *
 * **Why it exists:**
 * Keeps deterministic recovery routing grounded in typed runtime failure codes instead of brittle
 * free-text matching spread across the autonomous loop.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @param failureCode - Typed execution failure code to detect.
 * @returns `true` when the result contains the requested failure code.
 */
function hasExecutionFailureCode(result: TaskRunResult, failureCode: string): boolean {
    return result.actionResults.some((entry) =>
        !entry.approved &&
        (
            entry.executionFailureCode === failureCode ||
            entry.blockedBy.some((blockCode) => blockCode === failureCode)
        )
    );
}

/**
 * Detects whether the current subtask already attempted a local Playwright install.
 *
 * **Why it exists:**
 * Prevents the autonomous loop from reissuing the same dependency-install instruction when the
 * current subtask is already the explicit runtime-recovery attempt.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param input - Current subtask instruction text.
 * @returns `true` when the instruction is already a Playwright install recovery attempt.
 */
function isPlaywrightInstallRecoveryInput(input: string): boolean {
    const normalized = normalizeEvidenceText(input);
    return (
        normalized.includes("npm install --no-save playwright") ||
        normalized.includes("npx playwright install chromium") ||
        /\binstall playwright\b/.test(normalized)
    );
}

/**
 * Builds a deterministic recovery instruction for missing local Playwright runtime support.
 *
 * **Why it exists:**
 * Explicit browser-proof goals should try the smallest truthful local dependency-install recovery
 * path before giving up, rather than bouncing between generic blocked explanations.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param overarchingGoal - Mission-level goal text.
 * @returns Explicit recovery subtask instruction.
 */
function buildPlaywrightInstallRecoveryInput(overarchingGoal: string): string {
    return (
        "Browser verification is unavailable because the local Playwright runtime is missing or " +
        "missing browser binaries. Install Playwright locally with finite shell steps if policy " +
        "allows: run `npm install --no-save playwright` and then `npx playwright install chromium`. " +
        `After install, continue this original goal and retry the localhost browser verification: "${overarchingGoal}". ` +
        "If install is blocked or fails, stop and explain plainly that browser verification could not be completed."
    );
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
     * Evaluates next step and returns a deterministic policy signal.
     *
     * **Why it exists:**
     * Keeps the next step policy check explicit and testable before side effects.
     *
     * **What it talks to:**
     * - Uses `AutonomousNextStepModelOutput` (import `AutonomousNextStepModelOutput`) from `../models/types`.
     * - Uses `selectModelForRole` (import `selectModelForRole`) from `./modelRouting`.
     * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
     *
     * @param overarchingGoal - Value for overarching goal.
     * @param lastResult - Result object inspected or transformed in this step.
     * @param trackedManagedProcessLeaseId - Managed-process lease carried across iterations, if any.
     * @param trackedLoopbackTarget - Loopback target carried across iterations, if any.
     * @returns Promise resolving to AutonomousNextStepModelOutput.
     */
    private async evaluateNextStep(
        overarchingGoal: string,
        lastResult: TaskRunResult,
        trackedManagedProcessLeaseId: string | null,
        trackedLoopbackTarget: LoopbackTargetHint | null
    ): Promise<AutonomousNextStepModelOutput> {
        const missionContract = buildMissionCompletionContract(overarchingGoal);
        const startPortConflict = findManagedProcessStartPortConflictFailure(lastResult);
        if (missionContract.requireReadinessProof && startPortConflict) {
            if (
                startPortConflict.suggestedPort !== null &&
                !goalExplicitlyRequiresLoopbackPort(
                    overarchingGoal,
                    startPortConflict.requestedPort
                )
            ) {
                return {
                    isGoalMet: false,
                    reasoning:
                        `The requested localhost port ${startPortConflict.requestedPort} was already occupied, ` +
                        "so the local server needs a different free port before readiness or browser proof can continue.",
                    nextUserInput: buildManagedProcessPortConflictRecoveryInput(
                        startPortConflict,
                        missionContract.requireBrowserProof
                    )
                };
            }
        }
        const startedManagedProcessLeaseId = findApprovedManagedProcessStartLeaseId(lastResult);
        const checkedManagedProcess = findApprovedManagedProcessCheckResult(lastResult);
        const activeManagedProcessLeaseId =
            startedManagedProcessLeaseId ??
            checkedManagedProcess?.leaseId ??
            trackedManagedProcessLeaseId;
        if (
            missionContract.requireReadinessProof &&
            activeManagedProcessLeaseId &&
            hasReadinessNotReadyFailure(lastResult)
        ) {
            return {
                isGoalMet: false,
                reasoning:
                    "The local process started, but localhost readiness was not proven yet.",
                nextUserInput: buildManagedProcessCheckRecoveryInput(
                    activeManagedProcessLeaseId,
                    trackedLoopbackTarget,
                    missionContract.requireBrowserProof
                )
            };
        }

        if (
            missionContract.requireReadinessProof &&
            checkedManagedProcess?.lifecycleStatus === "PROCESS_STILL_RUNNING" &&
            countApprovedReadinessProofActions(
                lastResult,
                missionContract.requireBrowserProof
            ) === 0
        ) {
            return {
                isGoalMet: false,
                reasoning:
                    "The managed process is still running, so the next step is to retry localhost readiness proof.",
                nextUserInput: buildManagedProcessStillRunningRetryInput(
                    checkedManagedProcess.leaseId,
                    missionContract.requireBrowserProof,
                    trackedLoopbackTarget
                )
            };
        }

        if (
            missionContract.requireReadinessProof &&
            checkedManagedProcess?.lifecycleStatus === "PROCESS_STOPPED" &&
            countApprovedReadinessProofActions(
                lastResult,
                missionContract.requireBrowserProof
            ) === 0
        ) {
            return {
                isGoalMet: false,
                reasoning:
                    "The managed process stopped before localhost readiness was proven.",
                nextUserInput: buildManagedProcessStoppedRecoveryInput(
                    checkedManagedProcess.leaseId
                )
            };
        }

        if (
            missionContract.requireBrowserProof &&
            hasExecutionFailureCode(lastResult, "BROWSER_VERIFY_RUNTIME_UNAVAILABLE") &&
            !isPlaywrightInstallRecoveryInput(lastResult.task.userInput)
        ) {
            return {
                isGoalMet: false,
                reasoning:
                    "Browser verification is still unavailable because the local Playwright runtime is not ready yet.",
                nextUserInput: buildPlaywrightInstallRecoveryInput(overarchingGoal)
            };
        }

        const model = selectModelForRole("planner", this.config);

        try {
            const systemPrompt =
                "You are the manager of an autonomous agent loop. Analyze the last task's result against the overarching goal. " +
                "Decide if the goal is completely met. If not, formulate the exact next instruction (userInput) the agent needs to perform. " +
                "Return JSON with 'isGoalMet' (boolean), 'reasoning' (string), and 'nextUserInput' (string)." +
                (
                    missionContract.requireReadinessProof || missionContract.requireBrowserProof
                        ? " For explicit localhost/live/browser verification goals, keep next steps inside governed proof actions. " +
                        "Do not ask the user to manually open a browser or manually inspect localhost during the autonomous loop. " +
                        "Do not replace verify_browser with shell-based Playwright commands such as npx playwright --version, npx playwright open, or npx playwright test. " +
                        "If live proof steps are blocked or unavailable, say so plainly instead of inventing manual or shell-based fallback checks."
                        : ""
                );
            const output = await this.modelClient.completeJson<AutonomousNextStepModelOutput>({
                model,
                schemaName: "autonomous_next_step_v1",
                temperature: 0.1,
                systemPrompt,
                userPrompt: JSON.stringify({
                    overarchingGoal,
                    lastTaskInput: lastResult.task.userInput,
                    lastTaskSummary: lastResult.summary,
                    actionResults: lastResult.actionResults.map(r => ({
                        type: r.action.type,
                        description: r.action.description,
                        approved: r.approved,
                        output: r.output,
                        blockedBy: r.blockedBy
                    }))
                })
            });
            return output;
        } catch (error) {
            // Provide a graceful fallback to stop the loop instead of crashing hard
            return {
                isGoalMet: true,
                reasoning: "Failed to evaluate next step via model. Terminating to prevent out-of-control loops. Error: " + (error as Error).message,
                nextUserInput: ""
            };
        }
    }

    /**
     * Evaluates proactive goal and returns a deterministic policy signal.
     *
     * **Why it exists:**
     * Keeps the proactive goal policy check explicit and testable before side effects.
     *
     * **What it talks to:**
     * - Uses `ProactiveGoalModelOutput` (import `ProactiveGoalModelOutput`) from `../models/types`.
     * - Uses `selectModelForRole` (import `selectModelForRole`) from `./modelRouting`.
     *
     * @param previousGoal - Value for previous goal.
     * @returns Promise resolving to ProactiveGoalModelOutput.
     */
    private async evaluateProactiveGoal(previousGoal: string): Promise<ProactiveGoalModelOutput> {
        const model = selectModelForRole("planner", this.config);

        try {
            return await this.modelClient.completeJson<ProactiveGoalModelOutput>({
                model,
                schemaName: "proactive_goal_v1",
                temperature: 0.8,
                systemPrompt: "You are a 24/7 autonomous agent daemon. Your previous goal was just completed. Generate a logical, productive new overarching goal for yourself to work on next. It should be independent and self-contained. Return JSON with 'proactiveGoal' (string) and 'reasoning' (string).",
                userPrompt: JSON.stringify({ previousGoal })
            });
        } catch (error) {
            return {
                proactiveGoal: "Sleep and idle",
                reasoning: "Fallback proactive goal due to an error: " + (error as Error).message
            };
        }
    }
}
