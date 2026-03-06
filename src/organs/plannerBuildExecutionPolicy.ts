/**
 * @fileoverview Resolves deterministic execution-style build planning policy for planner prompts, repairs, and guardrails.
 */

import { ActionType, PlannedAction } from "../core/types";
import { classifyRoutingIntentV1 } from "../interfaces/routingMap";

const BUILD_EXECUTION_VERB_PATTERN =
  /\b(create|build|make|generate|scaffold|setup|set up|spin up)\b/i;
const BUILD_EXECUTION_TARGET_PATTERN =
  /\b(app|application|project|dashboard|site|website|frontend|backend|api|cli|repo|repository|react|next\.?js|vue|svelte|angular|vite)\b/i;
const BUILD_EXECUTION_DESTINATION_PATTERN =
  /\bon\s+my\s+(desktop|documents|downloads)\b|\bin\s+['"]?[a-z]:\\|\bin\s+['"]?\/(?:users|home|tmp|var|opt)\//i;
const BUILD_EXPLANATION_ONLY_PATTERN =
  /^\s*(how\s+do\s+i|how\s+to|explain|show\s+me\s+how|tutorial|guide\s+me|what\s+is)\b|\b(without\s+executing|do\s+not\s+execute|don't\s+execute|guidance\s+only|instructions?\s+only)\b/i;
const BUILD_INSPECTION_ONLY_ACTION_TYPES: readonly ActionType[] = [
  "respond",
  "read_file",
  "list_directory",
  "check_process",
  "stop_process"
] as const;
const LIVE_VERIFICATION_ACTION_TYPES: readonly ActionType[] = [
  "start_process",
  "probe_port",
  "probe_http",
  "verify_browser"
] as const;

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

/**
 * Evaluates generic build-execution request and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps execution-style build detection centralized so planner prompt policy, repair behavior, and
 * action guardrails all use the same definition of "this should be executable, not guidance-only."
 *
 * **What it talks to:**
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `../interfaces/routingMap`.
 * - Uses local deterministic lexical patterns within this module.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @returns `true` when the request is an execution-style build goal.
 */
export function isExecutionStyleBuildRequest(currentUserRequest: string): boolean {
  if (BUILD_EXPLANATION_ONLY_PATTERN.test(currentUserRequest)) {
    return false;
  }
  const routingClassification = classifyRoutingIntentV1(currentUserRequest);
  if (routingClassification.category === "BUILD_SCAFFOLD") {
    return true;
  }
  if (!BUILD_EXECUTION_VERB_PATTERN.test(currentUserRequest)) {
    return false;
  }
  if (!BUILD_EXECUTION_TARGET_PATTERN.test(currentUserRequest)) {
    return false;
  }
  return (
    BUILD_EXECUTION_DESTINATION_PATTERN.test(currentUserRequest) ||
    /\bexecute\s+now\b/i.test(currentUserRequest) ||
    /\brun\s+(?:it|commands?)\b/i.test(currentUserRequest)
  );
}

/**
 * Evaluates whether a build request explicitly asks for live-run verification.
 *
 * **Why it exists:**
 * Distinguishes finite scaffold/build proof from long-running dev-server intent so planner policy
 * can allow managed-process actions only when the request actually asks for a live run.
 *
 * **What it talks to:**
 * - Uses `isExecutionStyleBuildRequest` from this module.
 * - Uses local deterministic lexical patterns within this module.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @returns `true` when live verification is explicitly requested.
 */
export function isLiveVerificationBuildRequest(currentUserRequest: string): boolean {
  if (!isExecutionStyleBuildRequest(currentUserRequest)) {
    return false;
  }
  return (
    /\bnpm\s+start\b/i.test(currentUserRequest) ||
    /\bnpm\s+run\s+dev\b/i.test(currentUserRequest) ||
    /\b(?:pnpm|yarn)\s+(?:start|dev)\b/i.test(currentUserRequest) ||
    /\b(?:next|vite)\s+dev\b/i.test(currentUserRequest) ||
    /\bdev\s+server\b/i.test(currentUserRequest) ||
    /\b(run|start|launch|open)\b[\s\S]{0,80}\b(app|site|server|project|frontend)\b/i.test(
      currentUserRequest
    ) ||
    /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i.test(
      currentUserRequest
    ) ||
    /\bopen\b[\s\S]{0,80}\bbrowser\b/i.test(currentUserRequest)
  );
}

/**
 * Evaluates whether a build request explicitly asks for browser/UI proof.
 *
 * **Why it exists:**
 * Distinguishes "prove localhost is up" from "prove the page rendered as expected" so planner
 * prompts can reserve browser verification for genuinely stronger UI-validation requests.
 *
 * **What it talks to:**
 * - Uses `isLiveVerificationBuildRequest` from this module.
 * - Uses local deterministic lexical patterns within this module.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @returns `true` when browser/UI proof is explicitly requested.
 */
export function requiresBrowserVerificationBuildRequest(
  currentUserRequest: string
): boolean {
  if (!isLiveVerificationBuildRequest(currentUserRequest)) {
    return false;
  }
  return (
    /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i.test(
      currentUserRequest
    ) ||
    /\b(open|check|inspect|review)\b[\s\S]{0,80}\b(browser|homepage|ui|page|render|rendering)\b/i.test(
      currentUserRequest
    ) ||
    /\b(screenshot|visual(?:ly)?\s+confirm)\b/i.test(currentUserRequest)
  );
}

/**
 * Evaluates whether planner policy may implicitly allow finite shell work for a build request.
 *
 * **Why it exists:**
 * Lets the planner use finite shell commands for obvious execution-style build flows without
 * forcing the user to say "shell" or "PowerShell" in every prompt, while still keeping non-build
 * shell work behind explicit wording.
 *
 * **What it talks to:**
 * - Uses `isExecutionStyleBuildRequest` from this module.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @returns `true` when finite shell execution may be considered without extra shell-keyword gating.
 */
export function allowsImplicitFiniteShellForBuildRequest(currentUserRequest: string): boolean {
  return isExecutionStyleBuildRequest(currentUserRequest);
}

/**
 * Evaluates whether planner policy may implicitly allow managed live-run process actions.
 *
 * **Why it exists:**
 * Keeps long-running process permission narrower than finite shell work so live sessions only
 * unlock when the request clearly asks to run or verify a live app/server.
 *
 * **What it talks to:**
 * - Uses `isLiveVerificationBuildRequest` from this module.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @returns `true` when managed process actions may be considered without extra shell-keyword gating.
 */
export function allowsImplicitManagedProcessForBuildRequest(
  currentUserRequest: string
): boolean {
  return isLiveVerificationBuildRequest(currentUserRequest);
}

/**
 * Evaluates whether planner output must include executable non-respond actions.
 *
 * **Why it exists:**
 * Prevents execution-style build goals from degrading into guidance-only plans when the user asked
 * the runtime to actually do work in this run.
 *
 * **What it talks to:**
 * - Uses `isExecutionStyleBuildRequest` from this module.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @returns `true` when respond-only output should be rejected and repaired.
 */
export function requiresExecutableBuildPlan(currentUserRequest: string): boolean {
  return isExecutionStyleBuildRequest(currentUserRequest);
}

/**
 * Evaluates whether a normalized action list contains any executable non-respond step.
 *
 * **Why it exists:**
 * Keeps planner repair and fail-closed checks aligned around one deterministic definition of
 * "respond-only" instead of repeating ad hoc action scans at different call sites.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param actions - Normalized planner actions after schema alias cleanup and filtering.
 * @returns `true` when at least one non-respond action is present.
 */
export function hasNonRespondAction(actions: readonly PlannedAction[]): boolean {
  return actions.some((action) => action.type !== "respond");
}

/**
 * Evaluates whether one action is too weak to satisfy an execution-style build goal by itself.
 *
 * **Why it exists:**
 * Keeps inspection-only action classification centralized so planner repair logic can reject plans
 * that merely look around instead of changing state or proving the requested live behavior.
 *
 * **What it talks to:**
 * - Uses local deterministic action-type allowlists within this module.
 *
 * @param action - Normalized planner action being assessed.
 * @returns `true` when the action is inspection-only for execution-style build policy.
 */
function isInspectionOnlyBuildAction(action: PlannedAction): boolean {
  return BUILD_INSPECTION_ONLY_ACTION_TYPES.includes(action.type);
}

/**
 * Evaluates whether one action contributes explicit live-run verification behavior.
 *
 * **Why it exists:**
 * Keeps live-verification action detection deterministic so build requests that ask to run or
 * verify an app do not degrade into mutation-only or inspection-only plans.
 *
 * **What it talks to:**
 * - Uses local deterministic action-type allowlists within this module.
 *
 * @param action - Normalized planner action being assessed.
 * @returns `true` when the action contributes live-run verification behavior.
 */
function isLiveVerificationAction(action: PlannedAction): boolean {
  return LIVE_VERIFICATION_ACTION_TYPES.includes(action.type);
}

/**
 * Evaluates whether a planner action list satisfies deterministic execution-style build quality.
 *
 * **Why it exists:**
 * Prompt guidance alone is too weak to keep the planner from emitting low-value inspection-only
 * plans or omitting required live/browser proof for requests that explicitly ask for it.
 *
 * **What it talks to:**
 * - Uses `isLiveVerificationBuildRequest` from this module.
 * - Uses `requiresBrowserVerificationBuildRequest` from this module.
 * - Uses local action-type classifiers in this module.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @param actions - Normalized planner actions after schema alias cleanup and filtering.
 * @returns Deterministic assessment describing whether the action list is acceptable.
 */
export function assessExecutionStyleBuildPlan(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): ExecutionStyleBuildPlanAssessment {
  if (!requiresExecutableBuildPlan(currentUserRequest)) {
    return {
      valid: true,
      issueCode: null
    };
  }

  if (actions.length === 0 || actions.every((action) => isInspectionOnlyBuildAction(action))) {
    return {
      valid: false,
      issueCode: "INSPECTION_ONLY_BUILD_PLAN"
    };
  }

  if (
    isLiveVerificationBuildRequest(currentUserRequest) &&
    !actions.some((action) => isLiveVerificationAction(action))
  ) {
    return {
      valid: false,
      issueCode: "LIVE_VERIFICATION_ACTION_REQUIRED"
    };
  }

  if (
    requiresBrowserVerificationBuildRequest(currentUserRequest) &&
    !actions.some((action) => action.type === "verify_browser")
  ) {
    return {
      valid: false,
      issueCode: "BROWSER_VERIFICATION_ACTION_REQUIRED"
    };
  }

  if (
    actions.some((action) => action.type === "start_process") &&
    !actions.some(
      (action) =>
        action.type === "probe_port" ||
        action.type === "probe_http" ||
        action.type === "verify_browser"
    )
  ) {
    return {
      valid: false,
      issueCode: "START_PROCESS_REQUIRES_PROOF_ACTION"
    };
  }

  return {
    valid: true,
    issueCode: null
  };
}

/**
 * Resolves a stable human-readable explanation for execution-style build policy failures.
 *
 * **Why it exists:**
 * Keeps planner repair and fail-closed error wording aligned so regressions use consistent
 * language across tests, logs, and operator troubleshooting.
 *
 * **What it talks to:**
 * - Uses local deterministic issue-code mapping within this module.
 *
 * @param issueCode - Deterministic execution-style build issue code.
 * @returns Human-readable explanation string.
 */
export function describeExecutionStyleBuildPlanIssue(
  issueCode: ExecutionStyleBuildPlanIssueCode
): string {
  switch (issueCode) {
    case "INSPECTION_ONLY_BUILD_PLAN":
      return "Planner model returned inspection-only actions for execution-style build request.";
    case "LIVE_VERIFICATION_ACTION_REQUIRED":
      return "Planner model returned no live-verification actions for execution-style live-run request.";
    case "BROWSER_VERIFICATION_ACTION_REQUIRED":
      return "Planner model returned no verify_browser action for explicit browser/UI verification request.";
    case "START_PROCESS_REQUIRES_PROOF_ACTION":
      return "Planner model started a managed process without a readiness or browser proof action in the same plan.";
  }
}

/**
 * Builds execution-style build action requirement guidance for planner prompts.
 *
 * **Why it exists:**
 * Keeps "do not respond-only this request" wording deterministic between first-pass planning and
 * repair prompts so model behavior and regression tests stay aligned.
 *
 * **What it talks to:**
 * - Uses `isLiveVerificationBuildRequest` from this module.
 * - Uses `requiresExecutableBuildPlan` from this module.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @param repairMode - Whether the text is being generated for the repair prompt.
 * @returns Prompt hint text, or an empty string when no build execution requirement applies.
 */
export function buildExecutionStyleRequiredActionHint(
  currentUserRequest: string,
  repairMode = false
): string {
  if (!requiresExecutableBuildPlan(currentUserRequest)) {
    return "";
  }

  const prefix = repairMode
    ? "Repair must include at least one executable non-respond action because the current user request is an execution-style build goal."
    : "Current user request is an execution-style build goal. Include at least one executable non-respond action and do not replace the plan with guidance-only respond output.";
  const concreteExecutionClause =
    " Inspection-only actions such as read_file, list_directory, check_process, or stop_process do not satisfy this requirement by themselves.";
  const liveVerificationClause = isLiveVerificationBuildRequest(currentUserRequest)
    ? " For live verification goals, keep finite proof steps first and include at least one live verification action such as start_process, probe_port, probe_http, or verify_browser."
    : "";
  const browserVerificationClause = requiresBrowserVerificationBuildRequest(currentUserRequest)
    ? " When the request explicitly asks to verify the UI or homepage, include verify_browser after loopback readiness is proven."
    : "";
  return ` ${prefix}${concreteExecutionClause}${liveVerificationClause}${browserVerificationClause}`;
}
