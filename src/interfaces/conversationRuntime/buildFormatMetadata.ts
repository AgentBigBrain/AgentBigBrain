/**
 * @fileoverview Resolves explicit build-format metadata for conversation intent routing.
 */

import type { ConversationBuildFormatMetadata } from "./intentModeContracts";

const NEXTJS_BUILD_FORMAT_PATTERN = /\b(?:next\.?js|nextjs)\b/i;
const REACT_BUILD_FORMAT_PATTERN = /\breact\b/i;
const VITE_BUILD_FORMAT_PATTERN = /\bvite\b/i;
const FRAMEWORK_BUILD_FORMAT_PATTERN =
  /\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular|framework app)\b/i;
const STATIC_HTML_BUILD_FORMAT_PATTERN =
  /\b(?:static\s+single[- ]page|single[- ]file\s+html|single[- ]page\s+site|single[- ]page\s+html|plain\s+html|static\s+html|static\s+(?:site|website))\b/i;
const INDEX_HTML_ENTRY_PATTERN = /\bindex\.html\b/i;

/**
 * Returns whether the current request explicitly names a static HTML build format.
 *
 * **Why it exists:**
 * The conversation front door, not planner live-verification policy, should own typed
 * build-format metadata before downstream execution helpers consume it.
 *
 * **What it talks to:**
 * - Uses local exact build-format patterns within this module.
 *
 * @param normalized - Current user request text.
 * @returns `true` when the user explicitly named a static HTML deliverable.
 */
export function hasExplicitStaticHtmlBuildFormatRequest(normalized: string): boolean {
  return (
    STATIC_HTML_BUILD_FORMAT_PATTERN.test(normalized) ||
    INDEX_HTML_ENTRY_PATTERN.test(normalized)
  );
}

/**
 * Returns whether the current request explicitly names a framework build format.
 *
 * **Why it exists:**
 * Route metadata should preserve framework-specific user intent before planner policy evaluates
 * required actions, avoiding downstream natural-language reclassification.
 *
 * **What it talks to:**
 * - Uses local exact build-format patterns within this module.
 *
 * @param normalized - Current user request text.
 * @returns `true` when the user explicitly named a supported framework format.
 */
export function hasExplicitFrameworkBuildFormatRequest(normalized: string): boolean {
  return FRAMEWORK_BUILD_FORMAT_PATTERN.test(normalized);
}

/**
 * Resolves explicit build-format metadata without changing the top-level execution mode.
 *
 * **Why it exists:**
 * Preserves "static HTML" or framework-specific wording for planning while allowing strong
 * autonomous requests to remain autonomous at the conversation front door.
 *
 * **What it talks to:**
 * - Uses `ConversationBuildFormatMetadata` from `./intentModeContracts`.
 *
 * @param normalized - Current user request text.
 * @param explicitStaticHtmlBuildRequested - Whether deterministic checks found static HTML format.
 * @param explicitFrameworkBuildRequested - Whether deterministic checks found framework format.
 * @returns Typed build-format metadata or `null` when no explicit format was requested.
 */
export function resolveExplicitBuildFormatMetadata(
  normalized: string,
  explicitStaticHtmlBuildRequested: boolean,
  explicitFrameworkBuildRequested: boolean
): ConversationBuildFormatMetadata | null {
  if (explicitStaticHtmlBuildRequested) {
    return {
      format: "static_html",
      source: "explicit_user_request",
      confidence: "high"
    };
  }
  if (!explicitFrameworkBuildRequested) {
    return null;
  }
  if (NEXTJS_BUILD_FORMAT_PATTERN.test(normalized)) {
    return {
      format: "nextjs",
      source: "explicit_user_request",
      confidence: "high"
    };
  }
  if (REACT_BUILD_FORMAT_PATTERN.test(normalized)) {
    return {
      format: "react",
      source: "explicit_user_request",
      confidence: "high"
    };
  }
  if (VITE_BUILD_FORMAT_PATTERN.test(normalized)) {
    return {
      format: "vite",
      source: "explicit_user_request",
      confidence: "high"
    };
  }
  return {
    format: "framework_app",
    source: "explicit_user_request",
    confidence: "high"
  };
}
