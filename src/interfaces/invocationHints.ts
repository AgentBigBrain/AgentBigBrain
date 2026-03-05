/**
 * @fileoverview Rewrites user-facing command hints to include required invocation alias prefixes when name-call policy is enabled.
 */

import { InvocationPolicyConfig } from "./invocationPolicy";

/**
 * Implements rewrite command line behavior used by `invocationHints`.
 *
 * **Why it exists:**
 * Keeps `rewrite command line` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param line - Single text line being parsed or transformed.
 * @param alias - Value for alias.
 * @returns Resulting string value.
 */
function rewriteCommandLine(line: string, alias: string): string {
  const trimmed = line.trimStart();
  const leading = line.slice(0, line.length - trimmed.length);
  if (!trimmed.startsWith("/")) {
    return line;
  }
  return `${leading}${alias} ${trimmed}`;
}

/**
 * Implements rewrite inline use hints behavior used by `invocationHints`.
 *
 * **Why it exists:**
 * Keeps `rewrite inline use hints` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param alias - Value for alias.
 * @returns Resulting string value.
 */
function rewriteInlineUseHints(text: string, alias: string): string {
  return text
    .replace(/Use \/status\b/g, `Use ${alias} /status`)
    .replace(/Use \/help\b/g, `Use ${alias} /help`);
}

/**
 * Executes invocation hints as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the invocation hints runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `InvocationPolicyConfig` (import `InvocationPolicyConfig`) from `./invocationPolicy`.
 *
 * @param message - Message/text content processed by this function.
 * @param policy - Configuration or policy settings applied here.
 * @returns Resulting string value.
 */
export function applyInvocationHints(
  message: string,
  policy: InvocationPolicyConfig
): string {
  if (!policy.requireNameCall || !message.trim()) {
    return message;
  }

  const alias = policy.aliases[0]?.trim() || "BigBrain";
  const withInlineHints = rewriteInlineUseHints(message, alias);
  return withInlineHints
    .split("\n")
    .map((line) => rewriteCommandLine(line, alias))
    .join("\n");
}

