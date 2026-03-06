/**
 * @fileoverview Manages the continuous autonomous execution loop for resolving complex goals without user input.
 */

import { BrainOrchestrator } from "./orchestrator";
import { MAIN_AGENT_ID } from "./agentIdentity";
import { makeId } from "./ids";
import { TaskRequest, TaskRunResult } from "./types";
import {
    AutonomousNextStepModelOutput,
    ModelClient,
    ProactiveGoalModelOutput
} from "../models/types";
import { selectModelForRole } from "./modelRouting";
import { BrainConfig } from "./config";
import {
    classifyRoutingIntentV1,
    isExecutionSurfaceRoutingClassification
} from "../interfaces/routingMap";

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
 * Maximum number of consecutive iterations that produce zero approved actions
 * before the loop aborts.  Prevents burning through iterations when a
 * systematic block (governance, constraint, schema) is in effect.
 */
const MAX_CONSECUTIVE_ZERO_PROGRESS = 3;
const EXECUTION_STYLE_GOAL_GATING_REASON_CODE = "AUTONOMOUS_EXECUTION_STYLE_SIDE_EFFECT_REQUIRED";
const EXECUTION_STYLE_STALL_REASON_CODE = "AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT";
const GENERIC_STALL_REASON_CODE = "AUTONOMOUS_STALLED_ZERO_PROGRESS";
const MAX_ITERATIONS_REASON_CODE = "AUTONOMOUS_MAX_ITERATIONS_REACHED";
const EMPTY_NEXT_STEP_REASON_CODE = "AUTONOMOUS_NEXT_STEP_EMPTY";

/**
 * Formats reason text with deterministic reason-code metadata.
 *
 * @param reasonCode - Stable reason code for machine-readable diagnostics.
 * @param message - Human-readable reason detail.
 * @returns Reason string with deterministic reason-code prefix.
 */
function formatReasonWithCode(reasonCode: string, message: string): string {
    return `[reasonCode=${reasonCode}] ${message}`;
}

/**
 * Evaluates execution-style mission intent and returns a deterministic policy signal.
 *
 * @param input - Goal or subtask request text.
 * @returns `true` when this text indicates side-effect execution intent.
 */
function isExecutionStyleInput(input: string): boolean {
    const normalized = input.trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    if (
        /\b(guidance\s+only|instructions?\s+only|without\s+executing|do\s+not\s+execute|don't\s+execute|explain\s+how)\b/.test(
            normalized
        )
    ) {
        return false;
    }

    if (isExecutionSurfaceRoutingClassification(classifyRoutingIntentV1(input))) {
        return true;
    }

    const executionVerb = /\b(create|build|scaffold|generate|write|delete|modify|run|execute|install|deploy|open|launch)\b/;
    if (!executionVerb.test(normalized)) {
        return false;
    }

    const sideEffectTarget =
        /\b(app|application|project|dashboard|site|website|frontend|backend|api|file|folder|directory|repo|repository|script|command|powershell|terminal|bash|zsh|cmd)\b/;
    const explicitPath = /([a-z]:\\|\/|\\)/i;
    return sideEffectTarget.test(normalized) || explicitPath.test(normalized);
}

/**
 * Evaluates side-effect action type and returns a deterministic policy signal.
 *
 * @param actionType - Planned action type.
 * @returns `true` when this action type counts as side-effect execution evidence.
 */
function isExecutionEvidenceActionType(
    actionType: TaskRunResult["actionResults"][number]["action"]["type"]
): boolean {
    return actionType !== "respond" && actionType !== "read_file" && actionType !== "list_directory";
}

/**
 * Evaluates execution output and metadata for simulation markers.
 *
 * @param output - Execution output text.
 * @param executionMetadata - Optional typed execution metadata.
 * @returns `true` when the execution result is simulated and should not count as real evidence.
 */
function isSimulatedExecutionEvidence(
    output: string | undefined,
    executionMetadata: TaskRunResult["actionResults"][number]["executionMetadata"]
): boolean {
    if (executionMetadata?.simulatedExecution === true) {
        return true;
    }
    const normalizedOutput = (output ?? "").trim().toLowerCase();
    if (!normalizedOutput) {
        return false;
    }
    return /\bsimulated\b/.test(normalizedOutput);
}

/**
 * Counts approved real side-effect actions in one task result.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Number of approved side-effect actions that represent real execution evidence.
 */
function countApprovedRealSideEffectActions(result: TaskRunResult): number {
    return result.actionResults.filter((entry) => {
        if (!entry.approved) {
            return false;
        }
        if (!isExecutionEvidenceActionType(entry.action.type)) {
            return false;
        }
        return !isSimulatedExecutionEvidence(entry.output, entry.executionMetadata);
    }).length;
}

