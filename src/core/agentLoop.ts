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

const EXECUTION_STYLE_GOAL_GATING_REASON_CODE = "AUTONOMOUS_EXECUTION_STYLE_SIDE_EFFECT_REQUIRED";
const EXECUTION_STYLE_TARGET_PATH_GATING_REASON_CODE =
    "AUTONOMOUS_EXECUTION_STYLE_TARGET_PATH_EVIDENCE_REQUIRED";
const EXECUTION_STYLE_MUTATION_GATING_REASON_CODE =
    "AUTONOMOUS_EXECUTION_STYLE_MUTATION_EVIDENCE_REQUIRED";
const EXECUTION_STYLE_STALL_REASON_CODE = "AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT";
const GENERIC_STALL_REASON_CODE = "AUTONOMOUS_STALLED_ZERO_PROGRESS";
const MAX_ITERATIONS_REASON_CODE = "AUTONOMOUS_MAX_ITERATIONS_REACHED";
const EMPTY_NEXT_STEP_REASON_CODE = "AUTONOMOUS_NEXT_STEP_EMPTY";
const TASK_EXECUTION_FAILED_REASON_CODE = "AUTONOMOUS_TASK_EXECUTION_FAILED";
const MISSION_REQUIREMENT_SIDE_EFFECT = "REAL_SIDE_EFFECT";
const MISSION_REQUIREMENT_TARGET_PATH = "TARGET_PATH_TOUCH";
const MISSION_REQUIREMENT_MUTATION = "ARTIFACT_MUTATION";

type MissionRequirementId =
    | typeof MISSION_REQUIREMENT_SIDE_EFFECT
    | typeof MISSION_REQUIREMENT_TARGET_PATH
    | typeof MISSION_REQUIREMENT_MUTATION;

interface MissionCompletionContract {
    executionStyle: boolean;
    requireRealSideEffect: boolean;
    requireTargetPathTouch: boolean;
    requireArtifactMutation: boolean;
    targetPathHints: string[];
}

interface MissionEvidenceCounters {
    realSideEffects: number;
    targetPathTouches: number;
    artifactMutations: number;
}

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
 * Normalizes path-like text for deterministic evidence comparisons.
 *
 * **Why it exists:**
 * Converts slash variance and quote/punctuation drift into one canonical token used by mission checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Path-like text candidate.
 * @returns Canonical normalized path token.
 */
