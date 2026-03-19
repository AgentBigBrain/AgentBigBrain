/**
 * @fileoverview Canonical governance, execution, and runtime-trace contracts extracted from the shared runtime type surface.
 */

import type { ActionType, ExecutionMode } from "./actionTypes";
import type { GovernorId } from "./governanceTypes";
import type { PlannedAction } from "./taskPlanningTypes";

export const CONSTRAINT_VIOLATION_CODES = [
  "COST_LIMIT_EXCEEDED",
  "CUMULATIVE_COST_LIMIT_EXCEEDED",
  "IMMUTABLE_VIOLATION",
  "DELETE_MISSING_PATH",
  "DELETE_PROTECTED_PATH",
  "DELETE_OUTSIDE_SANDBOX",
  "READ_MISSING_PATH",
  "READ_PROTECTED_PATH",
  "WRITE_MISSING_PATH",
  "WRITE_PROTECTED_PATH",
  "LIST_MISSING_PATH",
  "LIST_PROTECTED_PATH",
  "LIST_OUTSIDE_SANDBOX",
  "CREATE_SKILL_DISABLED",
  "CREATE_SKILL_MISSING_NAME",
  "CREATE_SKILL_INVALID_NAME",
  "CREATE_SKILL_MISSING_CODE",
  "CREATE_SKILL_CODE_TOO_LARGE",
  "RUN_SKILL_MISSING_NAME",
  "RUN_SKILL_INVALID_NAME",
  "RUN_SKILL_ARTIFACT_MISSING",
  "RUN_SKILL_INVALID_EXPORT",
  "RUN_SKILL_LOAD_FAILED",
  "SHELL_DISABLED_BY_POLICY",
  "SHELL_PROFILE_INVALID",
  "SHELL_PROFILE_NOT_SUPPORTED_ON_PLATFORM",
  "SHELL_EXECUTABLE_NOT_FOUND",
  "SHELL_MISSING_COMMAND",
  "SHELL_PROFILE_MISMATCH",
  "SHELL_COMMAND_TOO_LONG",
  "SHELL_TIMEOUT_INVALID",
  "SHELL_CWD_OUTSIDE_SANDBOX",
  "SHELL_DANGEROUS_COMMAND",
  "SHELL_TARGETS_PROTECTED_PATH",
  "PROCESS_DISABLED_BY_POLICY",
  "PROCESS_MISSING_COMMAND",
  "PROCESS_COMMAND_TOO_LONG",
  "PROCESS_PROFILE_MISMATCH",
  "PROCESS_CWD_OUTSIDE_SANDBOX",
  "PROCESS_DANGEROUS_COMMAND",
  "PROCESS_TARGETS_PROTECTED_PATH",
  "PROCESS_MISSING_LEASE_ID",
  "PROCESS_LEASE_NOT_FOUND",
  "PROCESS_START_FAILED",
  "PROCESS_STOP_FAILED",
  "PROCESS_NOT_READY",
  "PROBE_MISSING_PORT",
  "PROBE_PORT_INVALID",
  "PROBE_MISSING_URL",
  "PROBE_URL_INVALID",
  "PROBE_HOST_NOT_LOCAL",
  "PROBE_URL_NOT_LOCAL",
  "PROBE_TIMEOUT_INVALID",
  "BROWSER_VERIFY_MISSING_URL",
  "BROWSER_VERIFY_URL_INVALID",
  "BROWSER_VERIFY_URL_NOT_LOCAL",
  "BROWSER_VERIFY_TIMEOUT_INVALID",
  "BROWSER_SESSION_MISSING_ID",
  "BROWSER_SESSION_NOT_FOUND",
  "BROWSER_SESSION_CONTROL_UNAVAILABLE",
  "BROWSER_VERIFY_RUNTIME_UNAVAILABLE",
  "BROWSER_VERIFY_EXPECTATION_FAILED",
  "BROWSER_VERIFY_FAILED",
  "NETWORK_WRITE_DISABLED",
  "IDENTITY_IMPERSONATION_DENIED",
  "PERSONAL_DATA_APPROVAL_REQUIRED",
  "GOVERNOR_SET_EMPTY",
  "GOVERNANCE_DECISION_MISSING",
  "GLOBAL_DEADLINE_EXCEEDED",
  "MODEL_SPEND_LIMIT_EXCEEDED",
  "MODEL_CALL_LIMIT_EXCEEDED",
  "MISSION_STOP_LIMIT_REACHED",
  "IDEMPOTENCY_KEY_REPLAY_DETECTED",
  "ACTION_ID_DUPLICATE_DETECTED",
  "STATE_STALE_REPLAN_REQUIRED",
  "CONFLICT_OBJECT_UNRESOLVED",
  "APPROVAL_DIFF_HASH_MISMATCH",
  "APPROVAL_EXPIRED",
  "APPROVAL_SCOPE_MISMATCH",
  "APPROVAL_MAX_USES_EXCEEDED",
  "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75",
  "WORKFLOW_DRIFT_DETECTED",
  "ACTION_EXECUTION_FAILED",
  "CREATE_SKILL_NON_EXECUTABLE",
  "CREATE_SKILL_UNSAFE_CODE",
  "MEMORY_MUTATION_BLOCKED",
  "PULSE_BLOCKED",
  "MEMORY_MUTATION_INVALID_STORE",
  "MEMORY_MUTATION_INVALID_OPERATION",
  "MEMORY_MUTATION_MISSING_PAYLOAD",
  "PULSE_EMIT_INVALID_KIND",
  "VERIFICATION_GATE_FAILED",
  "NETWORK_EGRESS_POLICY_BLOCKED",
  "JIT_APPROVAL_REQUIRED"
] as const;

