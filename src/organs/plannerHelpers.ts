/**
 * @fileoverview Shared planner normalization, required-action enforcement, and failure-fingerprint helpers.
 */

import { makeId } from "../core/ids";
import { PlannedAction } from "../core/types";
import {
  estimateActionCostUsd,
  estimateActionTypeBaseCostUsd
} from "../core/actionCostPolicy";
import {
  defaultPlannerActionDescription,
  extractPlannerActionCandidates,
  isPlannerActionType,
  normalizePlannerActionParams,
  normalizePlannerActionTypeAlias,
  toPlannerRecord
} from "../core/plannerActionSchema";
import { RequiredActionType } from "./plannerPolicy/executionStyleContracts";

export const PLANNER_FAILURE_WINDOW_MS = 2 * 60 * 1000;
export const PLANNER_FAILURE_COOLDOWN_MS = 60 * 1000;
export const PLANNER_FAILURE_MAX_STRIKES = 2;
export const MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH = 120;
const CREATE_SKILL_INTENT_PATTERN =
  /\b(create|generate|make|build|write)\s+(?:a\s+)?skill\b/i;
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SKILL_NAME_QUOTED_PATTERN = /\bskill\s+(?:named|called)?\s*["'`]([a-zA-Z0-9_-]{1,64})["'`]/i;
const SKILL_NAME_NAMED_PATTERN = /\bskill\s+(?:named|called)\s+([a-zA-Z0-9_-]{1,64})\b/i;
const SKILL_NAME_DIRECT_PATTERN = /\bskill\s+([a-zA-Z0-9_-]{1,64})\b/i;
const RUN_SKILL_EXPLICIT_REQUEST_PATTERN =
  /\b(run|execute|invoke|use)\s+(?:a\s+)?skill\b|\brun[_\s-]?skill\b/i;
const WORKFLOW_RUN_SKILL_REQUEST_PATTERN =
  /\b(workflow|replay|capture|selector\s+drift|browser\s+workflow)\b/i;
export type { RequiredActionType } from "./plannerPolicy/executionStyleContracts";
const EXPLICIT_RUNTIME_ACTION_REQUEST_PATTERNS: readonly {
  type: Exclude<RequiredActionType, null>;
  pattern: RegExp;
}[] = [
  {
    type: "verify_browser",
    pattern: /^\s*(?:verify_browser\b|(?:use|run|execute)\s+verify_browser\b)/i
  },
  {
    type: "probe_http",
    pattern: /^\s*(?:probe_http\b|(?:use|run|execute)\s+probe_http\b)/i
  },
  {
    type: "probe_port",
    pattern: /^\s*(?:probe_port\b|(?:use|run|execute)\s+probe_port\b)/i
  },
  {
    type: "check_process",
    pattern: /^\s*(?:check_process\b|(?:use|run|execute)\s+check_process\b)/i
  },
  {
    type: "stop_process",
    pattern: /^\s*(?:stop_process\b|(?:use|run|execute)\s+stop_process\b)/i
  },
  {
    type: "start_process",
    pattern: /^\s*(?:start_process\b|(?:use|run|execute)\s+start_process\b)/i
  }
] as const;
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
 * Evaluates action type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the action type policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `isPlannerActionType` (import `isPlannerActionType`) from `../core/plannerActionSchema`.
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is PlannedAction["type"]` result.
 */
export function isActionType(value: unknown): value is PlannedAction["type"] {
  return isPlannerActionType(value);
}

/**
 * Normalizes action type alias into a stable shape for `plannerHelpers` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for action type alias so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `normalizePlannerActionTypeAlias` (import `normalizePlannerActionTypeAlias`) from `../core/plannerActionSchema`.
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `PlannedAction["type"] | null` result.
 */
export function normalizeActionTypeAlias(value: unknown): PlannedAction["type"] | null {
  return normalizePlannerActionTypeAlias(value);
}

/**
 * Derives cost for action from available runtime inputs.
 *
 * **Why it exists:**
 * Defines public behavior from `plannerHelpers.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `estimateActionTypeBaseCostUsd` (import `estimateActionTypeBaseCostUsd`) from `../core/actionCostPolicy`.
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param type - Planned action type whose deterministic base cost is requested.
 * @returns Numeric result used by downstream logic.
 */
export function estimateCostForAction(type: PlannedAction["type"]): number {
  return estimateActionTypeBaseCostUsd(type);
}

/**
 * Returns the default description for action used when explicit config is absent.
 *
 * **Why it exists:**
 * Keeps fallback defaults for description for action centralized so unset-config behavior is predictable.
 *
 * **What it talks to:**
 * - Uses `defaultPlannerActionDescription` (import `defaultPlannerActionDescription`) from `../core/plannerActionSchema`.
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param type - Value for type.
 * @returns Resulting string value.
 */
export function defaultDescriptionForAction(type: PlannedAction["type"]): string {
  return defaultPlannerActionDescription(type);
}

/**
 * Converts values into record form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for record deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `toPlannerRecord` (import `toPlannerRecord`) from `../core/plannerActionSchema`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `Record<string, unknown> | null` result.
 */
export function toRecord(value: unknown): Record<string, unknown> | null {
  return toPlannerRecord(value);
}

/**
 * Derives action candidates from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for action candidates in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `extractPlannerActionCandidates` (import `extractPlannerActionCandidates`) from `../core/plannerActionSchema`.
 *
 * @param output - Result payload being inspected or transformed.
 * @returns Ordered collection produced by this step.
 */
export function extractActionCandidates(output: unknown): unknown[] {
  return extractPlannerActionCandidates(output);
}

/**
 * Normalizes model actions into a stable shape for `plannerHelpers` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for model actions so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../core/actionCostPolicy`.
 * - Uses `makeId` (import `makeId`) from `../core/ids`.
 * - Uses `normalizePlannerActionParams` (import `normalizePlannerActionParams`) from `../core/plannerActionSchema`.
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param actions - Raw model-produced action candidates.
 * @returns Ordered collection produced by this step.
 */
export function normalizeModelActions(actions: unknown): PlannedAction[] {
  if (!Array.isArray(actions)) {
    return [];
  }

  const normalized: PlannedAction[] = [];
  for (const item of actions) {
    const record = toRecord(item);
    if (!record) {
      continue;
    }
    const rawType = record.type ?? record.actionType ?? record.action ?? record.tool;
    const normalizedType = normalizeActionTypeAlias(rawType);
    if (!normalizedType || !isActionType(normalizedType)) {
      continue;
    }

    const description =
      typeof record.description === "string" && record.description.trim().length > 0
        ? record.description.trim()
        : defaultDescriptionForAction(normalizedType);

    const params = normalizePlannerActionParams(record, toRecord(record.params) ?? {});

    normalized.push({
      id: makeId("action"),
      type: normalizedType,
      description,
      params,
      // Cost is owned by deterministic runtime policy, not model-provided fields.
      estimatedCostUsd: estimateActionCostUsd({
        type: normalizedType,
        params
      })
    });
  }

  return normalized;
}

/**
 * Evaluates respond message and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the respond message policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param action - Normalized action to validate for required respond text payload.
 * @returns `true` when this check/policy condition passes.
 */
export function hasRespondMessage(action: PlannedAction): boolean {
  if (action.type !== "respond") {
    return true;
  }

  const message = typeof action.params.message === "string" ? action.params.message.trim() : "";
  const text = typeof action.params.text === "string" ? action.params.text.trim() : "";
  return Boolean(message || text);
}

/**
 * Normalizes fingerprint segment into a stable shape for `plannerHelpers` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for fingerprint segment so call sites stay aligned.
 *
 * **What it talks to:**
 * - Local lowercase/whitespace normalization and length capping.
 *
 * @param value - Primary input consumed by this function.
 * @returns Canonicalized fingerprint segment bounded to deterministic max length.
 */
export function normalizeFingerprintSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.slice(0, MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH);
}

