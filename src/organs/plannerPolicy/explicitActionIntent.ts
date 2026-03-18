/**
 * @fileoverview Deterministic explicit-action intent inference and run-skill filtering.
 */

import { PlannedAction } from "../../core/types";
import {
  basenameCrossPlatformPath,
  dirnameCrossPlatformPath,
  normalizeCrossPlatformPath
} from "../../core/crossPlatformPath";
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
const NATURAL_CLOSE_BROWSER_VERB_PATTERN = /\b(?:close|shut|dismiss|hide)\b/i;
const NATURAL_OPEN_BROWSER_VERB_PATTERN =
  /\b(?:reopen|show|bring\s+(?:back|up)|pull\s+up)\b/i;
const NATURAL_ARTIFACT_EDIT_REQUEST_PATTERN =
  /\b(?:change|edit|update|replace|swap|revise|tweak|adjust|make)\b[\s\S]{0,80}\b(?:hero|header|homepage|landing page|page|site|slider|cta|call to action|section|image|copy|headline|button)\b/i;
const TRACKED_BROWSER_PATH_BLOCK_PATTERN =
  /\b(?:Root path|Primary artifact|Preview URL|workspaceRoot|Remembered browser workspace root):\s*([^\n;]+)/gi;
const TRACKED_BROWSER_URL_PATTERN = /\burl=([^\s;]+)/gi;
const GENERIC_BROWSER_WORKSPACE_SEGMENT_NAMES = new Set([
  "dist",
  "build",
  "out",
  "public",
  "site",
  "app"
]);
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
 * Extracts stable workspace/app names from tracked browser path context embedded in execution input.
 *
 * @param candidates - Mutable candidate-name set accumulated from tracked browser context.
 * @param rawValue - Raw path or URL-derived location text extracted from execution input.
 */
function pushTrackedBrowserReferenceCandidate(
  candidates: Set<string>,
  rawValue: string | null | undefined
): void {
  if (typeof rawValue !== "string") {
    return;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return;
  }
  const normalizedPath = normalizeCrossPlatformPath(
    trimmed.replace(/^file:\/\/\/?/i, "").replace(/\?.*$/, "")
  );
  const basename = basenameCrossPlatformPath(normalizedPath);
  const parentBasename = basenameCrossPlatformPath(
    dirnameCrossPlatformPath(normalizedPath)
  );
  const addCandidate = (value: string | null | undefined): void => {
    if (typeof value !== "string") {
      return;
    }
    const candidate = value.trim().replace(/\.[a-z0-9]{1,8}$/i, "");
    if (candidate.length >= 3) {
      candidates.add(candidate.toLowerCase());
    }
  };

  addCandidate(basename);
  if (
    basename &&
    GENERIC_BROWSER_WORKSPACE_SEGMENT_NAMES.has(basename.toLowerCase()) &&
    parentBasename
  ) {
    addCandidate(parentBasename);
  }
}

/**
 * Evaluates whether the current request refers to the tracked browser target by workspace/app name.
 *
 * @param currentUserRequest - Current natural-language user request.
 * @param fullExecutionInput - Full conversation-aware execution input containing tracked browser context.
 * @returns `true` when the request names the tracked browser target.
 */
function currentUserRequestReferencesTrackedBrowserTarget(
  currentUserRequest: string,
  fullExecutionInput: string
): boolean {
  const candidates = new Set<string>();
  for (const match of fullExecutionInput.matchAll(TRACKED_BROWSER_PATH_BLOCK_PATTERN)) {
    pushTrackedBrowserReferenceCandidate(candidates, match[1] ?? null);
  }
  for (const match of fullExecutionInput.matchAll(TRACKED_BROWSER_URL_PATTERN)) {
    pushTrackedBrowserReferenceCandidate(candidates, match[1] ?? null);
  }
  const normalizedRequest = currentUserRequest.toLowerCase();
  return [...candidates].some((candidate) => normalizedRequest.includes(candidate));
}

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
    const referencesTrackedBrowserTarget = currentUserRequestReferencesTrackedBrowserTarget(
      currentUserRequest,
      fullExecutionInput
    );
    if (
      NATURAL_CLOSE_BROWSER_FOLLOW_UP_PATTERN.test(currentUserRequest) ||
      (
        NATURAL_CLOSE_BROWSER_VERB_PATTERN.test(currentUserRequest) &&
        referencesTrackedBrowserTarget
      )
    ) {
      return "close_browser";
    }
    if (
      NATURAL_OPEN_BROWSER_FOLLOW_UP_PATTERN.test(currentUserRequest) ||
      (
        NATURAL_OPEN_BROWSER_VERB_PATTERN.test(currentUserRequest) &&
        referencesTrackedBrowserTarget
      )
    ) {
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
