/**
 * @fileoverview Deterministic explicit-action intent inference and run-skill filtering.
 */

import { PlannedAction } from "../../core/types";
import { RequiredActionType } from "./executionStyleContracts";

const CREATE_SKILL_INTENT_PATTERN =
  /\b(create|generate|make|build|write)\s+(?:a\s+)?skill\b/i;
const RUN_SKILL_EXPLICIT_REQUEST_PATTERN =
  /\b(run|execute|invoke|use)\s+(?:a\s+)?skill\b|\brun[_\s-]?skill\b/i;
const WORKFLOW_RUN_SKILL_REQUEST_PATTERN =
  /\b(workflow|replay|capture|selector\s+drift|browser\s+workflow)\b/i;
const TRACKED_BROWSER_SESSION_CONTEXT_PATTERN = /\bTracked browser sessions:/i;
const NATURAL_ARTIFACT_EDIT_CONTEXT_PATTERN = /\bNatural artifact-edit follow-up:/i;
const NATURAL_CLOSE_BROWSER_FOLLOW_UP_PATTERN =
  /\b(?:close|shut|dismiss|hide)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_OPEN_BROWSER_FOLLOW_UP_PATTERN =
  /\b(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_ARTIFACT_EDIT_REQUEST_PATTERN =
  /\b(?:change|edit|update|replace|swap|revise|tweak|adjust|make)\b[\s\S]{0,80}\b(?:hero|header|homepage|landing page|page|site|slider|cta|call to action|section|image|copy|headline|button)\b/i;
const EXPLICIT_RUNTIME_ACTION_REQUEST_PATTERNS: readonly {
  type: Exclude<RequiredActionType, null>;
  pattern: RegExp;
}[] = [
  {
    type: "inspect_path_holders",
    pattern: /\binspect_path_holders\b|\b(?:use|run|execute)\s+inspect_path_holders\b/i
  },
  {
    type: "inspect_workspace_resources",
    pattern: /\binspect_workspace_resources\b|\b(?:use|run|execute)\s+inspect_workspace_resources\b/i
  },
  {
    type: "verify_browser",
    pattern: /^\s*(?:verify_browser\b|(?:use|run|execute)\s+verify_browser\b)/i
  },
  {
    type: "open_browser",
    pattern: /^\s*(?:open_browser\b|(?:use|run|execute)\s+open_browser\b)/i
  },
  {
    type: "close_browser",
    pattern: /^\s*(?:close_browser\b|(?:use|run|execute)\s+close_browser\b)/i
  },
  {
    type: "probe_http",
    pattern: /^\s*(?:probe_http\b|(?:use|run|execute)\s+probe_http\b)/i
  },
  {
    type: "probe_port",
    pattern: /^\s*(?:probe_port\b|(?:use|run|execute)\s+probe_port\b)/i
  },
  {
    type: "check_process",
    pattern: /^\s*(?:check_process\b|(?:use|run|execute)\s+check_process\b)/i
  },
  {
    type: "stop_process",
    pattern: /^\s*(?:stop_process\b|(?:use|run|execute)\s+stop_process\b)/i
  },
  {
    type: "start_process",
    pattern: /^\s*(?:start_process\b|(?:use|run|execute)\s+start_process\b)/i
  }
] as const;

export type { RequiredActionType } from "./executionStyleContracts";

/**
 * Derives required action type from explicit current-user intent.
 */
export function inferRequiredActionType(
  currentUserRequest: string,
  fullExecutionInput = ""
): RequiredActionType {
  if (CREATE_SKILL_INTENT_PATTERN.test(currentUserRequest)) {
    return "create_skill";
  }
  if (RUN_SKILL_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest)) {
    return "run_skill";
  }
  for (const explicitRuntimeActionRequest of EXPLICIT_RUNTIME_ACTION_REQUEST_PATTERNS) {
    if (explicitRuntimeActionRequest.pattern.test(currentUserRequest)) {
      return explicitRuntimeActionRequest.type;
    }
  }
  if (TRACKED_BROWSER_SESSION_CONTEXT_PATTERN.test(fullExecutionInput)) {
    if (NATURAL_CLOSE_BROWSER_FOLLOW_UP_PATTERN.test(currentUserRequest)) {
      return "close_browser";
    }
    if (NATURAL_OPEN_BROWSER_FOLLOW_UP_PATTERN.test(currentUserRequest)) {
      return "open_browser";
    }
  }
  if (
    NATURAL_ARTIFACT_EDIT_CONTEXT_PATTERN.test(fullExecutionInput) &&
    NATURAL_ARTIFACT_EDIT_REQUEST_PATTERN.test(currentUserRequest)
  ) {
    return "write_file";
  }
  return null;
}

/**
 * Evaluates whether normalized planner actions satisfy the required explicit action.
 */
export function hasRequiredAction(
  actions: PlannedAction[],
  requiredActionType: RequiredActionType
): boolean {
  if (!requiredActionType) {
    return true;
  }

  return actions.some((action) => action.type === requiredActionType);
}

/**
 * Evaluates whether the current request explicitly allows run-skill execution.
 */
export function allowsRunSkillForRequest(currentUserRequest: string): boolean {
  return (
    RUN_SKILL_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest) ||
    WORKFLOW_RUN_SKILL_REQUEST_PATTERN.test(currentUserRequest)
  );
}

/**
 * Removes non-explicit run-skill actions when the user did not actually request one.
 */
export function filterNonExplicitRunSkillActions(
  actions: PlannedAction[],
  currentUserRequest: string
): PlannedAction[] {
  if (allowsRunSkillForRequest(currentUserRequest)) {
    return actions;
  }
  return actions.filter((action) => action.type !== "run_skill");
}

/**
 * Evaluates whether the action list contains only run-skill actions.
 */
export function hasOnlyRunSkillActions(actions: PlannedAction[]): boolean {
  return actions.length > 0 && actions.every((action) => action.type === "run_skill");
}
