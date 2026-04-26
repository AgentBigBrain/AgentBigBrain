/**
 * @fileoverview Deterministic skill-name extraction and create/run-skill param normalization.
 */

import { PlannedAction } from "../../core/types";
import { RequiredActionType } from "./executionStyleContracts";

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SKILL_NAME_QUOTED_PATTERN =
  /\bskill\s+(?:named|called)?\s*["'`]([a-zA-Z0-9_-]{1,64})["'`]/i;
const SKILL_NAME_NAMED_PATTERN =
  /\bskill\s+(?:named|called)\s+([a-zA-Z0-9_-]{1,64})\b/i;
const SKILL_NAME_DIRECT_PATTERN = /\bskill\s+([a-zA-Z0-9_-]{1,64})\b/i;
const SKILL_NAME_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "about",
  "by",
  "for",
  "from",
  "in",
  "my",
  "new",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "with",
  "your"
]);
const SKILL_SLUG_STOP_WORDS = new Set([
  ...SKILL_NAME_STOP_WORDS,
  "build",
  "create",
  "generate",
  "help",
  "learn",
  "make",
  "skill",
  "teach",
  "write"
]);

/**
 * Constrains values to a trimmed non-empty string.
 */
export function trimToNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Evaluates whether a candidate is a stop-word for skill names.
 */
export function isSkillNameStopWord(candidate: string): boolean {
  return SKILL_NAME_STOP_WORDS.has(candidate.trim().toLowerCase());
}

/**
 * Sanitizes a skill-name candidate into canonical bounded form.
 */
export function sanitizeSkillNameCandidate(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || !SKILL_NAME_PATTERN.test(trimmed)) {
    return null;
  }
  if (isSkillNameStopWord(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Builds a skill-name slug from freeform request intent.
 */
export function buildSkillNameSlugFromIntent(currentUserRequest: string): string | null {
  const segmentMatch =
    currentUserRequest.match(/\bskill\s+to\s+([^\n.?!]+)/i) ??
    currentUserRequest.match(/\bskill\s+for\s+([^\n.?!]+)/i);
  if (!segmentMatch) {
    return null;
  }

  const segment = segmentMatch[1] ?? "";
  const tokens = segment
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !SKILL_SLUG_STOP_WORDS.has(token))
    .slice(0, 6);

  if (tokens.length === 0) {
    return null;
  }

  let slug = tokens.join("_").slice(0, 64).replace(/^_+|_+$/g, "");
  if (!slug) {
    return null;
  }
  if (/^[0-9]/.test(slug)) {
    slug = `skill_${slug}`;
  }

  return sanitizeSkillNameCandidate(slug);
}

/**
 * Derives a create-skill name from explicit current-user intent.
 */
export function extractCreateSkillNameFromRequest(currentUserRequest: string): string | null {
  const quotedMatch = currentUserRequest.match(SKILL_NAME_QUOTED_PATTERN);
  if (quotedMatch) {
    const quotedCandidate = sanitizeSkillNameCandidate(quotedMatch[1] ?? "");
    if (quotedCandidate) {
      return quotedCandidate;
    }
  }

  const namedMatch = currentUserRequest.match(SKILL_NAME_NAMED_PATTERN);
  if (namedMatch) {
    const namedCandidate = sanitizeSkillNameCandidate(namedMatch[1] ?? "");
    if (namedCandidate) {
      return namedCandidate;
    }
  }

  const directMatch = currentUserRequest.match(SKILL_NAME_DIRECT_PATTERN);
  if (directMatch) {
    const directCandidate = sanitizeSkillNameCandidate(directMatch[1] ?? "");
    if (directCandidate) {
      return directCandidate;
    }
  }

  return buildSkillNameSlugFromIntent(currentUserRequest);
}

/**
 * Strips comments and whitespace for placeholder detection.
 */
export function stripCommentsAndWhitespace(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, "");
}

/**
 * Evaluates whether generated skill code contains a callable exported entrypoint.
 */
