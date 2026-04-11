/**
 * @fileoverview Deterministic request classification for execution-style and live-verification planner policy.
 */

import { classifyRoutingIntentV1 } from "../../interfaces/routingMap";
import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import { extractRequestedFrameworkFolderName } from "./frameworkBuildActionHeuristics";
import { hasNamedWorkspaceLaunchOpenIntent } from "./namedWorkspaceLaunchSupport";

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
  /\bdo\s+not\s+(?:start|run|launch|serve)\b[\s\S]{0,80}\b(?:localhost|127\.0\.0\.1|::1|loopback|server|service|api|backend|dev\s+server|preview\s+server|preview\/dev\s+server|preview)\b|\bdo\s+not\s+(?:probe|check|confirm|verify)\b[\s\S]{0,80}\b(?:localhost|127\.0\.0\.1|::1|loopback|http|port|ready|readiness)\b/i;
const NEGATED_BROWSER_VERIFICATION_PATTERN =
  /\bdo\s+not\s+(?:(?:open|reopen)\s+or\s+)?(?:verify|check|inspect|review)\b[\s\S]{0,80}\b(?:browser|homepage|ui|page|render|renders|rendering)\b/i;
const NEGATED_BROWSER_OPEN_PATTERN =
  /\bdo\s+not\s+open\b[\s\S]{0,60}\b(?:browser|tab|window|page|site|preview|it)\b/i;
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

/**
 * Normalizes planner-facing request text down to the active user request segment.
 *
 * @param currentUserRequest - Raw planner-facing request text, which may already include wrapped conversation context.
 * @returns Active request text used by deterministic build and organization classifiers.
 */
function normalizeActiveRequest(currentUserRequest: string): string {
  return extractActiveRequestSegment(currentUserRequest).trim();
}

/**
 * Evaluates whether a request is about inspecting or stopping an existing runtime instead of
 * building or editing project files.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when the request is process-management oriented.
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
 * Returns whether the request explicitly suppresses live-run/start-or-probe work for this turn.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when the user explicitly says not to start/verify a live runtime yet.
 */
export function suppressesLiveRunWork(currentUserRequest: string): boolean {
  return NEGATED_LIVE_RUN_PATTERN.test(normalizeActiveRequest(currentUserRequest));
}

/**
 * Returns whether the request explicitly suppresses browser/UI verification for this turn.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when browser verification is explicitly negated.
 */
function suppressesBrowserVerification(currentUserRequest: string): boolean {
  return NEGATED_BROWSER_VERIFICATION_PATTERN.test(normalizeActiveRequest(currentUserRequest));
}

/**
 * Returns whether the request explicitly suppresses opening a browser for this turn.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when browser opening is explicitly negated.
 */
function suppressesBrowserOpen(currentUserRequest: string): boolean {
  return NEGATED_BROWSER_OPEN_PATTERN.test(normalizeActiveRequest(currentUserRequest));
}

/**
 * Evaluates whether a request is primarily asking to control a tracked browser window from the
 * current conversation rather than asking to build or run a project again.
 *
 * This is a meaning-level classifier only. It helps the planner know the user likely means
 * "operate on the current page/session," but it does not authorize closing unrelated browser
 * windows or stopping any ambiguous holder process by itself.
 */
export function isBrowserControlFollowUpRequest(currentUserRequest: string): boolean {
  return NATURAL_BROWSER_CONTROL_FOLLOW_UP_PATTERN.test(
    normalizeActiveRequest(currentUserRequest)
  );
}

/**
 * Evaluates whether a request is an execution-style build goal rather than guidance-only help.
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
 * Evaluates whether a request is asking for a fresh framework-app scaffold/build path rather than
 * a static landing-page file or a tracked artifact-edit follow-up.
 */
export function requiresFrameworkAppScaffoldAction(
  currentUserRequest: string
): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
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
 * Evaluates whether a framework-app request is a narrow workspace-preparation turn that should
 * stay on the deterministic scaffold/install/proof path instead of paying full planner latency.
 */
export function isFrameworkWorkspacePreparationRequest(
  currentUserRequest: string
): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  return (
    requiresFrameworkAppScaffoldAction(activeRequest) &&
    !isLiveVerificationBuildRequest(activeRequest) &&
    !requiresBrowserVerificationBuildRequest(activeRequest) &&
    !requiresPersistentBrowserOpenBuildRequest(activeRequest) &&
    FRAMEWORK_WORKSPACE_PREPARATION_PATTERN.test(activeRequest)
  );
}

