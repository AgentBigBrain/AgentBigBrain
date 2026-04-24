/**
 * @fileoverview Exact semantic-route helpers for planner-policy execution lanes.
 */

import { extractResolvedSemanticRouteId } from "../../core/currentRequestExtraction";

const RESOLVED_FRAMEWORK_BUILD_ROUTE_IDS = new Set(["framework_app_build"]);
const RESOLVED_STATIC_HTML_BUILD_ROUTE_IDS = new Set(["static_html_build"]);
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
  return semanticRouteId !== null && RESOLVED_STATIC_HTML_BUILD_ROUTE_IDS.has(semanticRouteId);
}

/**
 * Returns whether the wrapped execution input already resolved to the framework build lane.
 *
 * @param currentUserRequest - Wrapped execution input or current request text.
 * @returns `true` when the front door already chose the framework lane.
 */
export function isResolvedFrameworkBuildRoute(currentUserRequest: string): boolean {
  const semanticRouteId = extractResolvedSemanticRouteId(currentUserRequest);
  return semanticRouteId !== null && RESOLVED_FRAMEWORK_BUILD_ROUTE_IDS.has(semanticRouteId);
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
