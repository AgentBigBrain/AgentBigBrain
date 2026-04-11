/**
 * @fileoverview Defines canonical autonomy reason, mission, and live-run contract shapes.
 */

import type {
  ActionRunResult,
  ConstraintViolationCode,
  ManagedProcessLifecycleCode,
  RuntimeTraceDetailValue,
  TaskRunResult
} from "../types";

export const EXECUTION_STYLE_GOAL_GATING_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_SIDE_EFFECT_REQUIRED";
export const EXECUTION_STYLE_TARGET_PATH_GATING_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_TARGET_PATH_EVIDENCE_REQUIRED";
export const EXECUTION_STYLE_MUTATION_GATING_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_MUTATION_EVIDENCE_REQUIRED";
export const EXECUTION_STYLE_READINESS_GATING_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_READINESS_EVIDENCE_REQUIRED";
export const EXECUTION_STYLE_BROWSER_GATING_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_BROWSER_EVIDENCE_REQUIRED";
export const EXECUTION_STYLE_BROWSER_OPEN_GATING_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_BROWSER_OPEN_EVIDENCE_REQUIRED";
export const EXECUTION_STYLE_PROCESS_STOP_GATING_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_PROCESS_STOP_EVIDENCE_REQUIRED";
export const EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED";
export const EXECUTION_STYLE_PROCESS_NEVER_READY_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_PROCESS_NEVER_READY";
export const EXECUTION_STYLE_STALL_REASON_CODE =
  "AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT";
export const GENERIC_STALL_REASON_CODE = "AUTONOMOUS_STALLED_ZERO_PROGRESS";
export const MAX_ITERATIONS_REASON_CODE = "AUTONOMOUS_MAX_ITERATIONS_REACHED";
export const EMPTY_NEXT_STEP_REASON_CODE = "AUTONOMOUS_NEXT_STEP_EMPTY";
export const TASK_EXECUTION_FAILED_REASON_CODE = "AUTONOMOUS_TASK_EXECUTION_FAILED";

export const MISSION_REQUIREMENT_SIDE_EFFECT = "REAL_SIDE_EFFECT";
export const MISSION_REQUIREMENT_TARGET_PATH = "TARGET_PATH_TOUCH";
export const MISSION_REQUIREMENT_MUTATION = "ARTIFACT_MUTATION";
export const MISSION_REQUIREMENT_READINESS = "READINESS_PROOF";
export const MISSION_REQUIREMENT_BROWSER = "BROWSER_PROOF";
export const MISSION_REQUIREMENT_BROWSER_OPEN = "BROWSER_OPEN_PROOF";
export const MISSION_REQUIREMENT_PROCESS_STOP = "PROCESS_STOP_PROOF";

export const MAX_MANAGED_PROCESS_READINESS_FAILURES = 3;

export const MANAGED_PROCESS_LIFECYCLE_RUNNING_CODES = [
  "PROCESS_STARTED",
  "PROCESS_READY",
  "PROCESS_STILL_RUNNING"
] as const satisfies readonly ManagedProcessLifecycleCode[];

export const MANAGED_PROCESS_LIFECYCLE_TERMINAL_CODES = [
  "PROCESS_STOPPED",
  "PROCESS_NOT_READY",
  "PROCESS_START_FAILED",
  "PROCESS_STOP_FAILED"
] as const satisfies readonly ManagedProcessLifecycleCode[];

export type AutonomousReasonCode =
  | typeof EXECUTION_STYLE_GOAL_GATING_REASON_CODE
  | typeof EXECUTION_STYLE_TARGET_PATH_GATING_REASON_CODE
  | typeof EXECUTION_STYLE_MUTATION_GATING_REASON_CODE
  | typeof EXECUTION_STYLE_READINESS_GATING_REASON_CODE
  | typeof EXECUTION_STYLE_BROWSER_GATING_REASON_CODE
  | typeof EXECUTION_STYLE_BROWSER_OPEN_GATING_REASON_CODE
  | typeof EXECUTION_STYLE_PROCESS_STOP_GATING_REASON_CODE
  | typeof EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE
  | typeof EXECUTION_STYLE_PROCESS_NEVER_READY_REASON_CODE
  | typeof EXECUTION_STYLE_STALL_REASON_CODE
  | typeof GENERIC_STALL_REASON_CODE
  | typeof MAX_ITERATIONS_REASON_CODE
  | typeof EMPTY_NEXT_STEP_REASON_CODE
  | typeof TASK_EXECUTION_FAILED_REASON_CODE;

