/**
 * @fileoverview Shared policy helpers for governed Markdown instruction skills.
 */

import { getStringParam } from "../hardConstraintParamUtils";

export type CreateSkillRuntimeKind = "executable_module" | "markdown_instruction";

export const MAX_MARKDOWN_SKILL_INSTRUCTIONS_LENGTH = 20_000;

const UNSAFE_MARKDOWN_SKILL_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|system|developer|safety|governance|constraints?)\b/i,
  /\bbypass\s+(?:governors?|constraints?|approval|memory|projection|redaction)\b/i,
  /\bdisable\s+(?:governors?|constraints?|approval|redaction)\b/i,
  /\b(?:api[_ -]?key|secret|token|password)\s*[:=]/i,
  /\bC:\\Users\\(?!testuser\\)[^\\\r\n]+\\(?:Desktop|OneDrive)\b/i,
  /\/Users\/(?!testuser\/)[^/\r\n]+\/(?:Desktop|Documents|Downloads)\b/i
] as const;

/**
 * Resolves the runtime kind for one create-skill payload.
 *
 * @param params - Planned action params.
 * @returns Canonical runtime skill kind.
 */
export function resolveCreateSkillRuntimeKind(
  params: Record<string, unknown>
): CreateSkillRuntimeKind {
  const explicitKind = getStringParam(params, "kind")?.trim().toLowerCase();
  if (explicitKind === "markdown_instruction") {
    return "markdown_instruction";
  }
  if (explicitKind === "executable_module") {
    return "executable_module";
  }

  const code = getStringParam(params, "code");
  const instructions = extractMarkdownSkillInstructions(params);
  return !code && instructions ? "markdown_instruction" : "executable_module";
}

/**
 * Extracts Markdown instruction content from a create-skill payload.
 *
 * @param params - Planned action params.
 * @returns Trimmed Markdown instructions, or `null`.
 */
export function extractMarkdownSkillInstructions(
  params: Record<string, unknown>
): string | null {
  const instructions =
    getStringParam(params, "instructions") ??
    getStringParam(params, "markdownContent") ??
    getStringParam(params, "content") ??
    null;
  const normalized = instructions?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

/**
 * Detects unsafe Markdown guidance patterns.
 *
 * @param instructions - Markdown instruction content.
 * @returns `true` when the guidance attempts to bypass runtime policy or embeds secrets.
 */
export function containsUnsafeMarkdownSkillInstructions(instructions: string): boolean {
  return UNSAFE_MARKDOWN_SKILL_PATTERNS.some((pattern) => pattern.test(instructions));
}
