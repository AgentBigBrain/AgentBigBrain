/**
 * @fileoverview Exact semantic-route helpers for planner-policy execution lanes.
 */

import {
  extractResolvedBuildFormat,
  extractResolvedRouteConstraints,
  extractResolvedRouteExecutionMode,
  extractResolvedRuntimeControlIntent,
  extractResolvedSemanticRouteId,
  hasResolvedSemanticRouteMetadata
} from "../../core/currentRequestExtraction";

const RESOLVED_FRAMEWORK_BUILD_ROUTE_IDS = new Set(["framework_app_build"]);
const RESOLVED_STATIC_HTML_BUILD_ROUTE_IDS = new Set(["static_html_build"]);
const RESOLVED_FRAMEWORK_BUILD_FORMATS = new Set([
  "framework_app",
  "nextjs",
  "react",
  "vite"
]);
const RESOLVED_EXECUTION_STYLE_BUILD_ROUTE_IDS = new Set([
  "build_request",
  "static_html_build",
  "framework_app_build"
]);

/**
 * Returns whether the wrapped execution input already resolved to the static HTML build lane.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` when the front door already chose the static HTML lane.
 */
export function isResolvedStaticHtmlBuildRoute(currentUserRequest: string): boolean {
  const semanticRouteId = extractResolvedSemanticRouteId(currentUserRequest);
  if (semanticRouteId !== null && RESOLVED_STATIC_HTML_BUILD_ROUTE_IDS.has(semanticRouteId)) {
    return true;
  }
  return extractResolvedBuildFormat(currentUserRequest) === "static_html";
}

/**
 * Returns whether the wrapped execution input already resolved to the framework build lane.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` when the front door already chose the framework lane.
 */
export function isResolvedFrameworkBuildRoute(currentUserRequest: string): boolean {
  const semanticRouteId = extractResolvedSemanticRouteId(currentUserRequest);
  if (semanticRouteId !== null && RESOLVED_FRAMEWORK_BUILD_ROUTE_IDS.has(semanticRouteId)) {
    return true;
  }
  const buildFormat = extractResolvedBuildFormat(currentUserRequest);
  return buildFormat !== null && RESOLVED_FRAMEWORK_BUILD_FORMATS.has(buildFormat);
}

/**
 * Returns whether the wrapped execution input already resolved to any execution-style build lane.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` when the front door already chose a build route.
 */
export function isResolvedExecutionStyleBuildRoute(currentUserRequest: string): boolean {
  const semanticRouteId = extractResolvedSemanticRouteId(currentUserRequest);
  return semanticRouteId !== null && RESOLVED_EXECUTION_STYLE_BUILD_ROUTE_IDS.has(semanticRouteId);
}

/**
 * Returns whether a resolved route exists and is not a build execution route.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` when route metadata should block planner lexical build fallback.
 */
export function isResolvedNonExecutionStyleRoute(currentUserRequest: string): boolean {
  const semanticRouteId = extractResolvedSemanticRouteId(currentUserRequest);
  return semanticRouteId !== null && !RESOLVED_EXECUTION_STYLE_BUILD_ROUTE_IDS.has(semanticRouteId);
}

/**
 * Returns whether front-door semantic route metadata is available.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` when planner policy must not use compatibility lexical route ownership.
 */
export function hasPlannerResolvedRouteMetadata(currentUserRequest: string): boolean {
  return hasResolvedSemanticRouteMetadata(currentUserRequest);
}

/**
 * Returns whether typed route metadata already approved build-style execution.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` when the front door approved build or autonomous execution.
 */
export function hasResolvedBuildExecutionMode(currentUserRequest: string): boolean {
  const executionMode = extractResolvedRouteExecutionMode(currentUserRequest);
  return executionMode === "build" || executionMode === "autonomous";
}

/**
 * Returns whether route metadata requested one runtime-control action.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @param intent - Runtime-control intent to check.
 * @returns `true` when the resolved route metadata contains that intent.
 */
export function hasResolvedRuntimeControlIntent(
  currentUserRequest: string,
  intent: "open_browser" | "close_browser" | "verify_browser" | "inspect_runtime" | "stop_runtime"
): boolean {
  return extractResolvedRuntimeControlIntent(currentUserRequest) === intent;
}

/**
 * Returns whether route metadata explicitly disallows browser opening.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` only when the route block carries an explicit browser-open ban.
 */
export function resolvedRouteDisallowsBrowserOpen(currentUserRequest: string): boolean {
  return extractResolvedRouteConstraints(currentUserRequest)?.disallowBrowserOpen === true;
}

/**
 * Returns whether route metadata explicitly disallows starting a server.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` only when the route block carries an explicit server-start ban.
 */
export function resolvedRouteDisallowsServerStart(currentUserRequest: string): boolean {
  return extractResolvedRouteConstraints(currentUserRequest)?.disallowServerStart === true;
}
