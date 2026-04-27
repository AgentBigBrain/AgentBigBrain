/**
 * @fileoverview Deterministic request classification for execution-style and live-verification planner policy.
 */

import { extractSemanticRequestSegment } from "../../core/currentRequestExtraction";
import { parseExplicitExecutionConstraints } from "../../core/explicitExecutionConstraints";
import { extractRequestedFrameworkFolderName } from "./frameworkBuildActionHeuristics";
import { hasNamedWorkspaceLaunchOpenIntent } from "./namedWorkspaceLaunchSupport";
import {
  hasResolvedBuildExecutionMode,
  hasResolvedRuntimeControlIntent,
  hasPlannerResolvedRouteMetadata,
  isResolvedNonExecutionStyleRoute,
  isResolvedExecutionStyleBuildRoute,
  isResolvedFrameworkBuildRoute,
  isResolvedStaticHtmlBuildRoute,
  resolvedRouteDisallowsBrowserOpen,
  resolvedRouteDisallowsServerStart
} from "./liveVerificationSemanticRouteSupport";
import { requestsStaticHtmlServerOrBrowserProof } from "./liveVerificationStaticHtmlSupport";
import {
  BROWSER_VERIFICATION_REQUEST_PATTERNS,
  BUILD_EXECUTION_DESTINATION_PATTERN,
  BUILD_EXECUTION_TARGET_PATTERN,
  BUILD_EXECUTION_VERB_PATTERN,
  BUILD_EXPLANATION_ONLY_PATTERN,
  EXPLICIT_INDEX_HTML_ENTRY_PATTERN,
  EXPLICIT_STATIC_HTML_REQUEST_PATTERN,
  FRAMEWORK_APP_BOOTSTRAP_CUE_PATTERN,
  FRAMEWORK_APP_NAMED_WORKSPACE_CUE_PATTERN,
  FRAMEWORK_APP_REQUEST_PATTERN,
  FRAMEWORK_APP_SCAFFOLD_CONTINUATION_PATTERN,
  FRAMEWORK_BUILD_LIFECYCLE_BUILD_PATTERN,
  FRAMEWORK_BUILD_LIFECYCLE_CLOSE_PATTERN,
  FRAMEWORK_BUILD_LIFECYCLE_EDIT_PATTERN,
  FRAMEWORK_BUILD_LIFECYCLE_OPEN_PATTERN,
  FRAMEWORK_BUILD_LIFECYCLE_PREVIEW_PATTERN,
  FRAMEWORK_WORKSPACE_PREPARATION_PATTERN,
  LIVE_VERIFICATION_REQUEST_PATTERNS,
  LOCAL_WORKSPACE_ORGANIZATION_DESTINATION_PATTERN,
  LOCAL_WORKSPACE_ORGANIZATION_IMPLICIT_MOVE_PATTERN,
  LOCAL_WORKSPACE_ORGANIZATION_REFERENCE_PATTERN,
  LOCAL_WORKSPACE_ORGANIZATION_TARGET_PATTERN,
  LOCAL_WORKSPACE_ORGANIZATION_USER_OWNED_LOCATION_PATTERN,
  LOCAL_WORKSPACE_ORGANIZATION_VERB_PATTERN,
  NATURAL_BROWSER_CONTROL_FOLLOW_UP_PATTERN,
  NATURAL_BROWSER_OPEN_PATTERN,
  NEGATED_BROWSER_VERIFICATION_PATTERN,
  NEGATED_FRAMEWORK_SCAFFOLD_PATTERN,
  NEGATED_LIVE_RUN_PATTERN,
  PERSISTENT_BROWSER_OPEN_REQUEST_PATTERNS,
  RUNTIME_PROCESS_MANAGEMENT_TARGET_PATTERN,
  RUNTIME_PROCESS_MANAGEMENT_VERB_PATTERN,
  STATIC_HTML_BUILD_FORMAT_RESOLVED_PATTERN,
  STATIC_HTML_BUILD_LANE_PATTERN
} from "./liveVerificationRequestPatterns";

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
export function isStaticHtmlExecutionStyleRequest(currentUserRequest: string): boolean {
  if (isResolvedStaticHtmlBuildRoute(currentUserRequest)) {
    return true;
  }
  if (
    isResolvedFrameworkBuildRoute(currentUserRequest) ||
    hasPlannerResolvedRouteMetadata(currentUserRequest)
  ) {
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
  if (
    hasResolvedRuntimeControlIntent(currentUserRequest, "inspect_runtime") ||
    hasResolvedRuntimeControlIntent(currentUserRequest, "stop_runtime")
  ) {
    return true;
  }
  if (hasPlannerResolvedRouteMetadata(currentUserRequest)) {
    return false;
  }
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
  if (resolvedRouteDisallowsServerStart(currentUserRequest)) {
    return true;
  }
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  const explicitConstraints = parseExplicitExecutionConstraints(activeRequest);
  return explicitConstraints.disallowPreviewStart || NEGATED_LIVE_RUN_PATTERN.test(activeRequest);
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
  if (resolvedRouteDisallowsBrowserOpen(currentUserRequest)) {
    return true;
  }
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  const explicitConstraints = parseExplicitExecutionConstraints(activeRequest);
  return explicitConstraints.disallowVisibleBrowserOpen || NEGATED_BROWSER_VERIFICATION_PATTERN.test(activeRequest);
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
  if (resolvedRouteDisallowsBrowserOpen(currentUserRequest)) {
    return true;
  }
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
  if (
    hasResolvedRuntimeControlIntent(currentUserRequest, "open_browser") ||
    hasResolvedRuntimeControlIntent(currentUserRequest, "close_browser")
  ) {
    return true;
  }
  if (hasPlannerResolvedRouteMetadata(currentUserRequest)) {
    return false;
  }
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
  if (isResolvedNonExecutionStyleRoute(currentUserRequest)) {
    return false;
  }
  if (
    hasResolvedBuildExecutionMode(currentUserRequest) ||
    isResolvedExecutionStyleBuildRoute(currentUserRequest)
  ) {
    return true;
  }
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
export function requiresFrameworkAppScaffoldAction(currentUserRequest: string): boolean {
  if (isResolvedFrameworkBuildRoute(currentUserRequest)) {
    return true;
  }
  if (
    isResolvedStaticHtmlBuildRoute(currentUserRequest) ||
    hasPlannerResolvedRouteMetadata(currentUserRequest)
  ) {
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
    if (hasPlannerResolvedRouteMetadata(currentUserRequest)) {
      return false;
    }
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
  if (
    isResolvedStaticHtmlBuildRoute(currentUserRequest) ||
    hasPlannerResolvedRouteMetadata(currentUserRequest)
  ) {
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
  if (hasResolvedRuntimeControlIntent(currentUserRequest, "verify_browser")) {
    return true;
  }
  if (hasPlannerResolvedRouteMetadata(currentUserRequest)) {
    return false;
  }
  const activeRequest = normalizeActiveRequest(currentUserRequest);
  if (!isExecutionStyleBuildRequest(activeRequest)) {
    return false;
  }
  if (suppressesLiveRunWork(activeRequest)) {
    return false;
  }
  const browserOpenSuppressed = suppressesBrowserOpen(activeRequest);
  if (
    !browserOpenSuppressed &&
    isStaticHtmlExecutionStyleRequest(activeRequest) &&
    requiresPersistentBrowserOpenBuildRequest(activeRequest) &&
    !requiresBrowserVerificationBuildRequest(activeRequest) &&
    !requestsStaticHtmlServerOrBrowserProof(activeRequest)
  ) {
    return false;
  }
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
  if (hasResolvedRuntimeControlIntent(currentUserRequest, "verify_browser")) {
    return true;
  }
  if (hasPlannerResolvedRouteMetadata(currentUserRequest)) {
    return false;
  }
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
  if (hasResolvedRuntimeControlIntent(currentUserRequest, "open_browser")) {
    return true;
  }
  if (hasPlannerResolvedRouteMetadata(currentUserRequest)) {
    return false;
  }
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