export type MissionRequirementId =
  | typeof MISSION_REQUIREMENT_SIDE_EFFECT
  | typeof MISSION_REQUIREMENT_TARGET_PATH
  | typeof MISSION_REQUIREMENT_MUTATION
  | typeof MISSION_REQUIREMENT_READINESS
  | typeof MISSION_REQUIREMENT_BROWSER
  | typeof MISSION_REQUIREMENT_BROWSER_OPEN
  | typeof MISSION_REQUIREMENT_PROCESS_STOP;

export interface MissionCompletionContract {
  executionStyle: boolean;
  requireRealSideEffect: boolean;
  requireTargetPathTouch: boolean;
  requireArtifactMutation: boolean;
  requireReadinessProof: boolean;
  requireBrowserProof: boolean;
  requireBrowserOpenProof: boolean;
  requireProcessStopProof: boolean;
  targetPathHints: string[];
}

export interface MissionEvidenceCounters {
  realSideEffects: number;
  targetPathTouches: number;
  artifactMutations: number;
  readinessProofs: number;
  browserProofs: number;
  browserOpenProofs: number;
  processStopProofs: number;
}

export const RECOVERY_FAILURE_CLASSES = [
  "EXECUTABLE_NOT_FOUND",
  "COMMAND_TOO_LONG",
  "DEPENDENCY_MISSING",
  "VERSION_INCOMPATIBLE",
  "PROCESS_PORT_IN_USE",
  "PROCESS_NOT_READY",
  "TARGET_NOT_RUNNING",
  "AUTH_NOT_INITIALIZED",
  "REMOTE_RATE_LIMITED",
  "REMOTE_UNAVAILABLE",
  "BROWSER_START_BLOCKED",
  "WORKSPACE_HOLDER_CONFLICT",
  "TRANSCRIPTION_BACKEND_UNAVAILABLE",
  "UNKNOWN_EXECUTION_FAILURE"
] as const;

export const RECOVERY_FAILURE_PROVENANCES = [
  "executor_mechanical",
  "runtime_live_run",
  "runtime_connector",
  "planner_shape",
  "governance_or_approval",
  "user_turn_required",
  "unknown"
] as const;

export const RECOVERY_PROOF_GAPS = [
  "REAL_SIDE_EFFECT_MISSING",
  "TARGET_PATH_TOUCH_MISSING",
  "ARTIFACT_MUTATION_MISSING",
  "READINESS_PROOF_MISSING",
  "BROWSER_PROOF_MISSING",
  "BROWSER_OPEN_PROOF_MISSING",
  "PROCESS_STOP_PROOF_MISSING",
  "TARGET_NOT_RUNNING"
] as const;

export const RECOVERY_RUNG_VALUES = [
  "executor_native_adaptation",
  "same_iteration_typed_continuation",
  "bounded_repair_iteration",
  "short_explicit_repair_chain",
  "clarify_or_stop"
] as const;

export type RecoveryFailureClass = (typeof RECOVERY_FAILURE_CLASSES)[number];
export type RecoveryFailureProvenance = (typeof RECOVERY_FAILURE_PROVENANCES)[number];
export type RecoveryProofGap = (typeof RECOVERY_PROOF_GAPS)[number];
export type RecoveryRung = (typeof RECOVERY_RUNG_VALUES)[number];

