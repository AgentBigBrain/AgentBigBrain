/**
 * @fileoverview Resolves explicit build-format metadata for conversation intent routing.
 */

import type { ConversationBuildFormatMetadata } from "./intentModeContracts";

const NEXTJS_BUILD_FORMAT_PATTERN = /\b(?:next\.?js|nextjs)\b/i;
const REACT_BUILD_FORMAT_PATTERN = /\breact\b/i;
const VITE_BUILD_FORMAT_PATTERN = /\bvite\b/i;

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
