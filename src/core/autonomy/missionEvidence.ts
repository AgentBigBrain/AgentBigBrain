/**
 * @fileoverview Counts deterministic mission evidence and builds retry guidance for autonomy.
 */

import type { TaskRunResult } from "../types";
import {
  type AutonomousReasonCode,
  EXECUTION_STYLE_BROWSER_GATING_REASON_CODE,
  EXECUTION_STYLE_GOAL_GATING_REASON_CODE,
  EXECUTION_STYLE_PROCESS_STOP_GATING_REASON_CODE,
  EXECUTION_STYLE_READINESS_GATING_REASON_CODE,
  EXECUTION_STYLE_TARGET_PATH_GATING_REASON_CODE,
  EXECUTION_STYLE_MUTATION_GATING_REASON_CODE,
  MISSION_REQUIREMENT_BROWSER,
  MISSION_REQUIREMENT_MUTATION,
  MISSION_REQUIREMENT_PROCESS_STOP,
  MISSION_REQUIREMENT_READINESS,
  MISSION_REQUIREMENT_SIDE_EFFECT,
  MISSION_REQUIREMENT_TARGET_PATH,
  type MissionCompletionContract,
  type MissionEvidenceCounters,
  type MissionRequirementId
} from "./contracts";

type ActionResultEntry = TaskRunResult["actionResults"][number];
type ActionType = TaskRunResult["actionResults"][number]["action"]["type"];

/**
 * Normalizes text for deterministic case-insensitive evidence checks.
 *
 * **Why it exists:**
 * Evidence matching should not depend on casing or stray whitespace in action params.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
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
 * Mission path hints and action params can differ by slash style or punctuation. This helper keeps
 * target-path matching stable.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
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
 * Evaluates side-effect action type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Mission completion needs a stable definition of which actions count as real side effects and
 * which actions are merely observation or proof steps.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param actionType - Planned action type.
 * @returns `true` when this action type counts as side-effect execution evidence.
 */