export interface RecoveryFailureSignal {
  recoveryClass: RecoveryFailureClass;
  provenance: RecoveryFailureProvenance;
  sourceCode: ConstraintViolationCode | null;
  actionType: ActionRunResult["action"]["type"];
  realm: string | null;
  detail: string | null;
}

export interface RecoveryRepairOption {
  optionId: string;
  allowedRung: RecoveryRung;
  budgetHint: string | null;
  detail: string;
}

export interface AutonomousRecoverySnapshot {
  missionStopLimitReached: boolean;
  failureSignals: readonly RecoveryFailureSignal[];
  proofGaps: readonly RecoveryProofGap[];
  repairOptions: readonly RecoveryRepairOption[];
  remainingBudgetHint: string | null;
  environmentFacts: Record<string, RuntimeTraceDetailValue>;
}

/**
 * Detects whether a task result contains one specific block or execution-failure code.
 *
 * **Why it exists:**
 * Recovery and stop-condition logic should read typed runtime state instead of parsing summary
 * prose. Centralizing the block-code scan keeps that policy deterministic across autonomy modules.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param result - Task result to inspect.
 * @param code - Typed constraint or execution-failure code to detect.
 * @returns `true` when the code appears in the task result.
 */
export function hasTaskRunResultBlockCode(
  result: TaskRunResult,
  code: ConstraintViolationCode
): boolean {
  return result.actionResults.some((entry) =>
    entry.executionFailureCode === code ||
    entry.blockedBy.some((blockedCode) => blockedCode === code) ||
    entry.violations.some((violation) => violation.code === code)
  );
}

/**
 * Builds one structured recovery snapshot from the latest task result and mission proof state.
 *
 * **Why it exists:**
 * The autonomous next-step model and stop gates need a compact machine-readable view of recoverable
 * failure state, proof gaps, and safe repair hints. Keeping that derivation in one helper avoids
 * summary-text drift across autonomy modules.
 *
 * **What it talks to:**
 * - Uses local recovery helpers within this module.
 *
 * @param input - Latest task result plus mission proof context.
 * @returns Structured recovery snapshot for autonomy decisions.
 */
export function buildAutonomousRecoverySnapshot(input: {
  result: TaskRunResult;
  missionContract: MissionCompletionContract;
  missingRequirements: readonly MissionRequirementId[];
}): AutonomousRecoverySnapshot {
  const failureSignals = dedupeRecoveryFailureSignals(
    input.result.actionResults
      .map((entry) => resolveRecoveryFailureSignal(entry))
      .filter((entry): entry is RecoveryFailureSignal => entry !== null)
  );
  const proofGaps = resolveRecoveryProofGaps(input.missingRequirements, failureSignals);
  const repairOptions = resolveRecoveryRepairOptions(failureSignals);
  return {
    missionStopLimitReached: hasTaskRunResultBlockCode(
      input.result,
      "MISSION_STOP_LIMIT_REACHED"
    ),
    failureSignals,
    proofGaps,
    repairOptions,
    remainingBudgetHint: resolveRecoveryBudgetHint(failureSignals),
    environmentFacts: resolveRecoveryEnvironmentFacts(input.result, input.missionContract)
  };
}

