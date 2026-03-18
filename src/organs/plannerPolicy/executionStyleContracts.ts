/**
 * @fileoverview Shared planner-policy contracts for execution-style, prompt-assembly, and repair flows.
 */

import { PlannedAction, ShellRuntimeProfileV1, TaskRequest } from "../../core/types";
import { Stage685PlaybookPlanningContext } from "../../core/stage6_85PlaybookRuntime";
import { PlannerModelOutput } from "../../models/types";

export const EXECUTION_STYLE_BUILD_PLAN_ISSUE_CODES = [
  "INSPECTION_ONLY_BUILD_PLAN",
  "FRAMEWORK_APP_SCAFFOLD_ACTION_REQUIRED",
  "FRAMEWORK_APP_ARTIFACT_CHECK_REQUIRED",
  "FRAMEWORK_APP_IN_PLACE_SCAFFOLD_REQUIRED",
  "FRAMEWORK_APP_NATIVE_PREVIEW_REQUIRED",
  "SHELL_COMMAND_MAX_CHARS_EXCEEDED",
  "LIVE_VERIFICATION_ACTION_REQUIRED",
  "BROWSER_VERIFICATION_ACTION_REQUIRED",
  "START_PROCESS_REQUIRES_PROOF_ACTION",
  "PERSISTENT_BROWSER_OPEN_REQUIRED",
  "OPEN_BROWSER_HTTP_URL_REQUIRED",
  "SHARED_DESKTOP_PATH_DISALLOWED",
  "LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED",
  "LOCAL_ORGANIZATION_PROOF_REQUIRED",
  "LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED",
  "WINDOWS_ORGANIZATION_REQUIRES_POWERSHELL",
  "WINDOWS_ORGANIZATION_INVALID_POWERSHELL_INTERPOLATION",
  "BROAD_PROCESS_SHUTDOWN_DISALLOWED",
  "CANDIDATE_HOLDER_SHUTDOWN_REQUIRES_INSPECTION",
  "WORKSPACE_RECOVERY_RUNTIME_INSPECTION_REQUIRED",
  "WORKSPACE_RECOVERY_EXACT_PATH_INSPECTION_REQUIRED",
  "WORKSPACE_RECOVERY_STOP_OR_MOVE_REQUIRED"
] as const;

export type ExecutionStyleBuildPlanIssueCode =
  (typeof EXECUTION_STYLE_BUILD_PLAN_ISSUE_CODES)[number];

export interface ExecutionStyleBuildPlanAssessment {
  valid: boolean;
  issueCode: ExecutionStyleBuildPlanIssueCode | null;
}

export type RequiredActionType =
  | "create_skill"
  | "run_skill"
  | "write_file"
  | "inspect_path_holders"
  | "inspect_workspace_resources"
  | "start_process"
  | "check_process"
  | "stop_process"
  | "probe_port"
  | "probe_http"
  | "verify_browser"
  | "open_browser"
  | "close_browser"
  | null;

export interface PlannerExecutionEnvironmentContext {
  platform: ShellRuntimeProfileV1["platform"];
  shellKind: ShellRuntimeProfileV1["shellKind"];
  invocationMode: ShellRuntimeProfileV1["invocationMode"];
  commandMaxChars: number;
  desktopPath: string | null;
  documentsPath: string | null;
  downloadsPath: string | null;
}

export interface PlannerPromptBuildInput {
  task: TaskRequest;
  plannerModel: string;
  lessonsText: string;
  firstPrinciplesGuidance: string;
  learningGuidance: string;
  currentUserRequest: string;
  requiredActionType: RequiredActionType;
  playbookSelection: Stage685PlaybookPlanningContext | null;
  executionEnvironment: PlannerExecutionEnvironmentContext;
}

export interface PlannerRepairPromptBuildInput extends PlannerPromptBuildInput {
  previousOutput: PlannerModelOutput;
  repairReason: string;
}

export interface PlannerActionPreparationResult {
  actions: PlannedAction[];
  filteredRunSkillOnly: boolean;
}

export interface PlannerActionValidationResult {
  missingRequiredAction: boolean;
  missingLinkedPreviewStopProcess: boolean;
  missingExecutableAction: boolean;
  invalidExecutionStyleBuildPlan: boolean;
  buildPlanAssessment: ExecutionStyleBuildPlanAssessment;
  needsRepair: boolean;
  repairReason: string | null;
}

export interface RunSkillPostPolicyResult {
  actions: PlannedAction[];
  usedFallback: boolean;
}