/**
 * Builds fallback retry input for execution-style completion gating.
 *
 * @param overarchingGoal - Mission-level goal text for context continuity.
 * @returns Deterministic retry instruction text.
 */
function buildExecutionStyleRetryInput(overarchingGoal: string): string {
    return `Execution evidence is required before marking this mission complete. For goal "${overarchingGoal}", execute at least one real side-effect action now (read/list/simulated outputs do not satisfy this gate). If blocked, stop and report exact block codes and required user approval.`;
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
            const unlimited = maxIterations <= 0;
            let consecutiveZeroProgress = 0;
            let hasApprovedRealSideEffectInMission = false;
            let isExecutionStyleMission = isExecutionStyleInput(currentOverarchingGoal);

            let goalMetInCurrentLoop = false;

            while (unlimited || iteration < maxIterations) {
                if (signal?.aborted) {
                    const reason = "Cancelled by user.";
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

                const result = await this.orchestrator.runTask(task);
                const approved = result.actionResults.filter(r => r.approved).length;
                const approvedRealSideEffects = countApprovedRealSideEffectActions(result);
                if (approvedRealSideEffects > 0) {
                    hasApprovedRealSideEffectInMission = true;
                }
                if (!isExecutionStyleMission && isExecutionStyleInput(currentInput)) {
                    isExecutionStyleMission = true;
                }

                const blocked = result.actionResults.filter(r => !r.approved).length;
                console.log(`\n[Iteration ${iteration} Completed] ${result.summary}`);
                await callbacks?.onIterationComplete?.(iteration, result.summary, approved, blocked);

                const madeProgress = isExecutionStyleMission ? approvedRealSideEffects > 0 : approved > 0;
                if (!madeProgress) {
                    consecutiveZeroProgress++;
                } else {
                    consecutiveZeroProgress = 0;
                }

                if (consecutiveZeroProgress >= MAX_CONSECUTIVE_ZERO_PROGRESS) {
                    const blockCodes = result.actionResults
                        .filter(r => !r.approved && r.blockedBy)
                        .map(r => r.blockedBy)
                        .join(", ");
                    const reasonCode = isExecutionStyleMission
                        ? EXECUTION_STYLE_STALL_REASON_CODE
                        : GENERIC_STALL_REASON_CODE;
                    const progressLabel = isExecutionStyleMission
                        ? "approved real side-effect actions"
                        : "approved actions";
                    const reason = formatReasonWithCode(
                        reasonCode,
                        `Stuck: ${consecutiveZeroProgress} consecutive iterations with 0 ${progressLabel}. ` +
                        `Block reason(s): ${blockCodes || "unknown"}. Stopping to avoid waste.`
                    );
                    console.log(`\n[Autonomous Loop Stuck] ${reason}\n`);
                    await callbacks?.onGoalAborted?.(reason, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }

                const nextStep = await this.evaluateNextStep(currentOverarchingGoal, result);
                const completionGateBlocked =
                    isExecutionStyleMission &&
                    nextStep.isGoalMet &&
                    !hasApprovedRealSideEffectInMission;

                if (completionGateBlocked) {
                    const gateReason = formatReasonWithCode(
                        EXECUTION_STYLE_GOAL_GATING_REASON_CODE,
                        "Goal completion deferred: execution-style mission has no approved real side-effect action in this autonomous run."
                    );
                    console.log(`\n[Evaluation] Goal completion deferred by deterministic execution gate.`);
                    console.log(`Reasoning: ${gateReason}`);
                    currentInput =
                        nextStep.nextUserInput && nextStep.nextUserInput.trim().length > 0
                            ? nextStep.nextUserInput
                            : buildExecutionStyleRetryInput(currentOverarchingGoal);
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
                    console.log(`\n[Autonomous Loop Aborted] ${reason}\n`);
                    await callbacks?.onGoalAborted?.(reason, iteration);
                    goalMetInCurrentLoop = true;
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
     * @returns Promise resolving to AutonomousNextStepModelOutput.
     */
    private async evaluateNextStep(
        overarchingGoal: string,
        lastResult: TaskRunResult
    ): Promise<AutonomousNextStepModelOutput> {
        const model = selectModelForRole("planner", this.config);

        try {
            const output = await this.modelClient.completeJson<AutonomousNextStepModelOutput>({
                model,
                schemaName: "autonomous_next_step_v1",
                temperature: 0.1,
                systemPrompt: "You are the manager of an autonomous agent loop. Analyze the last task's result against the overarching goal. Decide if the goal is completely met. If not, formulate the exact next instruction (userInput) the agent needs to perform. Return JSON with 'isGoalMet' (boolean), 'reasoning' (string), and 'nextUserInput' (string).",
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
