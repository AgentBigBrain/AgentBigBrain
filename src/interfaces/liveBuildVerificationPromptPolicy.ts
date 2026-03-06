/**
 * @fileoverview Shared prompt-policy helpers for build requests that ask to run and verify a live app.
 */

import { extractActiveRequestSegment } from "../core/currentRequestExtraction";

/**
 * Extracts the active request segment used by live-build prompt policy checks.
 *
 * **Why it exists:**
 * Keeps wrapped conversation input from polluting live-build intent detection, so user-facing
 * block/no-op messages describe the latest request instead of stale context.
 *
 * **What it talks to:**
 * - Uses `extractActiveRequestSegment` (import `extractActiveRequestSegment`) from `../core/currentRequestExtraction`.
 *
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @returns Active request segment used by live-build lexical checks.
 */
function extractCurrentRequestForLiveBuildPolicy(userInput: string): string {
  return extractActiveRequestSegment(userInput);
}

/**
 * Determines whether the active request explicitly asks for a live app run or browser/UI proof.
 *
 * **Why it exists:**
 * Keeps live-run prompt classification aligned across user-facing blocked and no-op rendering so
 * both paths explain the same limitation in plain language.
 *
 * **What it talks to:**
 * - Uses `extractCurrentRequestForLiveBuildPolicy` from this module.
 * - Uses local deterministic lexical patterns within this module.
 *
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @returns `true` when the active request includes live-run or browser-verification intent.
 */
export function isLiveBuildVerificationPrompt(userInput: string): boolean {
  const normalized = extractCurrentRequestForLiveBuildPolicy(userInput);
  if (!normalized) {
    return false;
  }
  return (
    /\bnpm\s+start\b/i.test(normalized) ||
    /\bnpm\s+run\s+dev\b/i.test(normalized) ||
    /\b(?:pnpm|yarn)\s+(?:start|dev)\b/i.test(normalized) ||
    /\b(?:next|vite)\s+dev\b/i.test(normalized) ||
    /\bdev\s+server\b/i.test(normalized) ||
    /\b(run|start|launch|open)\b[\s\S]{0,80}\b(app|site|server|project|frontend)\b/i.test(
      normalized
    ) ||
    /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i.test(normalized) ||
    /\bopen\b[\s\S]{0,80}\bbrowser\b/i.test(normalized)
  );
}