/** Maps one action result into a native or derived recovery failure signal. */
function resolveRecoveryFailureSignal(
  entry: ActionRunResult
): RecoveryFailureSignal | null {
  const nativeRecoveryClass = readExecutionMetadataString(entry, "recoveryFailureClass");
  const nativeRecoveryProvenance = readExecutionMetadataString(
    entry,
    "recoveryFailureProvenance"
  );
  if (
    isRecoveryFailureClass(nativeRecoveryClass) &&
    isRecoveryFailureProvenance(nativeRecoveryProvenance)
  ) {
    return {
      recoveryClass: nativeRecoveryClass,
      provenance: nativeRecoveryProvenance,
      sourceCode: resolveActionResultFailureCode(entry),
      actionType: entry.action.type,
      realm: resolveRecoveryRealm(entry),
      detail: readExecutionMetadataString(entry, "recoveryFailureDetail")
    };
  }
  const sourceCode = resolveActionResultFailureCode(entry);
  if (sourceCode === "SHELL_EXECUTABLE_NOT_FOUND") {
    return {
      recoveryClass: "EXECUTABLE_NOT_FOUND",
      provenance: "executor_mechanical",
      sourceCode,
      actionType: entry.action.type,
      realm: "shell",
      detail: "The configured shell executable could not be resolved."
    };
  }
  if (sourceCode === "SHELL_COMMAND_TOO_LONG" || sourceCode === "PROCESS_COMMAND_TOO_LONG") {
    return {
      recoveryClass: "COMMAND_TOO_LONG",
      provenance: "executor_mechanical",
      sourceCode,
      actionType: entry.action.type,
      realm: entry.action.type === "start_process" ? "process" : "shell",
      detail: "The command exceeded the runtime command-length budget."
    };
  }
  if (sourceCode === "PROCESS_NOT_READY") {
    return {
      recoveryClass: "PROCESS_NOT_READY",
      provenance: "runtime_live_run",
      sourceCode,
      actionType: entry.action.type,
      realm: "local_runtime",
      detail: "The local target did not become ready in time."
    };
  }
  if (sourceCode === "BROWSER_VERIFY_RUNTIME_UNAVAILABLE") {
    return {
      recoveryClass: "DEPENDENCY_MISSING",
      provenance: "runtime_live_run",
      sourceCode,
      actionType: entry.action.type,
      realm: "browser_verification",
      detail: "The browser verification runtime is unavailable."
    };
  }
  const startupFailureKind =
    typeof entry.executionMetadata?.processStartupFailureKind === "string"
      ? entry.executionMetadata.processStartupFailureKind
      : null;
  if (startupFailureKind === "PORT_IN_USE") {
    return {
      recoveryClass: "PROCESS_PORT_IN_USE",
      provenance: "runtime_live_run",
      sourceCode,
      actionType: entry.action.type,
      realm: "local_runtime",
      detail: "The requested local port was already occupied."
    };
  }
  const lifecycleStatus = readExecutionMetadataString(entry, "processLifecycleStatus");
  if (lifecycleStatus === "PROCESS_STOPPED" && entry.action.type !== "stop_process") {
    return {
      recoveryClass: "TARGET_NOT_RUNNING",
      provenance: "runtime_live_run",
      sourceCode,
      actionType: entry.action.type,
      realm: "local_runtime",
      detail: "The target process stopped before proof was complete."
    };
  }
  return null;
}

/** Returns true when one metadata string matches a known recovery failure class. */
function isRecoveryFailureClass(value: string | null): value is RecoveryFailureClass {
  return value !== null && (RECOVERY_FAILURE_CLASSES as readonly string[]).includes(value);
}

/** Returns true when one metadata string matches a known recovery provenance. */
function isRecoveryFailureProvenance(
  value: string | null
): value is RecoveryFailureProvenance {
  return value !== null && (RECOVERY_FAILURE_PROVENANCES as readonly string[]).includes(value);
}

/** Resolves one coarse realm label for recovery reasoning. */
function resolveRecoveryRealm(entry: ActionRunResult): string | null {
  if (entry.action.type === "shell_command") {
    return "shell";
  }
  if (
    entry.action.type === "start_process" ||
    entry.action.type === "check_process" ||
    entry.action.type === "stop_process" ||
    entry.action.type === "probe_port" ||
    entry.action.type === "probe_http" ||
    entry.action.type === "verify_browser" ||
    entry.action.type === "open_browser" ||
    entry.action.type === "close_browser"
  ) {
    return "local_runtime";
  }
  return null;
}

/** Picks the strongest typed failure code available on one action result. */
function resolveActionResultFailureCode(
  entry: ActionRunResult
): ConstraintViolationCode | null {
  if (entry.executionFailureCode) {
    return entry.executionFailureCode;
  }
  const blockedCode = entry.blockedBy.find(
    (blockedCode): blockedCode is ConstraintViolationCode => typeof blockedCode === "string"
  );
  if (blockedCode) {
    return blockedCode;
  }
  return entry.violations[0]?.code ?? null;
}