export type ConstraintViolationCode = (typeof CONSTRAINT_VIOLATION_CODES)[number];

const CONSTRAINT_VIOLATION_CODE_SET = new Set<ConstraintViolationCode>(CONSTRAINT_VIOLATION_CODES);

/**
 * Evaluates constraint violation code and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the constraint violation code policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is ConstraintViolationCode` result.
 */
export function isConstraintViolationCode(value: unknown): value is ConstraintViolationCode {
  return (
    typeof value === "string" &&
    CONSTRAINT_VIOLATION_CODE_SET.has(value as ConstraintViolationCode)
  );
}

export interface ConstraintViolation {
  code: ConstraintViolationCode;
  message: string;
}

export type ActionBlockReason = GovernorId | ConstraintViolationCode;

export type GovernorRejectCategory =
  | "ABUSE_MALWARE_OR_FRAUD"
  | "SECURITY_BOUNDARY"
  | "IDENTITY_INTEGRITY"
  | "COMPLIANCE_POLICY"
  | "RESOURCE_BUDGET"
  | "RATIONALE_QUALITY"
  | "UTILITY_ALIGNMENT"
  | "MODEL_ADVISORY_BLOCK"
  | "GOVERNOR_TIMEOUT_OR_FAILURE"
  | "GOVERNOR_MALFORMED_VOTE"
  | "GOVERNOR_MISSING"
  | "OTHER_POLICY";

export interface GovernorVote {
  governorId: GovernorId;
  approve: boolean;
  reason: string;
  confidence: number;
  rejectCategory?: GovernorRejectCategory;
}

export interface MasterDecision {
  approved: boolean;
  yesVotes: number;
  noVotes: number;
  threshold: number;
  dissent: GovernorVote[];
}

export type ManagedProcessLifecycleCode =
  | "PROCESS_STARTED"
  | "PROCESS_READY"
  | "PROCESS_STILL_RUNNING"
  | "PROCESS_STOPPED"
  | "PROCESS_NOT_READY"
  | "PROCESS_START_FAILED"
  | "PROCESS_STOP_FAILED";

export type ExecutorExecutionStatus = "success" | "blocked" | "failed";

export type RuntimeTraceDetailValue = string | number | boolean | null;

export interface ExecutorExecutionOutcome {
  status: ExecutorExecutionStatus;
  output: string;
  failureCode?: ConstraintViolationCode;
  executionMetadata?: Record<string, RuntimeTraceDetailValue>;
}

export interface ActionRunResult {
  action: PlannedAction;
  mode: ExecutionMode;
  approved: boolean;
  output?: string;
  executionStatus?: ExecutorExecutionStatus;
  executionFailureCode?: ConstraintViolationCode;
  executionMetadata?: Record<string, RuntimeTraceDetailValue>;
  blockedBy: ActionBlockReason[];
  violations: ConstraintViolation[];
  votes: GovernorVote[];
  decision?: MasterDecision;
}

export type GovernanceOutcome = "approved" | "blocked";

export type GovernanceBlockCategory = "none" | "constraints" | "governance" | "runtime";

export interface GovernanceMemoryEvent {
  id: string;
  recordedAt: string;
  taskId: string;
  proposalId: string | null;
  actionId: string;
  actionType: ActionType;
  mode: ExecutionMode;
  outcome: GovernanceOutcome;
  blockCategory: GovernanceBlockCategory;
  blockedBy: readonly ActionBlockReason[];
  violationCodes: readonly ConstraintViolationCode[];
  yesVotes: number;
  noVotes: number;
  threshold: number | null;
  dissentGovernorIds: readonly GovernorId[];
}

export interface GovernanceMemoryReadView {
  generatedAt: string;
  totalEvents: number;
  recentEvents: readonly GovernanceMemoryEvent[];
  recentBlockCounts: {
    constraints: number;
    governance: number;
    runtime: number;
  };
  recentGovernorRejectCounts: Partial<Record<GovernorId, number>>;
}

export type RuntimeTraceEventType =
  | "task_started"
  | "planner_completed"
  | "constraint_blocked"
  | "governance_voted"
  | "action_executed"
  | "governance_event_persisted"
  | "task_completed";

export interface RuntimeTraceEvent {
  id: string;
  recordedAt: string;
  eventType: RuntimeTraceEventType;
  taskId: string;
  actionId?: string;
  proposalId?: string;
  governanceEventId?: string;
  mode?: ExecutionMode;
  durationMs?: number;
  details?: Record<string, RuntimeTraceDetailValue>;
}
