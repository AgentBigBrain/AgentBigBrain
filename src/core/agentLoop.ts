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
const EXECUTION_STYLE_READINESS_GATING_REASON_CODE =
    "AUTONOMOUS_EXECUTION_STYLE_READINESS_EVIDENCE_REQUIRED";
const EXECUTION_STYLE_BROWSER_GATING_REASON_CODE =
    "AUTONOMOUS_EXECUTION_STYLE_BROWSER_EVIDENCE_REQUIRED";
const EXECUTION_STYLE_PROCESS_STOP_GATING_REASON_CODE =
    "AUTONOMOUS_EXECUTION_STYLE_PROCESS_STOP_EVIDENCE_REQUIRED";
const EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE =
    "AUTONOMOUS_EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED";
const EXECUTION_STYLE_PROCESS_NEVER_READY_REASON_CODE =
    "AUTONOMOUS_EXECUTION_STYLE_PROCESS_NEVER_READY";
const EXECUTION_STYLE_STALL_REASON_CODE = "AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT";
const GENERIC_STALL_REASON_CODE = "AUTONOMOUS_STALLED_ZERO_PROGRESS";
const MAX_ITERATIONS_REASON_CODE = "AUTONOMOUS_MAX_ITERATIONS_REACHED";
const EMPTY_NEXT_STEP_REASON_CODE = "AUTONOMOUS_NEXT_STEP_EMPTY";
const TASK_EXECUTION_FAILED_REASON_CODE = "AUTONOMOUS_TASK_EXECUTION_FAILED";
const MAX_MANAGED_PROCESS_READINESS_FAILURES = 3;
const MISSION_REQUIREMENT_SIDE_EFFECT = "REAL_SIDE_EFFECT";
const MISSION_REQUIREMENT_TARGET_PATH = "TARGET_PATH_TOUCH";
const MISSION_REQUIREMENT_MUTATION = "ARTIFACT_MUTATION";
const MISSION_REQUIREMENT_READINESS = "READINESS_PROOF";
const MISSION_REQUIREMENT_BROWSER = "BROWSER_PROOF";
const MISSION_REQUIREMENT_PROCESS_STOP = "PROCESS_STOP_PROOF";

type MissionRequirementId =
    | typeof MISSION_REQUIREMENT_SIDE_EFFECT
    | typeof MISSION_REQUIREMENT_TARGET_PATH
    | typeof MISSION_REQUIREMENT_MUTATION
    | typeof MISSION_REQUIREMENT_READINESS
    | typeof MISSION_REQUIREMENT_BROWSER
    | typeof MISSION_REQUIREMENT_PROCESS_STOP;

interface MissionCompletionContract {
    executionStyle: boolean;
    requireRealSideEffect: boolean;
    requireTargetPathTouch: boolean;
    requireArtifactMutation: boolean;
    requireReadinessProof: boolean;
    requireBrowserProof: boolean;
    requireProcessStopProof: boolean;
    targetPathHints: string[];
}

interface MissionEvidenceCounters {
    realSideEffects: number;
    targetPathTouches: number;
    artifactMutations: number;
    readinessProofs: number;
    browserProofs: number;
    processStopProofs: number;
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
 * Evaluates whether a mission goal requires local readiness-proof evidence.
 *
 * **Why it exists:**
 * Distinguishes "files were created" from "the requested local app/server was actually reachable"
 * so live-run goals cannot complete on scaffold or mutation evidence alone.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires a local readiness probe to pass.
 */
function requiresReadinessEvidence(goal: string): boolean {
    if (!isExecutionStyleInput(goal)) {
        return false;
    }
    const normalized = normalizeEvidenceText(goal);
    return (
        /\bnpm\s+start\b/.test(normalized) ||
        /\bnpm\s+run\s+dev\b/.test(normalized) ||
        /\b(?:pnpm|yarn)\s+(?:start|dev)\b/.test(normalized) ||
        /\b(?:next|vite)\s+dev\b/.test(normalized) ||
        /\bdev\s+server\b/.test(normalized) ||
        /\b(localhost|127\.0\.0\.1|::1)\b/.test(normalized) ||
        /\b(run|start|launch|open|serve)\b[\s\S]{0,80}\b(app|site|server|service|project|frontend|backend|api)\b/.test(
            normalized
        ) ||
        /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering|server|service|endpoint|port)\b/.test(
            normalized
        )
    );
}

/**
 * Evaluates whether a mission goal requires browser/UI proof beyond localhost readiness.
 *
 * **Why it exists:**
 * Distinguishes "the service responded" from "the rendered page met expectations" so autonomous
 * completion cannot claim browser/homepage verification on probes alone.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires successful browser-verification evidence.
 */
function requiresBrowserVerificationEvidence(goal: string): boolean {
    if (!requiresReadinessEvidence(goal)) {
        return false;
    }
    const normalized = normalizeEvidenceText(goal);
    return (
        /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/.test(
            normalized
        ) ||
        /\b(open|check|inspect|review)\b[\s\S]{0,80}\b(browser|homepage|ui|page|render|rendering)\b/.test(
            normalized
        ) ||
        /\b(screenshot|visual(?:ly)?\s+confirm)\b/.test(normalized)
    );
}

/**
 * Evaluates whether a mission goal requires proof that a managed local process was stopped cleanly.
 *
 * **Why it exists:**
 * Keeps finite live-run workflows truthful when the user explicitly asks to stop or clean up the
 * local server after verification, instead of letting the loop claim completion while the managed
 * process is still running.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param goal - Mission goal text.
 * @returns `true` when completion requires stop-proof evidence.
 */