function normalizePathHint(value: string): string {
    return normalizeEvidenceText(value)
        .replace(/^["'\s(]+/, "")
        .replace(/["'\s),.;:]+$/, "")
        .replace(/\//g, "\\")
        .replace(/\\+/g, "\\");
}

/**
 * Extracts explicit target path hints from a mission goal.
 *
 * **Why it exists:**
 * Provides deterministic path anchors so completion cannot drift to unrelated folders while still
 * allowing free-form natural language goals.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns Canonical explicit path hints found in the goal.
 */
function extractGoalPathHints(goal: string): string[] {
    const candidates: string[] = [];
    const quotedPathPattern = /["']([^"']*(?:[a-z]:\\|\/)[^"']*)["']/gi;
    const windowsPathPattern = /\b[a-z]:\\[^\s"']+/gi;
    const unixPathPattern = /(?:^|\s)(\/(?:users|home|tmp|var|opt|mnt)[^\s"']*)/gi;

    let match: RegExpExecArray | null = null;
    while ((match = quotedPathPattern.exec(goal)) !== null) {
        candidates.push(match[1]);
    }
    while ((match = windowsPathPattern.exec(goal)) !== null) {
        candidates.push(match[0]);
    }
    while ((match = unixPathPattern.exec(goal)) !== null) {
        candidates.push(match[1]);
    }

    const deduped = new Set<string>();
    for (const candidate of candidates) {
        const normalized = normalizePathHint(candidate);
        if (normalized.length >= 5) {
            deduped.add(normalized);
        }
    }
    return [...deduped];
}

/**
 * Evaluates whether a mission goal requires artifact-mutation evidence.
 *
 * **Why it exists:**
 * Distinguishes scaffold-only completion from customization/edit goals so deterministic completion
 * proof aligns with user intent beyond bare project creation.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires at least one real mutation action.
 */
function requiresArtifactMutationEvidence(goal: string): boolean {
    const normalized = normalizeEvidenceText(goal);
    const mutationIntentPattern =
        /\b(customi[sz]e|replace|modify|edit|redesign|restyle|theme|style|component|components|layout|ui|interface|chart|charts|portfolio|homepage|page)\b/;
    const artifactSurfacePattern =
        /\b(app|application|project|frontend|backend|website|dashboard|file|files|document|template|content|css|html|jsx|tsx)\b/;
    return mutationIntentPattern.test(normalized) && artifactSurfacePattern.test(normalized);
}

/**
 * Builds mission completion contract from mission-level goal text.
 *
 * **Why it exists:**
 * Keeps autonomous completion requirements deterministic and independent of model-only "goal met"
 * judgments so completion remains auditable across domains.
 *
 * **What it talks to:**
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `../interfaces/routingMap`.
 * - Uses `isExecutionSurfaceRoutingClassification` (import `isExecutionSurfaceRoutingClassification`) from `../interfaces/routingMap`.
 * - Uses local constants/helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns Deterministic mission completion contract.
 */
function buildMissionCompletionContract(goal: string): MissionCompletionContract {
    const routingClassification = classifyRoutingIntentV1(goal);
    const executionStyle =
        isExecutionStyleInput(goal) ||
        isExecutionSurfaceRoutingClassification(routingClassification);
    const targetPathHints = extractGoalPathHints(goal);
    return {
        executionStyle,
        requireRealSideEffect: executionStyle,
        requireTargetPathTouch: executionStyle && targetPathHints.length > 0,
        requireArtifactMutation: executionStyle && requiresArtifactMutationEvidence(goal),
        targetPathHints
    };
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
 * Evaluates action result for artifact-mutation evidence and returns deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps mutation-evidence semantics explicit so mission completion cannot pass on scaffold-only work.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns `true` when the action contributes real artifact-mutation evidence.
 */
function isArtifactMutationEvidenceAction(
    entry: TaskRunResult["actionResults"][number]
): boolean {
    if (!entry.approved) {
        return false;
    }
    if (isSimulatedExecutionEvidence(entry.output, entry.executionMetadata)) {
        return false;
    }

    switch (entry.action.type) {
        case "write_file":
        case "delete_file":
        case "self_modify":
        case "memory_mutation":
        case "network_write":
        case "create_skill":
        case "run_skill":
            return true;
        case "shell_command":
            // Shell command text is too ambiguous for trustworthy mutation proof.
            // Completion proof stays fail-closed unless explicit typed mutation actions execute.
            return false;
        default:
            return false;
    }
}

/**
 * Counts approved real artifact-mutation evidence actions in one task result.
 *
 * **Why it exists:**
 * Provides deterministic per-iteration mutation proof progress for completion contracts.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Number of approved real mutation-evidence actions.
 */
function countApprovedArtifactMutationActions(result: TaskRunResult): number {
    return result.actionResults.filter((entry) => isArtifactMutationEvidenceAction(entry)).length;
}

/**
 * Collects path-evidence hints from an action for deterministic target-path checks.
 *
 * **Why it exists:**
 * Keeps action-to-path evidence extraction centralized so mission path-proof checks stay consistent.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns Canonical path evidence hints derived from action params.
 */
function collectActionPathHints(
    action: TaskRunResult["actionResults"][number]["action"]
): string[] {
    const hints: string[] = [];
    const params = action.params as Record<string, unknown>;

    const pushIfString = (value: unknown): void => {
        if (typeof value !== "string") {
            return;
        }
        const normalized = normalizePathHint(value);
        if (normalized.length >= 2) {
            hints.push(normalized);
        }
    };

    pushIfString(params.path);
    pushIfString(params.target);
    pushIfString(params.file);
    pushIfString(params.directory);
    pushIfString(params.cwd);
    pushIfString(params.workdir);
    pushIfString(params.url);
    pushIfString(params.endpoint);
    pushIfString(params.command);
    return hints;
}

/**
 * Evaluates action result for explicit target-path touch evidence.
 *
 * **Why it exists:**
 * Prevents autonomous mission completion from drifting to unintended directories when goals include
 * explicit path anchors.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @param targetPathHints - Canonical target path hints extracted from mission goal.
 * @returns `true` when action evidence touches one of the mission target paths.
 */
function isTargetPathTouchEvidence(
    entry: TaskRunResult["actionResults"][number],
    targetPathHints: readonly string[]
): boolean {
    if (!entry.approved) {
        return false;
    }
    if (!isExecutionEvidenceActionType(entry.action.type)) {
        return false;
    }
    if (isSimulatedExecutionEvidence(entry.output, entry.executionMetadata)) {
        return false;
    }
    const evidenceHints = collectActionPathHints(entry.action);
    if (evidenceHints.length === 0) {
        return false;
    }
    for (const targetPathHint of targetPathHints) {
        for (const evidenceHint of evidenceHints) {
            if (evidenceHint.includes(targetPathHint) || targetPathHint.includes(evidenceHint)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Counts approved real target-path touch evidence actions in one task result.
 *
 * **Why it exists:**
 * Produces deterministic progress counters for explicit mission path anchors.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @param targetPathHints - Canonical target path hints extracted from mission goal.
 * @returns Number of approved real actions touching target path hints.
 */
function countApprovedTargetPathTouchActions(
    result: TaskRunResult,
    targetPathHints: readonly string[]
): number {
    if (targetPathHints.length === 0) {
        return 0;
    }
    return result.actionResults.filter((entry) =>
        isTargetPathTouchEvidence(entry, targetPathHints)
    ).length;
}

/**
 * Resolves missing mission evidence requirements from contract and counters.
 *
 * **Why it exists:**
 * Keeps requirement-evaluation logic deterministic so stall and completion gates share one source
 * of truth.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param contract - Mission completion contract.
 * @param counters - Mission evidence counters accumulated so far.
 * @returns Ordered missing requirement identifiers.
 */
function resolveMissingMissionRequirements(
    contract: MissionCompletionContract,
    counters: MissionEvidenceCounters
): MissionRequirementId[] {
    if (!contract.executionStyle) {
        return [];
    }
    const missing: MissionRequirementId[] = [];
    if (contract.requireRealSideEffect && counters.realSideEffects <= 0) {
        missing.push(MISSION_REQUIREMENT_SIDE_EFFECT);
    }
    if (contract.requireTargetPathTouch && counters.targetPathTouches <= 0) {
        missing.push(MISSION_REQUIREMENT_TARGET_PATH);
    }
    if (contract.requireArtifactMutation && counters.artifactMutations <= 0) {
        missing.push(MISSION_REQUIREMENT_MUTATION);
    }
    return missing;
}

/**
 * Maps missing mission requirement to deterministic reason code.
 *
 * **Why it exists:**
 * Preserves machine-readable stop/defer diagnostics with stable requirement-specific codes.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param requirement - Missing mission requirement identifier.
 * @returns Stable reason code for this missing requirement.
 */
function mapRequirementToReasonCode(requirement: MissionRequirementId): string {
    switch (requirement) {
        case MISSION_REQUIREMENT_TARGET_PATH:
            return EXECUTION_STYLE_TARGET_PATH_GATING_REASON_CODE;
        case MISSION_REQUIREMENT_MUTATION:
            return EXECUTION_STYLE_MUTATION_GATING_REASON_CODE;
        case MISSION_REQUIREMENT_SIDE_EFFECT:
        default:
            return EXECUTION_STYLE_GOAL_GATING_REASON_CODE;
    }
}

/**
 * Builds retry input from missing mission evidence requirements.
 *
 * **Why it exists:**
 * Keeps autonomous-loop retries grounded in deterministic missing-evidence instructions instead of
 * unconstrained rephrasing.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param overarchingGoal - Mission-level goal text.
 * @param missingRequirements - Ordered missing requirement identifiers.
 * @param targetPathHints - Canonical target path hints extracted from goal.
 * @returns Deterministic retry instruction text.
 */
function buildMissionEvidenceRetryInput(
    overarchingGoal: string,
    missingRequirements: readonly MissionRequirementId[],
    targetPathHints: readonly string[]
): string {
    const requirementNotes: string[] = [];
    if (missingRequirements.includes(MISSION_REQUIREMENT_SIDE_EFFECT)) {
        requirementNotes.push(
            "execute at least one real side-effect action (read/list/simulated outputs do not satisfy this gate)"
        );
    }
    if (missingRequirements.includes(MISSION_REQUIREMENT_TARGET_PATH)) {
        requirementNotes.push(
            `touch the mission target path explicitly (${targetPathHints.join(", ")})`
        );
    }
    if (missingRequirements.includes(MISSION_REQUIREMENT_MUTATION)) {
        requirementNotes.push(
            "apply at least one real artifact-mutation action (for example write_file or non-scaffold mutation execution)"
        );
    }
    return `Mission evidence is incomplete for goal "${overarchingGoal}". Execute now and satisfy: ${requirementNotes.join(
        "; "
    )}. If blocked, stop and report exact block codes and required user approval.`;
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
                artifactMutations: 0
            };

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

                let result: TaskRunResult;
                try {
                    result = await this.orchestrator.runTask(task);
                } catch (error) {
                    const errorMessage = (error as Error).message || "Unknown runtime error.";
                    const reason = formatReasonWithCode(
                        TASK_EXECUTION_FAILED_REASON_CODE,
                        `Iteration ${iteration} failed before completion: ${errorMessage}`
                    );
                    console.log(`\n[Autonomous Loop Aborted] ${reason}\n`);
                    await callbacks?.onGoalAborted?.(reason, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }
                const approved = result.actionResults.filter(r => r.approved).length;
                const approvedRealSideEffects = countApprovedRealSideEffectActions(result);
                const approvedTargetPathTouches = countApprovedTargetPathTouchActions(
                    result,
                    missionContract.targetPathHints
                );
                const approvedArtifactMutations = countApprovedArtifactMutationActions(result);
                const missingBefore = resolveMissingMissionRequirements(missionContract, missionEvidence);
                missionEvidence = {
                    realSideEffects: missionEvidence.realSideEffects + approvedRealSideEffects,
                    targetPathTouches: missionEvidence.targetPathTouches + approvedTargetPathTouches,
                    artifactMutations: missionEvidence.artifactMutations + approvedArtifactMutations
                };
                const missingAfter = resolveMissingMissionRequirements(missionContract, missionEvidence);

                const blocked = result.actionResults.filter(r => !r.approved).length;
                console.log(`\n[Iteration ${iteration} Completed] ${result.summary}`);
                await callbacks?.onIterationComplete?.(iteration, result.summary, approved, blocked);

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
                    const progressLabel = missionContract.executionStyle
                        ? "required mission completion evidence"
                        : "approved actions";
                    const missingRequirements = resolveMissingMissionRequirements(
                        missionContract,
                        missionEvidence
                    );
                    const reason = formatReasonWithCode(
                        reasonCode,
                        `Stuck: ${consecutiveZeroProgress} consecutive iterations with 0 ${progressLabel}. ` +
                        `Missing requirement(s): ${missingRequirements.join(", ") || "none"}. ` +
                        `Block reason(s): ${blockCodes || "unknown"}. Stopping to avoid waste.`
                    );
                    console.log(`\n[Autonomous Loop Stuck] ${reason}\n`);
                    await callbacks?.onGoalAborted?.(reason, iteration);
                    goalMetInCurrentLoop = true;
                    break;
                }

                const nextStep = await this.evaluateNextStep(currentOverarchingGoal, result);
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
                        nextStep.nextUserInput && nextStep.nextUserInput.trim().length > 0
                            ? nextStep.nextUserInput
                            : buildMissionEvidenceRetryInput(
                                currentOverarchingGoal,
                                missingRequirements,
                                missionContract.targetPathHints
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
