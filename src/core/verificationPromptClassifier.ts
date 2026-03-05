/**
 * @fileoverview Provides deterministic classification helpers for verification-claim prompts and verification categories.
 */

import { VerificationCategoryV1 } from "./types";

const VERIFICATION_CLAIM_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bclaim\b.*\b(complete|completed|done|successful(?:ly)?)\b/i,
  /\b(done|complete|completed)\b.*\b(claim|report|present)\b/i,
  /\bdeterministic\s+proof\s+artifacts?\b/i,
  /\botherwise\s+block\s+the\s+done\s+claim\b/i
] as const;

/**
 * Checks whether prompt text contains a verification-claim signal.
 *
 * **Why it exists:**
 * Keeps verification-claim detection logic consistent across execution and rendering paths.
 *
 * **What it talks to:**
 * - Uses local regex contracts in `VERIFICATION_CLAIM_PROMPT_PATTERNS`.
 *
 * @param promptText - Active request text segment used for verification routing decisions.
 * @returns `true` when prompt text requests deterministic done-claim proof semantics.
 */
export function isVerificationClaimPrompt(promptText: string): boolean {
  return VERIFICATION_CLAIM_PROMPT_PATTERNS.some((pattern) => pattern.test(promptText));
}

/**
 * Resolves verification category from prompt text using deterministic lexical heuristics.
 *
 * **Why it exists:**
 * Prevents category drift between modules that evaluate Stage 6.85 verification gates.
 *
 * **What it talks to:**
 * - Uses local regex heuristics to map prompt text to `VerificationCategoryV1`.
 *
 * @param promptText - Active request text segment used for verification category selection.
 * @returns Deterministic verification category used by Stage 6.85 verification gates.
 */
export function resolveVerificationCategoryFromPrompt(
  promptText: string
): VerificationCategoryV1 {
  const normalized = promptText.toLowerCase();
  if (/\b(build|scaffold|typescript\s+cli|runbook|tests?)\b/.test(normalized)) {
    return "build";
  }
  if (/\b(research|findings|sources?)\b/.test(normalized)) {
    return "research";
  }
  if (/\b(workflow|replay|capture|selector)\b/.test(normalized)) {
    return "workflow_replay";
  }
  return "communication";
}