/**
 * Derives required action type from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for required action type in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param currentUserRequest - Structured input object for this operation.
 * @returns Computed `RequiredActionType` result.
 */
export function inferRequiredActionType(currentUserRequest: string): RequiredActionType {
  if (CREATE_SKILL_INTENT_PATTERN.test(currentUserRequest)) {
    return "create_skill";
  }
  if (RUN_SKILL_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest)) {
    return "run_skill";
  }
  for (const explicitRuntimeActionRequest of EXPLICIT_RUNTIME_ACTION_REQUEST_PATTERNS) {
    if (explicitRuntimeActionRequest.pattern.test(currentUserRequest)) {
      return explicitRuntimeActionRequest.type;
    }
  }
  return null;
}

/**
 * Evaluates required action and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the required action policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param actions - Normalized actions proposed by planner output.
 * @param requiredActionType - Required action inferred from explicit user intent.
 * @returns `true` when this check/policy condition passes.
 */
export function hasRequiredAction(
  actions: PlannedAction[],
  requiredActionType: RequiredActionType
): boolean {
  if (!requiredActionType) {
    return true;
  }

  return actions.some((action) => action.type === requiredActionType);
}

/**
 * Implements allows run skill for request behavior used by `plannerHelpers`.
 *
 * **Why it exists:**
 * Defines public behavior from `plannerHelpers.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param currentUserRequest - Structured input object for this operation.
 * @returns `true` when this check passes.
 */
