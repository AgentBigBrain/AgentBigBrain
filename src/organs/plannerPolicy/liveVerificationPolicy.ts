/**
 * @fileoverview Deterministic request classification for execution-style and live-verification planner policy.
 */

import { classifyRoutingIntentV1 } from "../../interfaces/routingMap";

const BUILD_EXECUTION_VERB_PATTERN =
  /\b(create|build|make|generate|scaffold|setup|set up|spin up)\b/i;
const BUILD_EXECUTION_TARGET_PATTERN =
  /\b(app|application|project|dashboard|site|website|frontend|backend|api|cli|repo|repository|react|next\.?js|vue|svelte|angular|vite)\b/i;
const BUILD_EXECUTION_DESTINATION_PATTERN =
  /\bon\s+my\s+(desktop|documents|downloads)\b|\bin\s+['"]?[a-z]:\\|\bin\s+['"]?\/(?:users|home|tmp|var|opt)\//i;
const BUILD_EXPLANATION_ONLY_PATTERN =
  /^\s*(how\s+do\s+i|how\s+to|explain|show\s+me\s+how|tutorial|guide\s+me|what\s+is)\b|\b(without\s+executing|do\s+not\s+execute|don't\s+execute|guidance\s+only|instructions?\s+only)\b/i;

/**
 * Evaluates whether a request is an execution-style build goal rather than guidance-only help.
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
 * Evaluates whether a build request explicitly asks to run and verify a live app/server.
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
 * Evaluates whether planner policy may implicitly allow managed live-run process actions.
 */
export function allowsImplicitManagedProcessForBuildRequest(
  currentUserRequest: string
): boolean {
  return isLiveVerificationBuildRequest(currentUserRequest);
}