export function hasCallableSkillExport(code: string): boolean {
  const callableExportPatterns: readonly RegExp[] = [
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/,
    /\bexport\s+const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
    /\bexport\s+const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?function\s*\(/
  ];
  return callableExportPatterns.some((pattern) => pattern.test(code));
}

/**
 * Evaluates whether generated skill code is a placeholder or empty scaffold.
 */
export function isPlaceholderSkillCode(code: string): boolean {
  const stripped = stripCommentsAndWhitespace(code);
  if (!stripped) {
    return true;
  }
  return !hasCallableSkillExport(code);
}

/**
 * Normalizes create-skill params using explicit request intent without synthesizing executable code.
 */
export function normalizeRequiredCreateSkillParams(
  actions: PlannedAction[],
  currentUserRequest: string,
  requiredActionType: RequiredActionType
): PlannedAction[] {
  if (requiredActionType !== "create_skill") {
    return actions;
  }

  const inferredSkillName = extractCreateSkillNameFromRequest(currentUserRequest);
  return actions.map((action) => {
    if (action.type !== "create_skill") {
      return action;
    }

    const params = { ...action.params };
    const existingSkillNameRaw = trimToNonEmptyString(params.name);
    const existingSkillName =
      existingSkillNameRaw && SKILL_NAME_PATTERN.test(existingSkillNameRaw)
        ? existingSkillNameRaw
        : null;
    const resolvedSkillName = existingSkillName ?? inferredSkillName;

    if (!existingSkillName && resolvedSkillName) {
      params.name = resolvedSkillName;
    }

    const existingKind = trimToNonEmptyString(params.kind)?.toLowerCase();
    const existingMarkdownInstructions =
      trimToNonEmptyString(params.instructions) ??
      trimToNonEmptyString(params.markdownContent) ??
      trimToNonEmptyString(params.content);
    if (existingKind === "markdown_instruction" && existingMarkdownInstructions) {
      return {
        ...action,
        params
      };
    }

    const existingCode = trimToNonEmptyString(params.code);
    if (existingCode && isPlaceholderSkillCode(existingCode)) {
      delete params.code;
    }

    return {
      ...action,
      params
    };
  });
}

/**
 * Derives a run-skill name from explicit current-user intent.
 */
export function extractRunSkillNameFromRequest(currentUserRequest: string): string | null {
  const quotedMatch = currentUserRequest.match(SKILL_NAME_QUOTED_PATTERN);
  if (quotedMatch) {
    const quotedCandidate = sanitizeSkillNameCandidate(quotedMatch[1] ?? "");
    if (quotedCandidate) {
      return quotedCandidate;
    }
  }

  const namedMatch = currentUserRequest.match(SKILL_NAME_NAMED_PATTERN);
  if (namedMatch) {
    const namedCandidate = sanitizeSkillNameCandidate(namedMatch[1] ?? "");
    if (namedCandidate) {
      return namedCandidate;
    }
  }

  const directMatch = currentUserRequest.match(SKILL_NAME_DIRECT_PATTERN);
  if (directMatch) {
    const directCandidate = sanitizeSkillNameCandidate(directMatch[1] ?? "");
    if (directCandidate) {
      return directCandidate;
    }
  }

  return null;
}

/**
 * Normalizes run-skill params using explicit request intent.
 */
export function normalizeRequiredRunSkillParams(
  actions: PlannedAction[],
  currentUserRequest: string,
  requiredActionType: RequiredActionType
): PlannedAction[] {
  if (requiredActionType !== "run_skill") {
    return actions;
  }

  const inferredSkillName = extractRunSkillNameFromRequest(currentUserRequest);
  return actions.map((action) => {
    if (action.type !== "run_skill") {
      return action;
    }

    const params = { ...action.params };
    const existingSkillNameRaw = trimToNonEmptyString(params.name);
    const existingSkillName =
      existingSkillNameRaw && SKILL_NAME_PATTERN.test(existingSkillNameRaw)
        ? existingSkillNameRaw
        : null;
    if (!existingSkillName && inferredSkillName) {
      params.name = inferredSkillName;
    }

    return {
      ...action,
      params
    };
  });
}
