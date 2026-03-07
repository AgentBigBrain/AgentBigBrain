/**
 * @fileoverview Shared planner-policy contracts for execution-style, prompt-assembly, and repair flows.
 */

import { PlannedAction, ShellRuntimeProfileV1, TaskRequest } from "../../core/types";
import { Stage685PlaybookPlanningContext } from "../../core/stage6_85PlaybookRuntime";
import { PlannerModelOutput } from "../../models/types";

export const EXECUTION_STYLE_BUILD_PLAN_ISSUE_CODES = [
  "INSPECTION_ONLY_BUILD_PLAN",
  "LIVE_VERIFICATION_ACTION_REQUIRED",
  "BROWSER_VERIFICATION_ACTION_REQUIRED",
  "START_PROCESS_REQUIRES_PROOF_ACTION"
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
  | "start_process"
  | "check_process"
  | "stop_process"
  | "probe_port"
  | "probe_http"
  | "verify_browser"
  | null;

export interface PlannerExecutionEnvironmentContext {
  platform: ShellRuntimeProfileV1["platform"];
  shellKind: ShellRuntimeProfileV1["shellKind"];
  invocationMode: ShellRuntimeProfileV1["invocationMode"];
  commandMaxChars: number;
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
