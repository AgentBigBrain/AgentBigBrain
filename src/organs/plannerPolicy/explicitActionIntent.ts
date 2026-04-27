/**
 * @fileoverview Deterministic explicit-action intent inference and run-skill filtering.
 */

import { PlannedAction } from "../../core/types";
import {
  extractExecutionContextPayload,
  extractResolvedRuntimeControlIntent,
  extractResolvedSemanticRouteId
} from "../../core/currentRequestExtraction";
import {
  basenameCrossPlatformPath,
  dirnameCrossPlatformPath,
  normalizeCrossPlatformPath
} from "../../core/crossPlatformPath";
import { requestMatchesRuntimeTargetReference } from "../../core/runtimeTargetReference";
import { RequiredActionType } from "./executionStyleContracts";

const CREATE_SKILL_INTENT_PATTERN =
  /\b(create|generate|make|build|write)\s+(?:a\s+)?skill\b/i;
const RUN_SKILL_EXPLICIT_REQUEST_PATTERN =
  /\b(run|execute|invoke|use)\s+(?:a\s+)?skill\b|\brun[_\s-]?skill\b/i;
const WORKFLOW_RUN_SKILL_REQUEST_PATTERN =
  /\b(workflow|replay|capture|selector\s+drift|browser\s+workflow)\b/i;