function requiresManagedProcessStopEvidence(goal: string): boolean {
    if (!requiresReadinessEvidence(goal)) {
        return false;
    }
    const normalized = normalizeEvidenceText(goal);
    return (
        /\b(stop|terminate|shut\s+down|cleanup|clean\s+up)\b[\s\S]{0,80}\b(process|server|app|site|service|session)\b/.test(
            normalized
        ) ||
        /\bkeep\b[\s\S]{0,40}\bflow\b[\s\S]{0,40}\bfinite\b/.test(normalized)
    );
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
        requireReadinessProof: executionStyle && requiresReadinessEvidence(goal),
        requireBrowserProof: executionStyle && requiresBrowserVerificationEvidence(goal),
        requireProcessStopProof: executionStyle && requiresManagedProcessStopEvidence(goal),
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
    return (
        actionType !== "respond" &&
        actionType !== "read_file" &&
        actionType !== "list_directory" &&
        actionType !== "check_process" &&
        actionType !== "probe_port" &&
        actionType !== "probe_http" &&
        actionType !== "verify_browser"
    );
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
 * Evaluates action result for readiness-proof evidence and returns deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps local readiness semantics explicit so mission completion can require a passed probe without
 * conflating readiness with side-effect execution or artifact mutation.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @param requireHttpReachability - When `true`, only HTTP/browser-level proof counts as readiness.
 * @returns `true` when the action contributes successful readiness-proof evidence.
 */
function isReadinessProofEvidenceAction(
    entry: TaskRunResult["actionResults"][number],
    requireHttpReachability = false
): boolean {
    if (!entry.approved) {
        return false;
    }
    if (isSimulatedExecutionEvidence(entry.output, entry.executionMetadata)) {
        return false;
    }
    if (entry.action.type === "probe_port") {
        return (
            !requireHttpReachability &&
            entry.executionMetadata?.processLifecycleStatus === "PROCESS_READY"
        );
    }
    if (entry.action.type !== "probe_http" && entry.action.type !== "verify_browser") {
        return false;
    }
    return entry.executionMetadata?.processLifecycleStatus === "PROCESS_READY";
}

/**
 * Counts approved readiness-proof actions in one task result.
 *
 * **Why it exists:**
 * Provides deterministic per-iteration readiness progress for live-run completion contracts.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @param requireHttpReachability - When `true`, excludes port-only readiness evidence.
 * @returns Number of approved readiness probes that reached ready state.
 */
function countApprovedReadinessProofActions(
    result: TaskRunResult,
    requireHttpReachability = false
): number {
    return result.actionResults.filter((entry) =>
        isReadinessProofEvidenceAction(entry, requireHttpReachability)
    ).length;
}

/**
 * Evaluates action result for browser-proof evidence and returns deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps UI/homepage/browser verification semantics explicit so mission completion can require page-
 * level proof instead of treating localhost readiness as rendered-UI confirmation.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns `true` when the action contributes successful browser-proof evidence.
 */
function isBrowserProofEvidenceAction(
    entry: TaskRunResult["actionResults"][number]
): boolean {
    if (!entry.approved) {
        return false;
    }
    if (entry.action.type !== "verify_browser") {
        return false;
    }
    if (isSimulatedExecutionEvidence(entry.output, entry.executionMetadata)) {
        return false;
    }
    return entry.executionMetadata?.browserVerification === true &&
        entry.executionMetadata?.browserVerifyPassed === true;
}

/**
 * Counts approved browser-proof actions in one task result.
 *
 * **Why it exists:**
 * Provides deterministic per-iteration browser/UI verification progress for live-run completion
 * contracts that require more than readiness-only evidence.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Number of approved browser verification actions that passed expectations.
 */
function countApprovedBrowserProofActions(result: TaskRunResult): number {
    return result.actionResults.filter((entry) => isBrowserProofEvidenceAction(entry)).length;
}

/**
 * Evaluates action result for managed-process stop-proof evidence and returns a deterministic signal.
 *
 * **Why it exists:**
 * Distinguishes "browser proof passed" from "the finite live-run workflow fully cleaned up" so the
 * loop cannot claim a stop-required goal is complete while the tracked process is still running.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns `true` when the action contributes successful stop-proof evidence.
 */
function isManagedProcessStopEvidenceAction(
    entry: TaskRunResult["actionResults"][number]
): boolean {
    if (!entry.approved) {
        return false;
    }
    const lifecycleStatus = entry.executionMetadata?.processLifecycleStatus;
    if (entry.action.type === "stop_process") {
        return lifecycleStatus === "PROCESS_STOPPED";
    }
    return entry.action.type === "check_process" && lifecycleStatus === "PROCESS_STOPPED";
}

/**
 * Counts approved managed-process stop-proof actions in one task result.
 *
 * **Why it exists:**
 * Provides deterministic completion evidence for finite live-run goals that explicitly require the
 * managed process to be stopped before the loop can finish.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Number of approved stop-proof actions recorded in the result.
 */
function countApprovedManagedProcessStopActions(result: TaskRunResult): number {
    return result.actionResults.filter((entry) => isManagedProcessStopEvidenceAction(entry)).length;
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
    if (contract.requireReadinessProof && counters.readinessProofs <= 0) {
        missing.push(MISSION_REQUIREMENT_READINESS);
    }
    if (contract.requireBrowserProof && counters.browserProofs <= 0) {
        missing.push(MISSION_REQUIREMENT_BROWSER);
    }
    if (contract.requireProcessStopProof && counters.processStopProofs <= 0) {
        missing.push(MISSION_REQUIREMENT_PROCESS_STOP);
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
        case MISSION_REQUIREMENT_PROCESS_STOP:
            return EXECUTION_STYLE_PROCESS_STOP_GATING_REASON_CODE;
        case MISSION_REQUIREMENT_BROWSER:
            return EXECUTION_STYLE_BROWSER_GATING_REASON_CODE;
        case MISSION_REQUIREMENT_READINESS:
            return EXECUTION_STYLE_READINESS_GATING_REASON_CODE;
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
 * @param requireHttpReachability - When `true`, browser-proof missions require HTTP/browser reachability.
 * @returns Deterministic retry instruction text.
 */
function buildMissionEvidenceRetryInput(
    overarchingGoal: string,
    missingRequirements: readonly MissionRequirementId[],
    targetPathHints: readonly string[],
    requireHttpReachability = false
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
    if (missingRequirements.includes(MISSION_REQUIREMENT_READINESS)) {
        requirementNotes.push(
            requireHttpReachability
                ? "prove actual localhost HTTP/browser readiness with a successful probe_http or verify_browser action after the live run starts (an open port alone is not enough)"
                : "prove local readiness with a successful probe_port, probe_http, or verify_browser action after the live run starts"
        );
    }
    if (missingRequirements.includes(MISSION_REQUIREMENT_BROWSER)) {
        requirementNotes.push(
            "prove browser/UI expectations with a successful verify_browser action after localhost readiness is available"
        );
    }
    if (missingRequirements.includes(MISSION_REQUIREMENT_PROCESS_STOP)) {
        requirementNotes.push(
            "stop the managed local process with stop_process, or confirm it is already stopped with check_process, before claiming the finite flow is complete"
        );
    }
    return `Mission evidence is incomplete for goal "${overarchingGoal}". Execute now and satisfy: ${requirementNotes.join(
        "; "
    )}. If blocked, stop and report exact block codes and required user approval.`;
}

/**
 * Builds a deterministic recovery instruction for stop-required finite live-run goals.
 *
 * **Why it exists:**
 * When the only missing evidence is process cleanup, the loop should issue the exact stop action
 * against the tracked lease instead of falling back to a broader natural-language reminder.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param leaseId - Managed-process lease that still needs cleanup proof.
 * @returns Explicit stop-process instruction for the tracked lease.
 */
function buildManagedProcessStopRetryInput(leaseId: string): string {
    return `stop_process leaseId="${leaseId}". Stop the managed process now so the requested finite live-run flow can finish cleanly.`;
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

/**
 * Reads the managed-process lease id recorded on one action result when available.
 *
 * **Why it exists:**
 * Keeps lease-id extraction centralized so readiness-recovery branches can reuse the same
 * deterministic metadata read path instead of duplicating unsafe casts.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns Managed-process lease id, or `null` when unavailable.
 */
function readManagedProcessLeaseId(
    entry: TaskRunResult["actionResults"][number]
): string | null {
    const leaseId = entry.executionMetadata?.processLeaseId;
    return typeof leaseId === "string" && leaseId.trim().length > 0 ? leaseId : null;
}

/**
 * Reads the managed-process lifecycle status recorded on one action result when available.
 *
 * **Why it exists:**
 * Keeps lifecycle-status extraction centralized so lease-tracking and recovery logic stay aligned
 * without repeating unsafe metadata casts across the autonomous loop.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns Managed-process lifecycle status, or `null` when unavailable.
 */
function readManagedProcessLifecycleStatus(
    entry: TaskRunResult["actionResults"][number]
): string | null {
    const lifecycleStatus = entry.executionMetadata?.processLifecycleStatus;
    return typeof lifecycleStatus === "string" && lifecycleStatus.trim().length > 0
        ? lifecycleStatus
        : null;
}

interface ManagedProcessStartPortConflictFailure {
    command: string;
    cwd: string | null;
    requestedPort: number;
    requestedUrl: string;
    suggestedPort: number | null;
    suggestedUrl: string | null;
}

/**
 * Finds a managed-process start failure caused by an already-occupied loopback port.
 *
 * **Why it exists:**
 * Recovery for polluted localhost ports should use typed executor metadata instead of scraping
 * human-readable failure strings, so this helper centralizes the extraction of that start-failure
 * shape from one task result.
 *
 * **What it talks to:**
 * - Uses local metadata readers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Structured port-conflict failure details, or `null` when absent.
 */
function findManagedProcessStartPortConflictFailure(
    result: TaskRunResult
): ManagedProcessStartPortConflictFailure | null {
    for (const entry of result.actionResults) {
        if (entry.approved || entry.action.type !== "start_process") {
            continue;
        }
        if (entry.executionFailureCode !== "PROCESS_START_FAILED") {
            continue;
        }
        const failureKind = entry.executionMetadata?.processStartupFailureKind;
        const requestedPort = entry.executionMetadata?.processRequestedPort;
        const requestedUrl = entry.executionMetadata?.processRequestedUrl;
        if (
            failureKind !== "PORT_IN_USE" ||
            typeof requestedPort !== "number" ||
            !Number.isInteger(requestedPort) ||
            typeof requestedUrl !== "string" ||
            requestedUrl.trim().length === 0
        ) {
            continue;
        }
        const suggestedPort = entry.executionMetadata?.processSuggestedPort;
        const suggestedUrl = entry.executionMetadata?.processSuggestedUrl;
        return {
            command: readActionCommandText(entry.action),
            cwd:
                readActionStringParam(entry.action, "cwd") ??
                readActionStringParam(entry.action, "workdir") ??
                (typeof entry.executionMetadata?.processCwd === "string"
                    ? entry.executionMetadata.processCwd
                    : null),
            requestedPort,
            requestedUrl: requestedUrl.trim(),
            suggestedPort:
                typeof suggestedPort === "number" && Number.isInteger(suggestedPort)
                    ? suggestedPort
                    : null,
            suggestedUrl:
                typeof suggestedUrl === "string" && suggestedUrl.trim().length > 0
                    ? suggestedUrl.trim()
                    : null
        };
    }
    return null;
}

/**
 * Evaluates whether the original mission explicitly requires one concrete localhost port.
 *
 * **Why it exists:**
 * Port-conflict recovery is only allowed to move to a different loopback port when the user did
 * not explicitly pin the workflow to the conflicting port in the overarching goal.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param goal - Mission-level goal text.
 * @param port - Loopback port under consideration.
 * @returns `true` when the goal text explicitly pins this port.
 */
function goalExplicitlyRequiresLoopbackPort(goal: string, port: number): boolean {
    const normalized = normalizeEvidenceText(goal);
    return (
        new RegExp(`(?:localhost|127\\.0\\.0\\.1|::1)\\s*:\\s*${port}\\b`, "i").test(normalized) ||
        new RegExp(`\\bport\\s+${port}\\b`, "i").test(normalized)
    );
}

/**
 * Rewrites one loopback server command to use a different concrete port.
 *
 * **Why it exists:**
 * Deterministic recovery should preserve the original server command shape whenever possible, only
 * swapping the conflicting loopback port so the restart instruction stays truthful and precise.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param command - Original managed-process command text.
 * @param fromPort - Conflicting port that must be replaced.
 * @param toPort - Alternate free loopback port to inject.
 * @returns Rewritten command text.
 */
function rewriteManagedProcessLoopbackPort(
    command: string,
    fromPort: number,
    toPort: number
): string {
    return command
        .replace(
            new RegExp(`(\\bhttp\\.server\\s+)${fromPort}\\b`, "i"),
            `$1${toPort}`
        )
        .replace(
            new RegExp(`(\\b--port\\s+)${fromPort}\\b`, "i"),
            `$1${toPort}`
        )
        .replace(
            new RegExp(`(\\b-p\\s+)${fromPort}\\b`, "i"),
            `$1${toPort}`
        )
        .replace(
            new RegExp(`(localhost:)${fromPort}\\b`, "i"),
            `$1${toPort}`
        )
        .replace(
            new RegExp(`(127\\.0\\.0\\.1:)${fromPort}\\b`, "i"),
            `$1${toPort}`
        );
}

/**
 * Builds a deterministic restart instruction after one loopback-port conflict.
 *
 * **Why it exists:**
 * When the planned localhost port is already occupied, the fastest truthful recovery is to restart
 * the same local server on a concrete free loopback port instead of making the model rediscover a
 * new port from scratch.
 *
 * **What it talks to:**
 * - Uses local command-rewrite helpers within this module.
 *
 * @param failure - Typed managed-process port-conflict failure details.
 * @param requireBrowserProof - When `true`, keeps the restart scoped to readiness before browser proof.
 * @returns Explicit restart subtask instruction.
 */
function buildManagedProcessPortConflictRecoveryInput(
    failure: ManagedProcessStartPortConflictFailure,
    requireBrowserProof = false
): string {
    const suggestedPort = failure.suggestedPort;
    const suggestedUrl =
        failure.suggestedUrl ??
        (suggestedPort !== null ? `http://localhost:${suggestedPort}` : failure.requestedUrl);
    const rewrittenCommand =
        suggestedPort !== null
            ? rewriteManagedProcessLoopbackPort(failure.command, failure.requestedPort, suggestedPort)
            : failure.command;
    const cwdClause = failure.cwd ? ` cwd="${failure.cwd}"` : "";
    return (
        `start_process cmd="${rewrittenCommand}"${cwdClause}. ` +
        `The requested localhost port ${failure.requestedPort} was already occupied, so restart ` +
        `${suggestedPort !== null ? `the local server on free loopback port ${suggestedPort}` : "the local server on a different free loopback port"} instead. ` +
        `After start succeeds, prove readiness with probe_http url="${suggestedUrl}" before any page-level proof. ` +
        `${requireBrowserProof ? "Only continue to verify_browser after readiness passes." : "Do not claim success until readiness passes."}`
    );
}

/**
 * Detects whether a task result contains a failed localhost readiness probe.
 *
 * **Why it exists:**
 * Managed-process recovery should react specifically to typed readiness failures, not every blocked
 * live-run action, so this helper keeps the signal narrow and deterministic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns `true` when a probe action failed with `PROCESS_NOT_READY`.
 */
function hasReadinessNotReadyFailure(result: TaskRunResult): boolean {
    return result.actionResults.some((entry) =>
        !entry.approved &&
        (entry.action.type === "probe_port" || entry.action.type === "probe_http") &&
        (
            entry.executionFailureCode === "PROCESS_NOT_READY" ||
            entry.blockedBy.some((blockCode) => blockCode === "PROCESS_NOT_READY")
        )
    );
}

/**
 * Finds the managed-process lease started during the current iteration.
 *
 * **Why it exists:**
 * A successful `start_process` plus a failed readiness probe should deterministically hand off to
 * `check_process`, and that requires recovering the just-created lease id from typed metadata.
 *
 * **What it talks to:**
 * - Uses local lease-id helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Managed-process lease id, or `null` when no approved start action was recorded.
 */
function findApprovedManagedProcessStartLeaseId(result: TaskRunResult): string | null {
    for (const entry of result.actionResults) {
        if (!entry.approved || entry.action.type !== "start_process") {
            continue;
        }
        const leaseId = readManagedProcessLeaseId(entry);
        if (leaseId) {
            return leaseId;
        }
    }
    return null;
}

interface ApprovedManagedProcessCheckResult {
    leaseId: string;
    lifecycleStatus: string;
}

interface LoopbackTargetHint {
    url: string | null;
    host: string | null;
    port: number | null;
}

/**
 * Finds the latest approved managed-process check result with lease metadata.
 *
 * **Why it exists:**
 * Readiness recovery after `check_process` depends on whether the managed process is still running
 * or already stopped, so the loop needs one deterministic extractor for that status.
 *
 * **What it talks to:**
 * - Uses local lease-id helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Managed-process check metadata, or `null` when unavailable.
 */
function findApprovedManagedProcessCheckResult(
    result: TaskRunResult
): ApprovedManagedProcessCheckResult | null {
    for (const entry of result.actionResults) {
        if (!entry.approved || entry.action.type !== "check_process") {
            continue;
        }
        const leaseId = readManagedProcessLeaseId(entry);
        const lifecycleStatus = entry.executionMetadata?.processLifecycleStatus;
        if (
            leaseId &&
            typeof lifecycleStatus === "string" &&
            lifecycleStatus.trim().length > 0
        ) {
            return {
                leaseId,
                lifecycleStatus
            };
        }
    }
    return null;
}

/**
 * Reads one string action param when present.
 *
 * **Why it exists:**
 * Loopback-target recovery reads command/url/host params from several action types, so this helper
 * keeps those casts in one deterministic place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @param key - Param key to read.
 * @returns Trimmed string param value, or `null`.
 */
function readActionStringParam(
    action: TaskRunResult["actionResults"][number]["action"],
    key: string
): string | null {
    const params = action.params as Record<string, unknown>;
    const value = params[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads one numeric action param when present.
 *
 * **Why it exists:**
 * Loopback-target recovery needs stable host/port metadata without scattering numeric casts across
 * several action-type branches.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @param key - Param key to read.
 * @returns Integer param value, or `null`.
 */
function readActionIntegerParam(
    action: TaskRunResult["actionResults"][number]["action"],
    key: string
): number | null {
    const params = action.params as Record<string, unknown>;
    const value = params[key];
    return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Evaluates whether one hostname is loopback-local and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Recovery prompts should only carry forward loopback-local targets that already passed hard
 * constraints, never arbitrary hostnames parsed from free-form planner text.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param hostname - Raw hostname candidate.
 * @returns `true` when the hostname is localhost, 127.0.0.1, or ::1.
 */
function isLoopbackHostname(hostname: string): boolean {
    const normalized = normalizeEvidenceText(hostname).replace(/^\[|\]$/g, "");
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Normalizes one loopback URL into a stable retry target shape.
 *
 * **Why it exists:**
 * Managed-process recovery needs one canonical URL/host/port tuple so later retries stay on the
 * exact same loopback target instead of drifting to model-default ports.
 *
 * **What it talks to:**
 * - Uses local loopback helpers within this module.
 *
 * @param rawUrl - URL candidate from action params or metadata.
 * @returns Canonical loopback target, or `null` when the URL is invalid/non-loopback.
 */
function normalizeLoopbackTargetUrl(rawUrl: string | null): LoopbackTargetHint | null {
    if (!rawUrl) {
        return null;
    }
    try {
        const parsedUrl = new URL(rawUrl);
        if (!isLoopbackHostname(parsedUrl.hostname)) {
            return null;
        }
        const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : null;
        const canonicalPort = Number.isInteger(port) ? port : null;
        const pathname = parsedUrl.pathname && parsedUrl.pathname !== "/" ? parsedUrl.pathname : "";
        const search = parsedUrl.search ?? "";
        return {
            url: `${parsedUrl.protocol}//${parsedUrl.hostname}${canonicalPort ? `:${canonicalPort}` : ""}${pathname}${search}`,
            host: parsedUrl.hostname,
            port: canonicalPort
        };
    } catch {
        return null;
    }
}

/**
 * Parses one probable loopback port from a managed-process command.
 *
 * **Why it exists:**
 * Start-process recovery may need to recover the target port even before any probe action runs, so
 * this helper extracts bounded local-server port conventions from trusted command params.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param command - Shell/process command text.
 * @returns Parsed loopback target, or `null` when no supported local port pattern is found.
 */
function inferLoopbackTargetFromCommand(command: string): LoopbackTargetHint | null {
    const normalized = normalizeEvidenceText(command);
    const patterns = [
        /\bhttp\.server\s+(\d{2,5})\b/,
        /\b--port\s+(\d{2,5})\b/,
        /\b-p\s+(\d{2,5})\b/,
        /\blocalhost:(\d{2,5})\b/,
        /\b127\.0\.0\.1:(\d{2,5})\b/
    ];
    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (!match) {
            continue;
        }
        const port = Number.parseInt(match[1] ?? "", 10);
        if (!Number.isInteger(port)) {
            continue;
        }
        return {
            url: `http://localhost:${port}`,
            host: "localhost",
            port
        };
    }
    return null;
}

/**
 * Extracts a canonical loopback target from one action result when present.
 *
 * **Why it exists:**
 * Managed-process recovery should keep using the real loopback target chosen by the plan/executor
 * instead of forcing later planner subtasks to rediscover that target from natural language.
 *
 * **What it talks to:**
 * - Uses local action-param helpers within this module.
 * - Uses local loopback-target parsers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns Canonical loopback target, or `null` when no target can be derived.
 */
function extractLoopbackTargetHint(
    entry: TaskRunResult["actionResults"][number]
): LoopbackTargetHint | null {
    if (entry.action.type === "probe_http" || entry.action.type === "verify_browser") {
        return (
            normalizeLoopbackTargetUrl(readActionStringParam(entry.action, "url")) ??
            normalizeLoopbackTargetUrl(
                typeof entry.executionMetadata?.probeUrl === "string"
                    ? entry.executionMetadata.probeUrl
                    : typeof entry.executionMetadata?.browserVerifyUrl === "string"
                        ? entry.executionMetadata.browserVerifyUrl
                        : null
            )
        );
    }
    if (entry.action.type === "probe_port") {
        const host = readActionStringParam(entry.action, "host");
        const port = readActionIntegerParam(entry.action, "port");
        if (host && port !== null && isLoopbackHostname(host)) {
            return {
                url: `http://${host}:${port}`,
                host,
                port
            };
        }
        return null;
    }
    if (entry.action.type === "start_process") {
        const command = readActionStringParam(entry.action, "command");
        return command ? inferLoopbackTargetFromCommand(command) : null;
    }
    return null;
}

/**
 * Updates the tracked loopback target after one autonomous-loop iteration.
 *
 * **Why it exists:**
 * Readiness retries need to stay pinned to the original localhost URL/port even if later planner
 * subtasks drift to a generic default. This helper preserves the first trusted target until a new
 * approved managed-process start replaces it.
 *
 * **What it talks to:**
 * - Uses local loopback-target extraction helpers within this module.
 *
 * @param previousTarget - Target tracked before this iteration, if any.
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Loopback target that should remain tracked for later recovery, or `null`.
 */
function resolveTrackedLoopbackTarget(
    previousTarget: LoopbackTargetHint | null,
    result: TaskRunResult
): LoopbackTargetHint | null {
    let trackedTarget = previousTarget;
    for (const entry of result.actionResults) {
        const candidate = extractLoopbackTargetHint(entry);
        if (!candidate) {
            continue;
        }
        if (entry.action.type === "start_process" && entry.approved) {
            trackedTarget = candidate;
            continue;
        }
        if (!trackedTarget) {
            trackedTarget = candidate;
        }
    }
    return trackedTarget;
}

/**
 * Formats one loopback target for deterministic recovery prompts.
 *
 * **Why it exists:**
 * Human-readable recovery instructions should carry the exact localhost target without rebuilding it
 * ad hoc at each call site.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param target - Tracked loopback target, if any.
 * @returns Readable target label or `null`.
 */
function describeLoopbackTarget(target: LoopbackTargetHint | null): string | null {
    if (!target) {
        return null;
    }
    if (target.url) {
        return target.url;
    }
    if (target.host && target.port !== null) {
        return `${target.host}:${target.port}`;
    }
    return null;
}

/**
 * Updates the tracked managed-process lease after one autonomous-loop iteration.
 *
 * **Why it exists:**
 * Later readiness failures may happen several iterations after the original `start_process`, so
 * the loop needs one deterministic place to remember which managed process should be re-checked.
 *
 * **What it talks to:**
 * - Uses local lease/lifecycle helpers within this module.
 *
 * @param previousLeaseId - Lease id tracked before this iteration, if any.
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Lease id that should remain tracked for later recovery, or `null`.
 */
function resolveTrackedManagedProcessLeaseId(
    previousLeaseId: string | null,
    result: TaskRunResult
): string | null {
    let trackedLeaseId = previousLeaseId;
    for (const entry of result.actionResults) {
        if (!entry.approved) {
            continue;
        }
        const leaseId = readManagedProcessLeaseId(entry);
        if (!leaseId) {
            continue;
        }
        const lifecycleStatus = readManagedProcessLifecycleStatus(entry);
        if (entry.action.type === "start_process" || entry.action.type === "check_process") {
            trackedLeaseId = leaseId;
        }
        if (
            entry.action.type === "stop_process" ||
            lifecycleStatus === "PROCESS_STOPPED"
        ) {
            if (trackedLeaseId === leaseId) {
                trackedLeaseId = null;
            }
        }
    }
    return trackedLeaseId;
}

/**
 * Builds a deterministic recovery instruction for a started process that is not ready yet.
 *
 * **Why it exists:**
 * When a live process spawned but localhost did not become ready, the next useful step is to
 * inspect the managed-process lease instead of repeating the same probe blindly.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param leaseId - Managed-process lease id created by the successful start action.
 * @returns Explicit recovery subtask instruction.
 */
function buildManagedProcessCheckRecoveryInput(
    leaseId: string,
    target: LoopbackTargetHint | null,
    requireHttpReachability = false
): string {
    const targetLabel = describeLoopbackTarget(target);
    const retryInstruction = requireHttpReachability
        ? target?.url
            ? `retry probe_http url="${target.url}" once`
            : "retry probe_http once"
        : target?.url && target.host && target.port !== null
            ? `retry probe_http url="${target.url}" or probe_port host="${target.host}" port=${target.port} once`
            : "retry probe_port or probe_http once";
    return (
        `check_process leaseId="${leaseId}". ` +
        `Managed process lease ${leaseId} started, but localhost was not ready yet${targetLabel ? ` at ${targetLabel}` : ""}. ` +
        `If the lease is still running, ${retryInstruction}. ` +
        "Only continue to page-level proof after readiness passes. " +
        "If the lease already stopped, explain that plainly and restart once if needed."
    );
}

/**
 * Builds a deterministic retry instruction after `check_process` confirms the app is still running.
 *
 * **Why it exists:**
 * A running managed process plus missing readiness proof means the loop should retry the readiness
 * probe, not fall back to generic browser-install or manual-check language.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param leaseId - Managed-process lease id confirmed as still running.
 * @param requireHttpReachability - When `true`, prefers HTTP readiness over a port-only check.
 * @returns Explicit retry subtask instruction.
 */
function buildManagedProcessStillRunningRetryInput(
    leaseId: string,
    requireHttpReachability = false,
    target: LoopbackTargetHint | null = null
): string {
    if (requireHttpReachability) {
        if (target?.url) {
            return (
                `probe_http url="${target.url}". ` +
                `Managed process lease ${leaseId} is still running, but actual localhost HTTP readiness is still not proven at ${target.url}. ` +
                "If you still do not get an HTTP response, stop and explain plainly that the running process never became HTTP-ready before any page-level proof."
            );
        }
        return (
            "probe_http on the expected loopback URL. " +
            `Managed process lease ${leaseId} is still running, but actual localhost HTTP readiness is still not proven. ` +
            "Use probe_port only if the URL is still unknown, and return to probe_http before any page-level proof."
        );
    }
    if (target?.url && target.host && target.port !== null) {
        return (
            `probe_http url="${target.url}" or probe_port host="${target.host}" port=${target.port}. ` +
            `Managed process lease ${leaseId} is still running, but localhost readiness is still not proven at ${target.url}. ` +
            "Wait for readiness proof before doing any page-level proof."
        );
    }
    return (
        "probe_port or probe_http on the expected loopback target. " +
        `Managed process lease ${leaseId} is still running, but localhost readiness is still not proven. ` +
        "Wait for readiness proof before doing any page-level proof."
    );
}

/**
 * Builds a deterministic restart instruction after `check_process` confirms the app already stopped.
 *
 * **Why it exists:**
 * When the managed process dies before readiness proof, the loop should restart or explain the stop
 * result instead of continuing to probe a dead localhost target.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param leaseId - Managed-process lease id confirmed as stopped.
 * @returns Explicit restart subtask instruction.
 */
function buildManagedProcessStoppedRecoveryInput(
    leaseId: string
): string {
    return (
        `Managed process lease ${leaseId} stopped before localhost readiness was proven. ` +
        "Explain the stop result plainly, restart the local server once if needed, and prove " +
        "readiness before any page-level proof."
    );
}

/**
 * Reads an action command string when the action carries one.
 *
 * **Why it exists:**
 * Keeps shell/process command extraction deterministic so live-verification policy helpers can
 * reason about shell-based server or Playwright steps without duplicating unsafe casts.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns Command text, or an empty string when no command is present.
 */
function readActionCommandText(
    action: TaskRunResult["actionResults"][number]["action"]
): string {
    const params = action.params as Record<string, unknown>;
    return typeof params.command === "string" ? params.command : "";
}

/**
 * Evaluates action type and returns whether it is a localhost/browser proof action.
 *
 * **Why it exists:**
 * Live verification needs tighter stop logic than generic execution goals, and this helper keeps
 * proof-action classification deterministic across readiness and browser checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param actionType - Planned action type.
 * @returns `true` when the action type is a live proof action.
 */
function isLiveVerificationProofActionType(
    actionType: TaskRunResult["actionResults"][number]["action"]["type"]
): boolean {
    return (
        actionType === "probe_port" ||
        actionType === "probe_http" ||
        actionType === "verify_browser"
    );
}

/**
 * Evaluates action and returns whether it is a shell-based localhost/live-verification step.
 *
 * **Why it exists:**
 * Some planner/model drifts express local server or Playwright steps through shell text, so the
 * autonomous loop needs one deterministic classifier for those cases before deciding whether to
 * stop or retry.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns `true` when the action represents a shell-based live verification step.
 */
function isShellBasedLiveVerificationAction(
    action: TaskRunResult["actionResults"][number]["action"]
): boolean {
    if (action.type !== "shell_command" && action.type !== "start_process") {
        return false;
    }
    const command = normalizeEvidenceText(readActionCommandText(action));
    if (!command) {
        return false;
    }
    return (
        /\bplaywright\b/.test(command) ||
        /\bpython\s+-m\s+http\.server\b/.test(command) ||
        /\b(localhost|127\.0\.0\.1|::1)\b/.test(command) ||
        /\bnpm\s+(?:start|run\s+dev)\b/.test(command) ||
        /\b(?:pnpm|yarn)\s+(?:start|dev)\b/.test(command) ||
        /\b(?:next|vite)\s+dev\b/.test(command)
    );
}

/**
 * Evaluates action and returns whether it belongs to a live localhost/browser verification flow.
 *
 * **Why it exists:**
 * Deterministic autonomous stop logic should look only at live-run specific actions, not all
 * blocked results, so this helper centralizes the classification.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns `true` when the action participates in a live verification flow.
 */
function isLiveVerificationRelatedAction(
    action: TaskRunResult["actionResults"][number]["action"]
): boolean {
    return (
        action.type === "start_process" ||
        isLiveVerificationProofActionType(action.type) ||
        isShellBasedLiveVerificationAction(action)
    );
}

/**
 * Builds a readable label for missing live-verification proof requirements.
 *
 * **Why it exists:**
 * Human-first abort reasons should name the blocked proof steps in plain language instead of
 * exposing raw `READINESS_PROOF` or `BROWSER_PROOF` tokens directly.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param missingRequirements - Ordered missing requirement identifiers.
 * @returns Human-readable proof-step label.
 */
function describeMissingLiveVerificationProof(
    missingRequirements: readonly MissionRequirementId[]
): string {
    const missingReadiness = missingRequirements.includes(MISSION_REQUIREMENT_READINESS);
    const missingBrowser = missingRequirements.includes(MISSION_REQUIREMENT_BROWSER);
    if (missingReadiness && missingBrowser) {
        return "localhost readiness and browser verification";
    }
    if (missingBrowser) {
        return "browser verification";
    }
    return "localhost readiness verification";
}

/**
 * Resolves an early-abort reason when live verification is blocked by the environment.
 *
 * **Why it exists:**
 * Once governance/runtime blocks the remaining localhost proof steps, the autonomous loop should
 * stop with a plain explanation instead of letting the model invent manual checks or repeated shell
 * probes that still cannot produce truthful proof.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 * - Uses local live-verification helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @param missionContract - Mission completion requirements for the overarching goal.
 * @param missingRequirements - Ordered missing requirement identifiers after this iteration.
 * @returns Abort reason text with typed code, or `null` when the loop should continue.
 */
function resolveLiveVerificationBlockedAbortReason(
    result: TaskRunResult,
    missionContract: MissionCompletionContract,
    missingRequirements: readonly MissionRequirementId[]
): string | null {
    if (!missionContract.executionStyle) {
        return null;
    }
    if (
        !missingRequirements.includes(MISSION_REQUIREMENT_READINESS) &&
        !missingRequirements.includes(MISSION_REQUIREMENT_BROWSER)
    ) {
        return null;
    }
    if (hasExecutionFailureCode(result, "BROWSER_VERIFY_RUNTIME_UNAVAILABLE")) {
        return null;
    }

    const liveVerificationEntries = result.actionResults.filter((entry) =>
        isLiveVerificationRelatedAction(entry.action)
    );
    if (liveVerificationEntries.length === 0) {
        return null;
    }
    if (
        liveVerificationEntries.some((entry) =>
            isReadinessProofEvidenceAction(entry, missionContract.requireBrowserProof) ||
            isBrowserProofEvidenceAction(entry)
        )
    ) {
        return null;
    }

    const blockedReasons = new Set<string>();
    for (const entry of liveVerificationEntries) {
        if (entry.approved) {
            continue;
        }
        for (const blockedReason of entry.blockedBy) {
            blockedReasons.add(blockedReason);
        }
    }

    const environmentBlocked =
        blockedReasons.has("SHELL_DISABLED_BY_POLICY") ||
        blockedReasons.has("ethics") ||
        blockedReasons.has("resource") ||
        blockedReasons.has("security") ||
        blockedReasons.has("continuity") ||
        blockedReasons.has("utility") ||
        /\bMISSION_STOP_LIMIT_REACHED\b/i.test(result.summary);
    if (!environmentBlocked) {
        return null;
    }

    return formatReasonWithCode(
        EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE,
        "Live verification stopped because the environment blocked " +
        `${describeMissingLiveVerificationProof(missingRequirements)} steps, ` +
        "so I could not truthfully confirm the app or page in this run."
    );
}

/**
 * Builds a typed abort reason when one running local process never becomes HTTP-ready.
 *
 * **Why it exists:**
 * Repeating the same readiness probe forever is poor UX and leaves orphaned servers behind. This
 * helper centralizes the plain-language stop reason once the loop has given one managed process a
 * bounded number of honest HTTP readiness attempts.
 *
 * **What it talks to:**
 * - Uses local reason-code and loopback-target helpers within this module.
 *
 * @param target - Loopback target that never became ready, if known.
 * @returns Prefixed abort reason suitable for logs and interface humanization.
 */
function formatManagedProcessNeverReadyReason(target: LoopbackTargetHint | null): string {
    const targetLabel = describeLoopbackTarget(target);
    return formatReasonWithCode(
        EXECUTION_STYLE_PROCESS_NEVER_READY_REASON_CODE,
        "Live verification stopped because the running local process never became HTTP-ready" +
        `${targetLabel ? ` at ${targetLabel}` : ""}, so I stopped retrying and could not truthfully ` +
        "confirm the app or page in this run."
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
     * Attempts one governed cleanup stop for a tracked managed-process lease.
     *
     * **Why it exists:**
     * Live-run failures can otherwise leave local dev servers behind after the loop aborts. This
     * helper keeps cleanup bounded and explicit without relying on the model to remember cleanup
     * after the loop has already decided to stop.
     *
     * **What it talks to:**
     * - Uses `TaskRequest` (import `TaskRequest`) from `./types`.
     * - Uses `makeId` (import `makeId`) from `./ids`.
     * - Uses `MAIN_AGENT_ID` (import `MAIN_AGENT_ID`) from `./agentIdentity`.
     * - Uses `BrainOrchestrator` (import `BrainOrchestrator`) from `./orchestrator`.
     *
     * @param overarchingGoal - Goal the loop was working on when cleanup became necessary.
     * @param leaseId - Managed-process lease id to stop.
     * @returns Promise resolving once the best-effort cleanup attempt finishes.
     */
    private async cleanupManagedProcessLease(
        overarchingGoal: string,
        leaseId: string
    ): Promise<void> {
        const cleanupTask: TaskRequest = {
            id: makeId("task"),
            agentId: MAIN_AGENT_ID,
            goal: overarchingGoal,
            userInput: `stop_process leaseId="${leaseId}". Stop this managed process now for cleanup and do not start a replacement.`,
            createdAt: new Date().toISOString()
        };
        try {
            console.log(`\n[Autonomous Loop Cleanup] Stopping managed process lease ${leaseId}.\n`);
            const cleanupResult = await this.orchestrator.runTask(cleanupTask);
            console.log(`[Autonomous Loop Cleanup] ${cleanupResult.summary}`);
        } catch (error) {
            console.error(
                `[Autonomous Loop Cleanup] Failed to stop managed process lease ${leaseId}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

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
                    await this.cleanupManagedProcessLease(
                        currentOverarchingGoal,
                        trackedManagedProcessLeaseId
                    );
                    trackedManagedProcessLeaseId = null;
                }
                console.log(`\n[Autonomous Loop Aborted] ${reason}\n`);
                await callbacks?.onGoalAborted?.(reason, currentIteration);
                goalMetInCurrentLoop = true;
            };

            while (unlimited || iteration < maxIterations) {
                if (signal?.aborted) {
                    const reason = "Cancelled by user.";
                    if (trackedManagedProcessLeaseId) {
                        await this.cleanupManagedProcessLease(
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
                            await this.cleanupManagedProcessLease(
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
                        await this.cleanupManagedProcessLease(
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
                    const reason = formatManagedProcessNeverReadyReason(trackedLoopbackTarget);
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
                        await this.cleanupManagedProcessLease(
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
                    await this.cleanupManagedProcessLease(
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