export function allowsRunSkillForRequest(currentUserRequest: string): boolean {
  return (
    RUN_SKILL_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest) ||
    WORKFLOW_RUN_SKILL_REQUEST_PATTERN.test(currentUserRequest)
  );
}

/**
 * Implements filter non explicit run skill actions behavior used by `plannerHelpers`.
 *
 * **Why it exists:**
 * Defines public behavior from `plannerHelpers.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param actions - Value for actions.
 * @param currentUserRequest - Structured input object for this operation.
 * @returns Ordered collection produced by this step.
 */
export function filterNonExplicitRunSkillActions(
  actions: PlannedAction[],
  currentUserRequest: string
): PlannedAction[] {
  if (allowsRunSkillForRequest(currentUserRequest)) {
    return actions;
  }
  return actions.filter((action) => action.type !== "run_skill");
}

/**
 * Evaluates only run skill actions and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the only run skill actions policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param actions - Normalized actions proposed by planner output.
 * @returns `true` when this check/policy condition passes.
 */
export function hasOnlyRunSkillActions(actions: PlannedAction[]): boolean {
  return actions.length > 0 && actions.every((action) => action.type === "run_skill");
}

/**
 * Constrains and sanitizes to non empty string to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for to non empty string before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `string | null` result.
 */
export function trimToNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Evaluates skill name stop word and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the skill name stop word policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Local `SKILL_NAME_STOP_WORDS` set.
 *
 * @param candidate - Candidate token being evaluated as a skill-name segment.
 * @returns `true` when the function's policy/check conditions pass.
 */
export function isSkillNameStopWord(candidate: string): boolean {
  return SKILL_NAME_STOP_WORDS.has(candidate.trim().toLowerCase());
}

/**
 * Constrains and sanitizes skill name candidate to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for skill name candidate before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param candidate - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `string | null` result.
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
 * Builds skill name slug from intent for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of skill name slug from intent consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param currentUserRequest - Structured input object for this operation.
 * @returns Computed `string | null` result.
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
 * Derives create skill name from request from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for create skill name from request in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param currentUserRequest - Structured input object for this operation.
 * @returns Computed `string | null` result.
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
 * Converts values into function identifier form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for function identifier deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Local identifier sanitization rules for generated TypeScript function names.
 *
 * @param skillName - Normalized skill name used for scaffold generation.
 * @returns Safe TypeScript function identifier derived from skill name.
 */