/** Reads one trimmed string execution-metadata field from an action result. */
function readExecutionMetadataString(
  entry: ActionRunResult,
  key: string
): string | null {
  const value = entry.executionMetadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Deduplicates ordered recovery signals for compact model input. */
function dedupeRecoveryFailureSignals(
  signals: readonly RecoveryFailureSignal[]
): RecoveryFailureSignal[] {
  const seen = new Set<string>();
  const deduped: RecoveryFailureSignal[] = [];
  for (const signal of signals) {
    const fingerprint = [
      signal.recoveryClass,
      signal.provenance,
      signal.actionType,
      signal.sourceCode ?? "",
      signal.realm ?? ""
    ].join("|");
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    deduped.push(signal);
  }
  return deduped;
}

/** Maps missing mission requirements and failures into explicit proof gaps. */
function resolveRecoveryProofGaps(
  missingRequirements: readonly MissionRequirementId[],
  failureSignals: readonly RecoveryFailureSignal[]
): RecoveryProofGap[] {
  const gaps: RecoveryProofGap[] = [];
  for (const requirement of missingRequirements) {
    switch (requirement) {
      case MISSION_REQUIREMENT_SIDE_EFFECT:
        gaps.push("REAL_SIDE_EFFECT_MISSING");
        break;
      case MISSION_REQUIREMENT_TARGET_PATH:
        gaps.push("TARGET_PATH_TOUCH_MISSING");
        break;
      case MISSION_REQUIREMENT_MUTATION:
        gaps.push("ARTIFACT_MUTATION_MISSING");
        break;
      case MISSION_REQUIREMENT_READINESS:
        gaps.push("READINESS_PROOF_MISSING");
        break;
      case MISSION_REQUIREMENT_BROWSER:
        gaps.push("BROWSER_PROOF_MISSING");
        break;
      case MISSION_REQUIREMENT_BROWSER_OPEN:
        gaps.push("BROWSER_OPEN_PROOF_MISSING");
        break;
      case MISSION_REQUIREMENT_PROCESS_STOP:
        gaps.push("PROCESS_STOP_PROOF_MISSING");
        break;
      default:
        break;
    }
  }
  if (failureSignals.some((signal) => signal.recoveryClass === "TARGET_NOT_RUNNING")) {
    gaps.push("TARGET_NOT_RUNNING");
  }
  return [...new Set(gaps)];
}

/** Builds the bounded repair-option list for the current recovery state. */
function resolveRecoveryRepairOptions(
  failureSignals: readonly RecoveryFailureSignal[]
): RecoveryRepairOption[] {
  const options: RecoveryRepairOption[] = [];
  for (const signal of failureSignals) {
    switch (signal.recoveryClass) {
      case "EXECUTABLE_NOT_FOUND":
        options.push({
          optionId: "resolve_known_executable",
          allowedRung: "executor_native_adaptation",
          budgetHint: "executor_native_only",
          detail: "Retry only if a known executable candidate exists in the current environment."
        });
        break;
      case "COMMAND_TOO_LONG":
        options.push({
          optionId: "stage_command_via_script",
          allowedRung: "executor_native_adaptation",
          budgetHint: "executor_native_only",
          detail: "Stage the command through the runtime temp-script path instead of replanning."
        });
        break;
      case "DEPENDENCY_MISSING":
        options.push({
          optionId: "repair_missing_dependency",
          allowedRung: "bounded_repair_iteration",
          budgetHint: "single_repair_attempt",
          detail: "Install or repair only the deterministically identified missing dependency."
        });
        break;
      case "VERSION_INCOMPATIBLE":
        options.push({
          optionId: "align_dependency_version",
          allowedRung: "bounded_repair_iteration",
          budgetHint: "single_repair_attempt",
          detail: "Adjust only the deterministically identified incompatible dependency version."
        });
        break;
      case "PROCESS_PORT_IN_USE":
        options.push({
          optionId: "retry_with_alternate_port",
          allowedRung: "bounded_repair_iteration",
          budgetHint: "single_repair_attempt",
          detail: "Retry local start and proof on a deterministic alternate loopback port."
        });
        break;
      case "PROCESS_NOT_READY":
        options.push({
          optionId: "retry_readiness_proof",
          allowedRung: "same_iteration_typed_continuation",
          budgetHint: "managed_process_readiness_budget",
          detail: "Retry localhost readiness proof against the tracked running target."
        });
        break;
      case "TARGET_NOT_RUNNING":
        options.push({
          optionId: "restart_target_then_reverify",
          allowedRung: "bounded_repair_iteration",
          budgetHint: "single_repair_attempt",
          detail: "Restart the tracked target and repeat bounded readiness or browser proof."
        });
        break;
      default:
        break;
    }
  }
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.optionId)) {
      return false;
    }
    seen.add(option.optionId);
    return true;
  });
}