/**
 * Evaluates whether a request is still in the deterministic framework build lifecycle lane:
 * scaffold/build/start/open and bounded tracked edit turns should stay on the bounded framework
 * runtime path, while close and unrelated conversational turns should not.
 */
export function isDeterministicFrameworkBuildLaneRequest(
  currentUserRequest: string
): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (FRAMEWORK_BUILD_LIFECYCLE_CLOSE_PATTERN.test(activeRequest)) {
    return false;
  }
  if (isRuntimeProcessManagementRequest(activeRequest)) {
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
 * Evaluates whether a request is a bounded local workspace-organization goal that should be
 * executed rather than answered with guidance-only output.
 *
 * This classification says the request is execution-shaped local organization work. It does not
 * by itself permit broad recovery or unproven holder shutdown when the runtime cannot tie the
 * blocked path back to an exact owned resource.
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
 * Evaluates whether a build request explicitly asks to run and verify a live app/server.
 */
export function isLiveVerificationBuildRequest(currentUserRequest: string): boolean {
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (!isExecutionStyleBuildRequest(activeRequest)) {
    return false;
  }
  if (suppressesLiveRunWork(activeRequest)) {
    return false;
  }
  if (hasNamedWorkspaceLaunchOpenIntent(activeRequest)) {
    return true;
  }
  return (
    /\bnpm\s+start\b/i.test(activeRequest) ||
    /\bnpm\s+run\s+dev\b/i.test(activeRequest) ||
    /\b(?:pnpm|yarn)\s+(?:start|dev)\b/i.test(activeRequest) ||
    /\b(?:next|vite)\s+dev\b/i.test(activeRequest) ||
    NATURAL_LOCAL_START_PATTERN.test(activeRequest) ||
    NATURAL_BROWSER_OPEN_PATTERN.test(activeRequest) ||
    /\bdev\s+server\b/i.test(activeRequest) ||
    /\b(localhost|127\.0\.0\.1|::1|loopback)\b/i.test(activeRequest) ||
    /\b(run|start|launch|serve)\b[\s\S]{0,80}\b(server|service|api|backend|dev\s+server)\b/i.test(
      activeRequest
    ) ||
    /\b(?:probe|check|confirm|wait\s+until)\b[\s\S]{0,80}\b(?:localhost|http|port|ready|readiness)\b/i.test(
      activeRequest
    ) ||
    /\b(?:tell\s+me|let\s+me\s+know|confirm)\b[\s\S]{0,24}\bif\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bworked\b/i.test(
      activeRequest
    ) ||
    /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i.test(
      activeRequest
    ) ||
    /\b(playwright|screenshot|visual(?:ly)?\s+confirm)\b/i.test(activeRequest)
  );
}

/**
 * Evaluates whether a build request explicitly asks for browser/UI proof.
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
  return (
    /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i.test(
      activeRequest
    ) ||
    /\b(check|inspect|review)\b[\s\S]{0,80}\b(browser|homepage|ui|page|render|rendering)\b/i.test(
      activeRequest
    ) ||
    /\b(screenshot|visual(?:ly)?\s+confirm)\b/i.test(activeRequest)
  );
}

/**
 * Evaluates whether a build request explicitly asks for a visible browser window to remain open.
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
  return (
    /\bleave\b[\s\S]{0,40}\b(browser|page|site|window|it)\b[\s\S]{0,20}\bopen\b/i.test(
      activeRequest
    ) ||
    NATURAL_BROWSER_OPEN_PATTERN.test(activeRequest) ||
    NATURAL_BROWSER_LEAVE_UP_PATTERN.test(activeRequest) ||
    /\bkeep\b[\s\S]{0,40}\b(browser|page|site|window|it)\b[\s\S]{0,20}\bopen\b/i.test(
      activeRequest
    ) ||
    /\blet me (?:see|view)\b/i.test(activeRequest) ||
    /\bso i can (?:see|view)\b/i.test(activeRequest)
  );
}

/**
 * Evaluates whether planner policy may implicitly allow managed live-run process actions.
 */
export function allowsImplicitManagedProcessForBuildRequest(
  currentUserRequest: string
): boolean {
  return isLiveVerificationBuildRequest(currentUserRequest);
}
