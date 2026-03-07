/**
 * @fileoverview Defines canonical autonomy reason, mission, and live-run contract shapes.
 */

import type { ManagedProcessLifecycleCode } from "../types";

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
  | typeof MISSION_REQUIREMENT_PROCESS_STOP;

export interface MissionCompletionContract {
  executionStyle: boolean;
  requireRealSideEffect: boolean;
  requireTargetPathTouch: boolean;
  requireArtifactMutation: boolean;
  requireReadinessProof: boolean;
  requireBrowserProof: boolean;
  requireProcessStopProof: boolean;
  targetPathHints: string[];
}

export interface MissionEvidenceCounters {
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
