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
                const blocked = result.actionResults.filter(r => !r.approved).length;
                console.log(`\n[Iteration ${iteration} Completed] ${result.summary}`);
                await callbacks?.onIterationComplete?.(iteration, result.summary, approved, blocked);

                if (approved === 0) {
                    consecutiveZeroProgress++;
                } else {
                    consecutiveZeroProgress = 0;
                }

                if (consecutiveZeroProgress >= MAX_CONSECUTIVE_ZERO_PROGRESS) {
                    const blockCodes = result.actionResults
                        .filter(r => !r.approved && r.blockedBy)
                        .map(r => r.blockedBy)
                        .join(", ");
                    const reason = `Stuck: ${consecutiveZeroProgress} consecutive iterations with 0 approved actions. ` +
                        `Block reason(s): ${blockCodes || "unknown"}. Stopping to avoid waste.`;
                    console.log(`\n[Autonomous Loop Stuck] ${reason}\n`);
                    await callbacks?.onGoalAborted?.(reason, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }

                const nextStep = await this.evaluateNextStep(currentOverarchingGoal, result);

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
                    const reason = "Output was empty or invalid. Human intervention may be needed.";
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
                const reason = `Reached maximum iterations (${maxIterations}) for goal.`;
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