export function isExecutionEvidenceActionType(actionType: ActionType): boolean {
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
 * **Why it exists:**
 * Deterministic mission proof must ignore simulated shell or tool results even when they were
 * technically approved.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param output - Execution output text.
 * @param executionMetadata - Optional typed execution metadata.
 * @returns `true` when the execution result is simulated and should not count as real evidence.
 */
function isSimulatedExecutionEvidence(
  output: string | undefined,
  executionMetadata: ActionResultEntry["executionMetadata"]
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
 * **Why it exists:**
 * Autonomous execution-style goals should only gain side-effect progress from real approved
 * actions, not from reads, probes, or simulated execution.
 *
 * **What it talks to:**
 * - Uses local evidence helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Number of approved side-effect actions that represent real execution evidence.
 */
export function countApprovedRealSideEffectActions(result: TaskRunResult): number {
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
 * Evaluates action result for artifact-mutation evidence and returns a deterministic signal.
 *
 * **Why it exists:**
 * Mutation evidence should be explicit and fail-closed so scaffold-only or shell-only actions do
 * not count as proof that project artifacts were changed.
 *
 * **What it talks to:**
 * - Uses local evidence helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns `true` when the action contributes real artifact-mutation evidence.
 */
function isArtifactMutationEvidenceAction(entry: ActionResultEntry): boolean {
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
      return false;
    default:
      return false;
  }
}

/**
 * Counts approved real artifact-mutation evidence actions in one task result.
 *
 * **Why it exists:**
 * Gives the loop one canonical mutation counter for mission completion gates.
 *
 * **What it talks to:**
 * - Uses local artifact-evidence helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Number of approved real mutation-evidence actions.
 */
export function countApprovedArtifactMutationActions(result: TaskRunResult): number {
  return result.actionResults.filter((entry) => isArtifactMutationEvidenceAction(entry)).length;
}

/**
 * Evaluates action result for readiness-proof evidence and returns a deterministic signal.
 *
 * **Why it exists:**
 * Readiness proof should distinguish simple port reachability from stricter HTTP or browser-level
 * reachability when UI proof is required.
 *
 * **What it talks to:**
 * - Uses local evidence helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @param requireHttpReachability - When `true`, only HTTP/browser-level proof counts as readiness.
 * @returns `true` when the action contributes successful readiness-proof evidence.
 */
export function isReadinessProofEvidenceAction(
  entry: ActionResultEntry,
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
  if (entry.action.type === "open_browser") {
    return (
      entry.executionMetadata?.browserSession === true &&
      entry.executionMetadata?.browserSessionStatus === "open" &&
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
 * - Uses `isReadinessProofEvidenceAction` from this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @param requireHttpReachability - When `true`, excludes port-only readiness evidence.
 * @returns Number of approved readiness probes that reached ready state.
 */
export function countApprovedReadinessProofActions(
  result: TaskRunResult,
  requireHttpReachability = false
): number {
  return result.actionResults.filter((entry) =>
    isReadinessProofEvidenceAction(entry, requireHttpReachability)
  ).length;
}

/**
 * Evaluates action result for browser-proof evidence and returns a deterministic signal.
 *
 * **Why it exists:**
 * Browser proof needs a stable definition so localhost readiness is not mistaken for a successful
 * rendered-page verification.
 *
 * **What it talks to:**
 * - Uses local evidence helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns `true` when the action contributes successful browser-proof evidence.
 */
export function isBrowserProofEvidenceAction(entry: ActionResultEntry): boolean {
  if (!entry.approved) {
    return false;
  }
  if (entry.action.type !== "verify_browser") {
    return false;
  }
  if (isSimulatedExecutionEvidence(entry.output, entry.executionMetadata)) {
    return false;
  }
  return (
    entry.executionMetadata?.browserVerification === true &&
    entry.executionMetadata?.browserVerifyPassed === true
  );
}

/**
 * Counts approved browser-proof actions in one task result.
 *
 * **Why it exists:**
 * Provides deterministic browser/UI verification progress for completion gates.
 *
 * **What it talks to:**
 * - Uses `isBrowserProofEvidenceAction` from this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Number of approved browser verification actions that passed expectations.
 */
export function countApprovedBrowserProofActions(result: TaskRunResult): number {
  return result.actionResults.filter((entry) => isBrowserProofEvidenceAction(entry)).length;
}

/**
 * Evaluates action result for managed-process stop-proof evidence and returns a deterministic
 * signal.
 *
 * **Why it exists:**
 * Finite live-run workflows should only count cleanup proof when the process was actually stopped
 * or confirmed stopped.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns `true` when the action contributes successful stop-proof evidence.
 */
function isManagedProcessStopEvidenceAction(entry: ActionResultEntry): boolean {
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
 * Provides deterministic completion evidence for finite live-run goals that require cleanup.
 *
 * **What it talks to:**
 * - Uses local stop-proof helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Number of approved stop-proof actions recorded in the result.
 */
export function countApprovedManagedProcessStopActions(result: TaskRunResult): number {
  return result.actionResults.filter((entry) => isManagedProcessStopEvidenceAction(entry)).length;
}

/**
 * Collects path-evidence hints from an action for deterministic target-path checks.
 *
 * **Why it exists:**
 * Mission path proof depends on one stable extraction path for action params such as `path`,
 * `cwd`, `workdir`, or `command`.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns Canonical path evidence hints derived from action params.
 */
function collectActionPathHints(action: ActionResultEntry["action"]): string[] {
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
 * Explicit target paths in the mission should gate completion, so the loop needs a deterministic
 * way to tell whether an approved action actually touched that path.
 *
 * **What it talks to:**
 * - Uses local path-evidence helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @param targetPathHints - Canonical target path hints extracted from mission goal.
 * @returns `true` when action evidence touches one of the mission target paths.
 */
function isTargetPathTouchEvidence(
  entry: ActionResultEntry,
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
 * Provides deterministic path-touch counters for mission contracts with explicit target paths.
 *
 * **What it talks to:**
 * - Uses local target-path helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @param targetPathHints - Canonical target path hints extracted from mission goal.
 * @returns Number of approved real actions touching target path hints.
 */
export function countApprovedTargetPathTouchActions(
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
 * Resolves missing mission evidence requirements from a mission contract and current counters.
 *
 * **Why it exists:**
 * Completion, stall handling, and retry shaping all need one shared source of truth for which
 * mission requirements are still missing.
 *
 * **What it talks to:**
 * - Uses local mission-contract constants within this module.
 *
 * @param contract - Mission completion contract.
 * @param counters - Mission evidence counters accumulated so far.
 * @returns Ordered missing requirement identifiers.
 */
export function resolveMissingMissionRequirements(
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
 * Maps a missing mission requirement to its deterministic reason code.
 *
 * **Why it exists:**
 * Requirement-specific stop or defer diagnostics should use one stable reason-code mapping.
 *
 * **What it talks to:**
 * - Uses local mission-contract constants within this module.
 *
 * @param requirement - Missing mission requirement identifier.
 * @returns Stable reason code for this missing requirement.
 */
export function mapRequirementToReasonCode(requirement: MissionRequirementId): AutonomousReasonCode {
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
 * When the planner says the goal is met but deterministic completion disagrees, the loop needs one
 * stable retry prompt describing the missing proof instead of inventing new language each time.
 *
 * **What it talks to:**
 * - Uses local mission-requirement constants within this module.
 *
 * @param overarchingGoal - Mission-level goal text.
 * @param missingRequirements - Ordered missing requirement identifiers.
 * @param targetPathHints - Canonical target path hints extracted from goal.
 * @param requireHttpReachability - When `true`, browser-proof missions require HTTP/browser reachability.
 * @returns Deterministic retry instruction text.
 */
export function buildMissionEvidenceRetryInput(
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
 * instead of falling back to a generic natural-language reminder.
 *
 * **What it talks to:**
 * - Uses local mission-evidence helpers within this module.
 *
 * @param leaseId - Managed-process lease that still needs cleanup proof.
 * @returns Explicit stop-process instruction for the tracked lease.
 */
export function buildManagedProcessStopRetryInput(leaseId: string): string {
  return `stop_process leaseId="${leaseId}". Stop the managed process now so the requested finite live-run flow can finish cleanly.`;
}