export function toFunctionIdentifier(skillName: string): string {
  const normalized = skillName.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (/^[a-zA-Z_$]/.test(normalized)) {
    return normalized;
  }
  return `skill_${normalized}`;
}

/**
 * Builds create skill fallback code for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of create skill fallback code consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `toFunctionIdentifier` and deterministic scaffold templates.
 *
 * @param skillName - Skill name used to synthesize fallback executable scaffold code.
 * @returns Deterministic TypeScript scaffold used when model code is missing/placeholder.
 */
export function buildCreateSkillFallbackCode(skillName: string): string {
  const functionName = toFunctionIdentifier(skillName);
  return [
    "/**",
    " * @fileoverview Auto-generated skill scaffold from planner fallback.",
    " */",
    "",
    `export interface ${functionName}Result {`,
    "  ok: boolean;",
    "  summary: string;",
    "  normalizedInput: string;",
    "}",
    "",
    "/**",
    ` * Implements \`${functionName}\` behavior within generated skill scope.`,
    " */",
    `export function ${functionName}(input: string): ${functionName}Result {`,
    "  const normalizedInput = input.trim();",
    "  const ok = normalizedInput.length > 0;",
    `  const summary = ok ? "${skillName} executed with normalized input." : "${skillName} received empty input.";`,
    "  return {",
    "    ok,",
    "    summary,",
    "    normalizedInput",
    "  };",
    "}"
  ].join("\n");
}

/**
 * Constrains and sanitizes comments and whitespace to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for comments and whitespace before data flows to policy checks.
 *
 * **What it talks to:**
 * - Local regex stripping for comments and whitespace.
 *
 * @param code - Generated skill code candidate.
 * @returns Code string stripped to lexical signal for placeholder detection.
 */
export function stripCommentsAndWhitespace(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, "");
}

/**
 * Evaluates callable skill export and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the callable skill export policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Local regex signatures for callable exported functions.
 *
 * @param code - Generated skill code candidate.
 * @returns `true` when this check/policy condition passes.
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
 * Evaluates placeholder skill code and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the placeholder skill code policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `stripCommentsAndWhitespace` and `hasCallableSkillExport`.
 *
 * @param code - Generated skill code candidate.
 * @returns `true` when this check/policy condition passes.
 */
export function isPlaceholderSkillCode(code: string): boolean {
  const stripped = stripCommentsAndWhitespace(code);
  if (!stripped) {
    return true;
  }
  return !hasCallableSkillExport(code);
}

/**
 * Normalizes required create skill params into a stable shape for `plannerHelpers` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for required create skill params so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param actions - Value for actions.
 * @param currentUserRequest - Structured input object for this operation.
 * @param requiredActionType - Value for required action type.
 * @returns Ordered collection produced by this step.
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

    const existingCode = trimToNonEmptyString(params.code);
    const needsFallbackCode =
      (!existingCode || isPlaceholderSkillCode(existingCode)) && Boolean(resolvedSkillName);
    if (needsFallbackCode && resolvedSkillName) {
      params.code = buildCreateSkillFallbackCode(resolvedSkillName);
    }

    return {
      ...action,
      params
    };
  });
}

/**
 * Derives run-skill name from request from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for run-skill name extraction centralized so explicit run-skill requests
 * can fail closed with deterministic parameter backfill when model shape is incomplete.
 *
 * **What it talks to:**
 * - Uses local skill-name regex patterns and sanitization helpers in this module.
 *
 * @param currentUserRequest - Active request segment used for run-skill name extraction.
 * @returns Extracted/sanitized skill name, or `null` when no explicit name is present.
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
 * Normalizes required run-skill params into a stable shape for `plannerHelpers` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for required run-skill params so explicit run-skill requests
 * remain deterministic even when provider output omits `params.name`.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `../core/types`.
 *
 * @param actions - Normalized planner actions.
 * @param currentUserRequest - Active request segment used for name backfill.
 * @param requiredActionType - Required action inferred from explicit user intent.
 * @returns Actions with deterministic run-skill `params.name` backfilled when possible.
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