const TRACKED_BROWSER_SESSION_CONTEXT_PATTERN = /\bTracked browser sessions:/i;
const TRACKED_WORKSPACE_CONTEXT_PATTERN = /\bCurrent tracked workspace in this chat:/i;
const NATURAL_ARTIFACT_EDIT_CONTEXT_PATTERN = /\bNatural artifact-edit follow-up:/i;
const NATURAL_CLOSE_BROWSER_FOLLOW_UP_PATTERN =
  /\b(?:close|shut|dismiss|hide)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_OPEN_BROWSER_FOLLOW_UP_PATTERN =
  /\b(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_CLOSE_BROWSER_VERB_PATTERN = /\b(?:close|dismiss|hide)\b/i;
const NATURAL_OPEN_BROWSER_VERB_PATTERN =
  /\b(?:reopen|show|bring\s+(?:back|up)|pull\s+up)\b/i;
const NEGATED_NATURAL_OPEN_BROWSER_PATTERN =
  /\b(?:do\s+not|don't|dont|without)\b[\s\S]{0,60}\b(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up|pop)\b[\s\S]{0,60}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const NATURAL_RUNTIME_INSPECTION_VERB_PATTERN =
  /\b(?:inspect|check|verify|confirm|make sure|find out|see if|look at)\b/i;
const NATURAL_RUNTIME_SHUTDOWN_VERB_PATTERN =
  /\b(?:stop|shut\s+down|turn\s+off|kill)\b/i;
const NATURAL_RUNTIME_TARGET_PATTERN =
  /\b(?:still\s+running|running|server|servers|preview(?:\s+stack|\s+server)?|process(?:es)?|localhost|loopback|port|dev\s+server)\b/i;
const NATURAL_ARTIFACT_EDIT_REQUEST_PATTERN =
  /\b(?:change|edit|update|replace|swap|revise|tweak|adjust|make)\b[\s\S]{0,80}\b(?:hero|header|homepage|landing page|page|site|slider|cta|call to action|section|image|copy|headline|button)\b/i;
const TRACKED_BROWSER_PATH_BLOCK_PATTERN =
  /\b(?:Root path|Primary artifact|Preview URL|workspaceRoot|Remembered browser workspace root):\s*([^\n;]+)/gi;
const TRACKED_BROWSER_URL_PATTERN = /\burl=([^\s;]+)/gi;
const QUOTED_RUNTIME_TARGET_PATTERN = /["'`“”]([^"'`“”\n]{3,80})["'`“”]/g;
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

const SEMANTIC_ROUTE_ARTIFACT_EDIT_IDS = new Set([
  "build_request",
  "static_html_build",
  "framework_app_build"
]);

export type { RequiredActionType } from "./executionStyleContracts";

/**
 * Converts route-approved runtime-control metadata to a required planner action.
 *
 * **Why it exists:**
 * Browser/process follow-up requirements should come from typed route metadata before natural
 * wording compatibility checks are considered.
 *
 * **What it talks to:**
 * - Uses `RequiredActionType` (import `RequiredActionType`) from `./executionStyleContracts`.
 *
 * @param runtimeControlIntent - Runtime-control intent extracted from the resolved route block.
 * @returns Required action type, or `null` when the route carries no action requirement.
 */
function toRequiredActionTypeFromRuntimeControlIntent(
  runtimeControlIntent: string | null
): RequiredActionType {
  switch (runtimeControlIntent) {
    case "open_browser":
      return "open_browser";
    case "close_browser":
      return "close_browser";
    case "verify_browser":
      return "verify_browser";
    case "inspect_runtime":
      return "inspect_workspace_resources";
    case "stop_runtime":
      return "stop_process";
    default:
      return null;
  }
}

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
 * Extracts quoted runtime-target names from broader execution input.
 *
 * @param candidates - Mutable candidate-name set accumulated from execution context.
 * @param rawValue - Full execution input or tracked runtime context block.
 */
function pushTrackedNaturalReferenceCandidates(
  candidates: Set<string>,
  rawValue: string | null | undefined
): void {
  if (typeof rawValue !== "string") {
    return;
  }
  for (const match of rawValue.matchAll(QUOTED_RUNTIME_TARGET_PATTERN)) {
    const candidate = match[1]?.trim().toLowerCase();
    if (candidate && candidate.length >= 3) {
      candidates.add(candidate);
    }
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
  const normalizedExecutionInput = extractExecutionContextPayload(fullExecutionInput);
  const candidates = new Set<string>();
  for (const match of normalizedExecutionInput.matchAll(TRACKED_BROWSER_PATH_BLOCK_PATTERN)) {
    pushTrackedBrowserReferenceCandidate(candidates, match[1] ?? null);
  }
  for (const match of normalizedExecutionInput.matchAll(TRACKED_BROWSER_URL_PATTERN)) {
    pushTrackedBrowserReferenceCandidate(candidates, match[1] ?? null);
  }
  pushTrackedNaturalReferenceCandidates(candidates, normalizedExecutionInput);
  return requestMatchesRuntimeTargetReference(currentUserRequest, [...candidates]);
}

/**
 * Evaluates whether the wrapped execution input carries tracked runtime ownership context for one
 * workspace/browser pair from the current chat.
 *
 * @param fullExecutionInput - Full conversation-aware execution input containing tracked context.
 * @returns `true` when tracked runtime context is present.
 */
function hasTrackedRuntimeContext(fullExecutionInput: string): boolean {
  const normalizedExecutionInput = extractExecutionContextPayload(fullExecutionInput);
  return (
    TRACKED_WORKSPACE_CONTEXT_PATTERN.test(normalizedExecutionInput) ||
    TRACKED_BROWSER_SESSION_CONTEXT_PATTERN.test(normalizedExecutionInput)
  );
}

/**
 * Evaluates whether the wrapped execution input carries exact tracked preview-process lease ids.
 *
 * @param fullExecutionInput - Full conversation-aware execution input containing tracked context.
 * @returns `true` when exact tracked preview-process lease ids are present.
 */
function hasTrackedPreviewLeaseContext(fullExecutionInput: string): boolean {
  return /\b(?:Preview process lease|Preview process leases|linkedPreviewLease=|Linked preview process:\s*leaseId=)/i
    .test(extractExecutionContextPayload(fullExecutionInput));
}

/**
 * Derives required action type from explicit current-user intent.
 */
export function inferRequiredActionType(
  currentUserRequest: string,
  fullExecutionInput = ""
): RequiredActionType {
  const resolvedSemanticRouteId = extractResolvedSemanticRouteId(fullExecutionInput);
  const routeRuntimeAction = toRequiredActionTypeFromRuntimeControlIntent(
    extractResolvedRuntimeControlIntent(fullExecutionInput)
  );
  if (routeRuntimeAction) {
    return routeRuntimeAction;
  }
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
  const hasTrackedRuntime = hasTrackedRuntimeContext(fullExecutionInput);
  if (
    hasTrackedRuntime &&
    resolvedSemanticRouteId === null
  ) {
    const suppressesNaturalBrowserOpen =
      NEGATED_NATURAL_OPEN_BROWSER_PATTERN.test(currentUserRequest);
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
      !suppressesNaturalBrowserOpen &&
      (
        NATURAL_OPEN_BROWSER_FOLLOW_UP_PATTERN.test(currentUserRequest) ||
        (
          NATURAL_OPEN_BROWSER_VERB_PATTERN.test(currentUserRequest) &&
          referencesTrackedBrowserTarget
        )
      )
    ) {
      return "open_browser";
    }
    if (
      referencesTrackedBrowserTarget &&
      NATURAL_RUNTIME_INSPECTION_VERB_PATTERN.test(currentUserRequest) &&
      NATURAL_RUNTIME_TARGET_PATTERN.test(currentUserRequest)
    ) {
      return "inspect_workspace_resources";
    }
    if (
      referencesTrackedBrowserTarget &&
      hasTrackedPreviewLeaseContext(fullExecutionInput) &&
      NATURAL_RUNTIME_SHUTDOWN_VERB_PATTERN.test(currentUserRequest) &&
      NATURAL_RUNTIME_TARGET_PATTERN.test(currentUserRequest)
    ) {
      return "stop_process";
    }
  }
  if (
    (
      resolvedSemanticRouteId === null ||
      SEMANTIC_ROUTE_ARTIFACT_EDIT_IDS.has(resolvedSemanticRouteId)
    ) &&
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
