/**
 * @fileoverview Deterministic request classification for execution-style and live-verification planner policy.
 */

import { classifyRoutingIntentV1 } from "../../interfaces/routingMap";
import { extractSemanticRequestSegment } from "../../core/currentRequestExtraction";
import { parseExplicitExecutionConstraints } from "../../core/explicitExecutionConstraints";
import { extractRequestedFrameworkFolderName } from "./frameworkBuildActionHeuristics";
import { hasNamedWorkspaceLaunchOpenIntent } from "./namedWorkspaceLaunchSupport";
import {
  isResolvedExecutionStyleBuildRoute,
  isResolvedFrameworkBuildRoute,
  isResolvedStaticHtmlBuildRoute
} from "./liveVerificationSemanticRouteSupport";
const BUILD_EXECUTION_VERB_PATTERN =
  /\b(create|build|make|generate|scaffold|setup|set up|spin up|run|start|launch|fix|repair|finish|complete|implement|continue)\b/i;
const BUILD_EXECUTION_TARGET_PATTERN =
  /\b(app|application|project|dashboard|site|website|landing\s+page|homepage|web\s+page|page|frontend|backend|api|cli|repo|repository|react|next\.?js|vue|svelte|angular|vite)\b/i;
const BUILD_EXECUTION_DESTINATION_PATTERN =
  /\b(?:on|to)\s+(?:my|the)\s+(desktop|documents|downloads)\b|\b(?:in|inside|at|under|from|go\s+to)\s+(?:the\s+)?['"]?[a-z]:\\|\b(?:in|inside|at|under|from|go\s+to)\s+(?:the\s+)?['"]?\/(?:users|home|tmp|var|opt)\//i;
const LOCAL_WORKSPACE_ORGANIZATION_VERB_PATTERN =
  /\b(?:organize|group|sort|move|collect|gather|tidy|clean\s+up)\b/i;
const LOCAL_WORKSPACE_ORGANIZATION_TARGET_PATTERN =
  /\b(?:folder|folders|directory|directories|project|projects|workspace|workspaces|files)\b/i;
const LOCAL_WORKSPACE_ORGANIZATION_DESTINATION_PATTERN =
  /\b(?:into|in(?:to)?|under)\s+(?:a\s+)?folder\s+called\b|\bcreate\s+a\s+folder\s+called\b/i;
const LOCAL_WORKSPACE_ORGANIZATION_USER_OWNED_LOCATION_PATTERN =
  /\bmy\s+(desktop|documents|downloads)\b/i;
const LOCAL_WORKSPACE_ORGANIZATION_IMPLICIT_MOVE_PATTERN =
  /\b(?:every|all)\s+(?:folder|folders|directory|directories|project|projects|workspace|workspaces|files)\b[\s\S]{0,80}\b(?:go|belongs?)\b[\s\S]{0,20}\b(?:in|into|under)\b/i;
const LOCAL_WORKSPACE_ORGANIZATION_REFERENCE_PATTERN =
  /\b(?:you\s+made\s+earlier|made\s+earlier|from\s+earlier|earlier|same\s+place|same\s+folder|existing)\b/i;
const BUILD_EXPLANATION_ONLY_PATTERN =
  /^\s*(how\s+do\s+i|how\s+to|explain|show\s+me\s+how|tutorial|guide\s+me|what\s+is)\b|\b(without\s+executing|do\s+not\s+execute|don't\s+execute|guidance\s+only|instructions?\s+only)\b/i;
const NATURAL_BROWSER_CONTROL_FOLLOW_UP_PATTERN =
  /^\s*(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up|close|shut|dismiss|hide)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const FRAMEWORK_APP_REQUEST_PATTERN =
  /\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i;
const STATIC_HTML_BUILD_LANE_PATTERN =
  /\bExecution lane:\s*static_html_build\b/i;
const STATIC_HTML_BUILD_FORMAT_RESOLVED_PATTERN =
  /(?:^|\n)Build format resolved:\s*create a plain static HTML deliverable\b/i;
const EXPLICIT_STATIC_HTML_REQUEST_PATTERN =
  /\b(?:static\s+single[- ]page|single[- ]file\s+html|single[- ]page\s+site|single[- ]page\s+html|plain\s+html|static\s+html)\b/i;
const EXPLICIT_INDEX_HTML_ENTRY_PATTERN =
  /\bindex\.html\b/i;
const NEGATED_FRAMEWORK_SCAFFOLD_PATTERN =
  /\bdo\s+not\s+(?:scaffold|use|create|build\s+with|generate\s+with|start\s+with)\b[\s\S]{0,80}\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i;
const FRAMEWORK_APP_BOOTSTRAP_CUE_PATTERN =
  /\b(?:create|make|generate|scaffold|bootstrap|spin\s+up|set\s+up|setup|get\b[\s\S]{0,24}\bstarted|from\s+scratch|fresh|new)\b/i;
const FRAMEWORK_APP_NAMED_WORKSPACE_CUE_PATTERN =
  /\b(?:called|named|folder\s+called|project\s+called|workspace\s+called)\b/i;
const FRAMEWORK_APP_SCAFFOLD_CONTINUATION_PATTERN =
  /\bscaffold(?:ed|ing)\b|agentbigbrain-framework-scaffold/i;
const FRAMEWORK_WORKSPACE_PREPARATION_PATTERN =
  /\b(?:workspace|ready\s+for\s+edits|dependencies\s+installed|stop\s+after\s+the\s+workspace\s+is\s+ready|do\s+not\s+run\b|do\s+not\s+open\b|don't\s+run\b|don't\s+open\b)\b/i;
const FRAMEWORK_BUILD_LIFECYCLE_BUILD_PATTERN =
  /\b(?:turn\s+that|make|build|finish|complete|implement)\b[\s\S]{0,120}\b(?:landing\s+page|homepage|page|site|app|workspace|project)\b/i;
const FRAMEWORK_BUILD_LIFECYCLE_PREVIEW_PATTERN =
  /\b(?:start|launch|serve|preview)\b[\s\S]{0,120}\b(?:localhost|127\.0\.0\.1|::1|loopback|preview|server|host|port|page|site|app)\b|\b(?:localhost|127\.0\.0\.1|::1|loopback|preview|server|host|port)\b[\s\S]{0,120}\b(?:start|launch|serve|preview|running|ready)\b/i;
const FRAMEWORK_BUILD_LIFECYCLE_OPEN_PATTERN =
  /\b(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up)\b[\s\S]{0,120}\b(?:browser|tab|window|preview|landing\s+page|homepage|page|site|app)\b/i;
const FRAMEWORK_BUILD_LIFECYCLE_EDIT_PATTERN =
  /\b(?:change|edit|tweak|update|replace|rewrite|refresh)\b[\s\S]{0,120}\b(?:section|heading|hero|footer|copy|text|cta|button|content|page)\b/i;
const FRAMEWORK_BUILD_LIFECYCLE_CLOSE_PATTERN =
  /^\s*(?:(?:thanks|thank you|ok|okay|alright|all right|now)[\s,!.:-]+)*(?:please\s+)?(?:close|shut|stop|dismiss|hide)\b/i;
const NEGATED_LIVE_RUN_PATTERN =
  /\bdo\s+not\s+(?:probe|check|confirm|verify)\b[\s\S]{0,80}\b(?:localhost|127\.0\.0\.1|::1|loopback|http|port|ready|readiness)\b/i;
const NEGATED_BROWSER_VERIFICATION_PATTERN =
  /\bdo\s+not\s+(?:(?:open|reopen)\s+or\s+)?(?:verify|check|inspect|review)\b[\s\S]{0,80}\b(?:browser|homepage|ui|page|render|renders|rendering)\b/i;
const NATURAL_LOCAL_START_PATTERN =
  /\b(?:start|launch|run)\b[\s\S]{0,32}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\b(?:locally|local)\b/i;
const NATURAL_BROWSER_OPEN_PATTERN =
  /\bopen\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bin\s+my\s+browser\b/i;
const NATURAL_BROWSER_LEAVE_UP_PATTERN =
  /\bleave\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bup\b[\s\S]{0,24}\b(?:for me to|so i can)\s+(?:see|view|look)\b/i;
const RUNTIME_PROCESS_MANAGEMENT_VERB_PATTERN =
  /\b(?:inspect|check|verify|confirm|make sure|find out|see if|look at|stop|shut\s+down|turn\s+off|kill)\b/i;
const RUNTIME_PROCESS_MANAGEMENT_TARGET_PATTERN =
  /\b(?:still\s+running|running|server|servers|preview(?:\s+stack|\s+server)?|process(?:es)?|localhost|loopback|port|dev\s+server)\b/i;
const LIVE_VERIFICATION_REQUEST_PATTERNS: readonly RegExp[] = [
  /\bnpm\s+start\b/i,
  /\bnpm\s+run\s+dev\b/i,
  /\b(?:pnpm|yarn)\s+(?:start|dev)\b/i,
  /\b(?:next|vite)\s+dev\b/i,
  NATURAL_LOCAL_START_PATTERN,
  /\bdev\s+server\b/i,
  /\b(localhost|127\.0\.0\.1|::1|loopback)\b/i,
  /\b(run|start|launch|serve)\b[\s\S]{0,80}\b(server|service|api|backend|dev\s+server)\b/i,
  /\b(?:probe|check|confirm|wait\s+until)\b[\s\S]{0,80}\b(?:localhost|http|port|ready|readiness)\b/i,
  /\b(?:tell\s+me|let\s+me\s+know|confirm)\b[\s\S]{0,24}\bif\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bworked\b/i,
  /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i,
  /\b(playwright|screenshot|visual(?:ly)?\s+confirm)\b/i
];
const BROWSER_VERIFICATION_REQUEST_PATTERNS: readonly RegExp[] = [
  /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i,
  /\b(check|inspect|review)\b[\s\S]{0,80}\b(browser|homepage|ui|page|render|rendering)\b/i,
  /\b(screenshot|visual(?:ly)?\s+confirm)\b/i
];
const PERSISTENT_BROWSER_OPEN_REQUEST_PATTERNS: readonly RegExp[] = [
  /\bleave\b[\s\S]{0,40}\b(browser|page|site|window|it)\b[\s\S]{0,20}\bopen\b/i,
  NATURAL_BROWSER_OPEN_PATTERN,
  NATURAL_BROWSER_LEAVE_UP_PATTERN,
  /\bkeep\b[\s\S]{0,40}\b(browser|page|site|window|it)\b[\s\S]{0,20}\bopen\b/i,
  /\blet me (?:see|view)\b/i,
  /\bso i can (?:see|view)\b/i
];

/**
 * Evaluates whether request matches one named intent pattern set.
 *
 * **Why it exists:**
 * Keeps dense regex groups centralized so classifier functions read as policy decisions instead
 * of scattered lexical implementation details.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param activeRequest - Input consumed by this helper.
 * @param patterns - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesAnyRequestPattern(
  activeRequest: string,
  patterns: readonly RegExp[]
): boolean {
  return patterns.some((pattern) => pattern.test(activeRequest));
}

/**
 * Normalizes active request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `extractSemanticRequestSegment` (import `extractSemanticRequestSegment`) from `../../core/currentRequestExtraction`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeActiveRequest(currentUserRequest: string): string {
  return extractSemanticRequestSegment(currentUserRequest).trim();
}
/**
 * Evaluates whether framework scaffold lane.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function suppressesFrameworkScaffoldLane(currentUserRequest: string): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (!NEGATED_FRAMEWORK_SCAFFOLD_PATTERN.test(activeRequest)) {
    return false;
  }
  return (
    EXPLICIT_STATIC_HTML_REQUEST_PATTERN.test(activeRequest) ||
    EXPLICIT_INDEX_HTML_ENTRY_PATTERN.test(activeRequest)
  );
}
/**
 * Evaluates whether static html execution style request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `isResolvedFrameworkBuildRoute` (import `isResolvedFrameworkBuildRoute`) from `./liveVerificationSemanticRouteSupport`.
 * - Uses `isResolvedStaticHtmlBuildRoute` (import `isResolvedStaticHtmlBuildRoute`) from `./liveVerificationSemanticRouteSupport`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isStaticHtmlExecutionStyleRequest(
  currentUserRequest: string
): boolean {
  if (isResolvedStaticHtmlBuildRoute(currentUserRequest)) {
    return true;
  }
  if (isResolvedFrameworkBuildRoute(currentUserRequest)) {
    return false;
  }
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (!isExecutionStyleBuildRequest(activeRequest)) {
    return false;
  }
  if (requiresFrameworkAppScaffoldAction(activeRequest)) {
    return false;
  }
  return (
    EXPLICIT_STATIC_HTML_REQUEST_PATTERN.test(activeRequest) ||
    EXPLICIT_INDEX_HTML_ENTRY_PATTERN.test(activeRequest) ||
    suppressesFrameworkScaffoldLane(activeRequest)
  );
}
/**
 * Evaluates whether runtime process management request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isRuntimeProcessManagementRequest(
  currentUserRequest: string
): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  const hasFrameworkBuildCues =
    FRAMEWORK_APP_REQUEST_PATTERN.test(activeRequest) &&
    (
      FRAMEWORK_APP_BOOTSTRAP_CUE_PATTERN.test(activeRequest) ||
      FRAMEWORK_APP_NAMED_WORKSPACE_CUE_PATTERN.test(activeRequest) ||
      FRAMEWORK_APP_SCAFFOLD_CONTINUATION_PATTERN.test(activeRequest) ||
      FRAMEWORK_BUILD_LIFECYCLE_BUILD_PATTERN.test(activeRequest) ||
      FRAMEWORK_BUILD_LIFECYCLE_PREVIEW_PATTERN.test(activeRequest) ||
      FRAMEWORK_BUILD_LIFECYCLE_OPEN_PATTERN.test(activeRequest) ||
      FRAMEWORK_BUILD_LIFECYCLE_EDIT_PATTERN.test(activeRequest)
    );
  return (
    RUNTIME_PROCESS_MANAGEMENT_VERB_PATTERN.test(activeRequest) &&
    RUNTIME_PROCESS_MANAGEMENT_TARGET_PATTERN.test(activeRequest) &&
    !hasFrameworkBuildCues
  );
}
/**
 * Evaluates whether live run work.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `parseExplicitExecutionConstraints` (import `parseExplicitExecutionConstraints`) from `../../core/explicitExecutionConstraints`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function suppressesLiveRunWork(currentUserRequest: string): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  const explicitConstraints = parseExplicitExecutionConstraints(activeRequest);
  return (
    explicitConstraints.disallowPreviewStart ||
    NEGATED_LIVE_RUN_PATTERN.test(activeRequest)
  );
}
/**
 * Evaluates whether browser verification.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `parseExplicitExecutionConstraints` (import `parseExplicitExecutionConstraints`) from `../../core/explicitExecutionConstraints`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function suppressesBrowserVerification(currentUserRequest: string): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  const explicitConstraints = parseExplicitExecutionConstraints(activeRequest);
  return (
    explicitConstraints.disallowVisibleBrowserOpen ||
    NEGATED_BROWSER_VERIFICATION_PATTERN.test(activeRequest)
  );
}
/**
 * Evaluates whether browser open.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `parseExplicitExecutionConstraints` (import `parseExplicitExecutionConstraints`) from `../../core/explicitExecutionConstraints`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function suppressesBrowserOpen(currentUserRequest: string): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  return parseExplicitExecutionConstraints(activeRequest).disallowVisibleBrowserOpen;
}
/**
 * Evaluates whether browser control follow up request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isBrowserControlFollowUpRequest(currentUserRequest: string): boolean {
  return NATURAL_BROWSER_CONTROL_FOLLOW_UP_PATTERN.test(
    normalizeActiveRequest(currentUserRequest)
  );
}
/**
 * Evaluates whether execution style build request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `../../interfaces/routingMap`.
 * - Uses `isResolvedExecutionStyleBuildRoute` (import `isResolvedExecutionStyleBuildRoute`) from `./liveVerificationSemanticRouteSupport`.
 * - Uses `hasNamedWorkspaceLaunchOpenIntent` (import `hasNamedWorkspaceLaunchOpenIntent`) from `./namedWorkspaceLaunchSupport`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isExecutionStyleBuildRequest(currentUserRequest: string): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (BUILD_EXPLANATION_ONLY_PATTERN.test(activeRequest)) {
    return false;
  }
  if (isRuntimeProcessManagementRequest(activeRequest)) {
    return false;
  }
  if (isBrowserControlFollowUpRequest(activeRequest)) {
    return false;
  }
  if (isResolvedExecutionStyleBuildRoute(currentUserRequest)) {
    return true;
  }
  if (hasNamedWorkspaceLaunchOpenIntent(activeRequest)) {
    return true;
  }
  const routingClassification = classifyRoutingIntentV1(activeRequest);
  if (routingClassification.category === "BUILD_SCAFFOLD") {
    return true;
  }
  if (!BUILD_EXECUTION_VERB_PATTERN.test(activeRequest)) {
    return false;
  }
  if (!BUILD_EXECUTION_TARGET_PATTERN.test(activeRequest)) {
    return false;
  }
  return (
    BUILD_EXECUTION_DESTINATION_PATTERN.test(activeRequest) ||
    /\bexecute\s+now\b/i.test(activeRequest) ||
    /\brun\s+(?:it|commands?)\b/i.test(activeRequest)
  );
}
/**
 * Evaluates whether framework app scaffold action.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `isResolvedFrameworkBuildRoute` (import `isResolvedFrameworkBuildRoute`) from `./liveVerificationSemanticRouteSupport`.
 * - Uses `isResolvedStaticHtmlBuildRoute` (import `isResolvedStaticHtmlBuildRoute`) from `./liveVerificationSemanticRouteSupport`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function requiresFrameworkAppScaffoldAction(
  currentUserRequest: string
): boolean {
  if (isResolvedFrameworkBuildRoute(currentUserRequest)) {
    return true;
  }
  if (isResolvedStaticHtmlBuildRoute(currentUserRequest)) {
    return false;
  }
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (suppressesFrameworkScaffoldLane(activeRequest)) {
    return false;
  }
  return (
    isExecutionStyleBuildRequest(activeRequest) &&
    FRAMEWORK_APP_REQUEST_PATTERN.test(activeRequest) &&
    (
      FRAMEWORK_APP_BOOTSTRAP_CUE_PATTERN.test(activeRequest) ||
      FRAMEWORK_APP_NAMED_WORKSPACE_CUE_PATTERN.test(activeRequest) ||
      FRAMEWORK_APP_SCAFFOLD_CONTINUATION_PATTERN.test(activeRequest)
    )
  );
}
/**
 * Evaluates whether framework workspace preparation request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `isResolvedFrameworkBuildRoute` (import `isResolvedFrameworkBuildRoute`) from `./liveVerificationSemanticRouteSupport`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isFrameworkWorkspacePreparationRequest(
  currentUserRequest: string
): boolean {
  if (!isResolvedFrameworkBuildRoute(currentUserRequest)) {
    const activeRequest = normalizeActiveRequest(currentUserRequest);
    return (
      requiresFrameworkAppScaffoldAction(activeRequest) &&
      !isLiveVerificationBuildRequest(activeRequest) &&
      !requiresBrowserVerificationBuildRequest(activeRequest) &&
      !requiresPersistentBrowserOpenBuildRequest(activeRequest) &&
      FRAMEWORK_WORKSPACE_PREPARATION_PATTERN.test(activeRequest)
    );
  }
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  return (
    requiresFrameworkAppScaffoldAction(currentUserRequest) &&
    !isLiveVerificationBuildRequest(activeRequest) &&
    !requiresBrowserVerificationBuildRequest(activeRequest) &&
    !requiresPersistentBrowserOpenBuildRequest(activeRequest) &&
    FRAMEWORK_WORKSPACE_PREPARATION_PATTERN.test(activeRequest)
  );
}
/**
 * Evaluates whether deterministic framework build lane request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `extractRequestedFrameworkFolderName` (import `extractRequestedFrameworkFolderName`) from `./frameworkBuildActionHeuristics`.
 * - Uses `isResolvedFrameworkBuildRoute` (import `isResolvedFrameworkBuildRoute`) from `./liveVerificationSemanticRouteSupport`.
 * - Uses `isResolvedStaticHtmlBuildRoute` (import `isResolvedStaticHtmlBuildRoute`) from `./liveVerificationSemanticRouteSupport`.
 * - Uses `hasNamedWorkspaceLaunchOpenIntent` (import `hasNamedWorkspaceLaunchOpenIntent`) from `./namedWorkspaceLaunchSupport`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isDeterministicFrameworkBuildLaneRequest(
  currentUserRequest: string
): boolean {
  if (isResolvedFrameworkBuildRoute(currentUserRequest)) {
    return true;
  }
  if (isResolvedStaticHtmlBuildRoute(currentUserRequest)) {
    return false;
  }
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (suppressesFrameworkScaffoldLane(activeRequest)) {
    return false;
  }
  if (FRAMEWORK_BUILD_LIFECYCLE_CLOSE_PATTERN.test(activeRequest)) {
    return false;
  }
  if (isRuntimeProcessManagementRequest(activeRequest)) {
    return false;
  }
  if (
    STATIC_HTML_BUILD_LANE_PATTERN.test(currentUserRequest) ||
    STATIC_HTML_BUILD_FORMAT_RESOLVED_PATTERN.test(currentUserRequest) ||
    isStaticHtmlExecutionStyleRequest(activeRequest)
  ) {
    return false;
  }
  const hasNamedWorkspaceLaunchFollowUp =
    hasNamedWorkspaceLaunchOpenIntent(activeRequest) ||
    (
      extractRequestedFrameworkFolderName(activeRequest) !== null &&
      BUILD_EXECUTION_DESTINATION_PATTERN.test(activeRequest) &&
      (
        FRAMEWORK_BUILD_LIFECYCLE_PREVIEW_PATTERN.test(activeRequest) ||
        FRAMEWORK_BUILD_LIFECYCLE_OPEN_PATTERN.test(activeRequest)
      )
    );
  return (
    requiresFrameworkAppScaffoldAction(activeRequest) ||
    isFrameworkWorkspacePreparationRequest(activeRequest) ||
    hasNamedWorkspaceLaunchFollowUp ||
    FRAMEWORK_BUILD_LIFECYCLE_BUILD_PATTERN.test(activeRequest) ||
    FRAMEWORK_BUILD_LIFECYCLE_PREVIEW_PATTERN.test(activeRequest) ||
    FRAMEWORK_BUILD_LIFECYCLE_OPEN_PATTERN.test(activeRequest) ||
    FRAMEWORK_BUILD_LIFECYCLE_EDIT_PATTERN.test(activeRequest)
  );
}
/**
 * Evaluates whether local workspace organization request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isLocalWorkspaceOrganizationRequest(currentUserRequest: string): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (BUILD_EXPLANATION_ONLY_PATTERN.test(activeRequest)) {
    return false;
  }
  if (isBrowserControlFollowUpRequest(activeRequest)) {
    return false;
  }
  const hasExplicitOrganizationVerb =
    LOCAL_WORKSPACE_ORGANIZATION_VERB_PATTERN.test(activeRequest);
  const hasImplicitOrganizationMove =
    LOCAL_WORKSPACE_ORGANIZATION_IMPLICIT_MOVE_PATTERN.test(activeRequest);
  if (!hasExplicitOrganizationVerb && !hasImplicitOrganizationMove) {
    return false;
  }
  if (!LOCAL_WORKSPACE_ORGANIZATION_TARGET_PATTERN.test(activeRequest)) {
    return false;
  }
  return (
    LOCAL_WORKSPACE_ORGANIZATION_DESTINATION_PATTERN.test(activeRequest) ||
    LOCAL_WORKSPACE_ORGANIZATION_USER_OWNED_LOCATION_PATTERN.test(activeRequest) ||
    LOCAL_WORKSPACE_ORGANIZATION_REFERENCE_PATTERN.test(activeRequest) ||
    BUILD_EXECUTION_DESTINATION_PATTERN.test(activeRequest)
  );
}
/**
 * Evaluates whether live verification build request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasNamedWorkspaceLaunchOpenIntent` (import `hasNamedWorkspaceLaunchOpenIntent`) from `./namedWorkspaceLaunchSupport`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isLiveVerificationBuildRequest(currentUserRequest: string): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (!isExecutionStyleBuildRequest(activeRequest)) {
    return false;
  }
  if (suppressesLiveRunWork(activeRequest)) {
    return false;
  }
  const browserOpenSuppressed = suppressesBrowserOpen(activeRequest);
  if (!browserOpenSuppressed && hasNamedWorkspaceLaunchOpenIntent(activeRequest)) {
    return true;
  }
  return (
    (!browserOpenSuppressed && NATURAL_BROWSER_OPEN_PATTERN.test(activeRequest)) ||
    matchesAnyRequestPattern(activeRequest, LIVE_VERIFICATION_REQUEST_PATTERNS)
  );
}
/**
 * Evaluates whether browser verification build request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function requiresBrowserVerificationBuildRequest(
  currentUserRequest: string
): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (!isExecutionStyleBuildRequest(activeRequest)) {
    return false;
  }
  if (suppressesBrowserVerification(activeRequest)) {
    return false;
  }
  return matchesAnyRequestPattern(activeRequest, BROWSER_VERIFICATION_REQUEST_PATTERNS);
}
/**
 * Evaluates whether persistent browser open build request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasNamedWorkspaceLaunchOpenIntent` (import `hasNamedWorkspaceLaunchOpenIntent`) from `./namedWorkspaceLaunchSupport`.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function requiresPersistentBrowserOpenBuildRequest(
  currentUserRequest: string
): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (!isExecutionStyleBuildRequest(activeRequest)) {
    return false;
  }
  if (suppressesBrowserOpen(activeRequest)) {
    return false;
  }
  if (hasNamedWorkspaceLaunchOpenIntent(activeRequest)) {
    return true;
  }
  return matchesAnyRequestPattern(
    activeRequest,
    PERSISTENT_BROWSER_OPEN_REQUEST_PATTERNS
  );
}
/**
 * Allowss implicit managed process for build request.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param currentUserRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function allowsImplicitManagedProcessForBuildRequest(
  currentUserRequest: string
): boolean {
  return isLiveVerificationBuildRequest(currentUserRequest);
}