/** Collapses the current recovery state into one concise budget hint. */
function resolveRecoveryBudgetHint(
  failureSignals: readonly RecoveryFailureSignal[]
): string | null {
  if (failureSignals.some((signal) => signal.recoveryClass === "PROCESS_NOT_READY")) {
    return "managed_process_readiness_budget";
  }
  if (
    failureSignals.some((signal) =>
      signal.recoveryClass === "PROCESS_PORT_IN_USE" ||
      signal.recoveryClass === "TARGET_NOT_RUNNING" ||
      signal.recoveryClass === "DEPENDENCY_MISSING" ||
      signal.recoveryClass === "VERSION_INCOMPATIBLE"
    )
  ) {
    return "single_repair_attempt";
  }
  if (
    failureSignals.some((signal) =>
      signal.recoveryClass === "EXECUTABLE_NOT_FOUND" ||
      signal.recoveryClass === "COMMAND_TOO_LONG"
    )
  ) {
    return "executor_native_only";
  }
  return null;
}

/** Builds a compact environment-facts bag for recovery decisions. */
function resolveRecoveryEnvironmentFacts(
  result: TaskRunResult,
  missionContract: MissionCompletionContract
): Record<string, RuntimeTraceDetailValue> {
  const observedTargetUrl =
    result.actionResults
      .map((entry) =>
        readExecutionMetadataString(entry, "processRequestedUrl") ??
        readExecutionMetadataString(entry, "probeUrl") ??
        readExecutionMetadataString(entry, "browserVerifyUrl")
      )
      .find((value): value is string => value !== null) ?? null;
  return {
    managedProcessSeen: result.actionResults.some(
      (entry) => entry.executionMetadata?.managedProcess === true
    ),
    connectorObserved: result.actionResults.some(
      (entry) => typeof entry.executionMetadata?.stage675Connector === "string"
    ),
    readinessRequired: missionContract.requireReadinessProof,
    browserProofRequired: missionContract.requireBrowserProof,
    browserOpenRequired: missionContract.requireBrowserOpenProof,
    processStopRequired: missionContract.requireProcessStopProof,
    observedTargetUrl
  };
}

/**
 * Formats reason text with deterministic reason-code metadata.
 *
 * **Why it exists:**
 * The autonomous loop, interfaces, and tests all need one stable prefix shape for machine-readable
 * diagnostics. Centralizing it prevents ad hoc formatting drift.
 *
 * **What it talks to:**
 * - Uses local autonomy contract constants within this module.
 *
 * @param reasonCode - Stable reason code for machine-readable diagnostics.
 * @param message - Human-readable reason detail.
 * @returns Reason string with deterministic reason-code prefix.
 */
export function formatReasonWithCode(reasonCode: AutonomousReasonCode, message: string): string {
  return `[reasonCode=${reasonCode}] ${message}`;
}
