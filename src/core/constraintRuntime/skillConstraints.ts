import { existsSync } from "node:fs";
import path from "node:path";

import { BrainConfig } from "../config";
import { getStringParam } from "../hardConstraintParamUtils";
import { ConstraintViolation } from "../types";

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_SKILL_CODE_LENGTH = 20_000;
const SKILL_CALLABLE_EXPORT_PATTERNS: readonly RegExp[] = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/,
  /\bexport\s+const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
  /\bexport\s+const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?function\s*\(/
];
const SKILL_UNSAFE_CODE_PATTERNS: readonly RegExp[] = [
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /\bFunction\s*\(\s*["'`]/i,
  /\bchild_process\b/i,
  /\bprocess\.env\b/i,
  /\bprocess\.exit\s*\(/i,
  /\bimport\s*\(\s*["'`](?:node:)?(?:fs|child_process|worker_threads|vm|net|tls|http|https)\b/i,
  /\brequire\s*\(\s*["'`](?:node:)?(?:fs|child_process|worker_threads|vm|net|tls|http|https)\b/i
] as const;

/**
 * Checks whether a runtime skill name fits the bounded naming contract.
 *
 * @param skillName - Proposed skill name.
 * @returns `true` when the skill name is safe to use.
 */
function isValidSkillName(skillName: string): boolean {
  return SKILL_NAME_PATTERN.test(skillName);
}

/**
 * Removes comments and whitespace so empty or non-executable skill code is easier to detect.
 *
 * @param code - Raw skill source code.
 * @returns Compacted code string with comments and whitespace removed.
 */
function stripCodeCommentsAndWhitespace(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * Detects whether skill source exports at least one callable entrypoint.
 *
 * @param code - Raw skill source code.
 * @returns `true` when the code contains a supported callable export shape.
 */
function hasCallableSkillExport(code: string): boolean {
  return SKILL_CALLABLE_EXPORT_PATTERNS.some((pattern) => pattern.test(code));
}

/**
 * Detects disallowed runtime-capability patterns inside skill source.
 *
 * @param code - Raw skill source code.
 * @returns `true` when blocked APIs or dynamic-eval patterns are present.
 */
function containsUnsafeSkillCode(code: string): boolean {
  return SKILL_UNSAFE_CODE_PATTERNS.some((pattern) => pattern.test(code));
}

/**
 * Resolves the runtime artifact paths used for a stored skill.
 *
 * @param skillName - Safe skill name.
 * @returns Absolute runtime paths for the JS and TS artifacts.
 */
function resolveRuntimeSkillArtifactPaths(skillName: string): {
  primaryPath: string;
  compatibilityPath: string;
} {
  const skillsRoot = path.resolve(process.cwd(), "runtime/skills");
  return {
    primaryPath: path.resolve(skillsRoot, `${skillName}.js`),
    compatibilityPath: path.resolve(skillsRoot, `${skillName}.ts`)
  };
}

/**
 * Checks whether a runtime skill artifact already exists on disk.
 *
 * @param skillName - Safe skill name to look up.
 * @returns `true` when a JS or TS runtime artifact exists.
 */
function hasRuntimeSkillArtifact(skillName: string): boolean {
  const paths = resolveRuntimeSkillArtifactPaths(skillName);
  return existsSync(paths.primaryPath) || existsSync(paths.compatibilityPath);
}

/**
 * Validates create-skill requests against naming, size, callable-export, and unsafe-code rules.
 *
 * @param params - Planned create-skill params.
 * @param config - Active brain config with create-skill permissions.
 * @returns Constraint violations for invalid create-skill requests.
 */
export function evaluateCreateSkillConstraints(
  params: Record<string, unknown>,
  config: BrainConfig
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  if (!config.permissions.allowCreateSkillAction) {
    violations.push({
      code: "CREATE_SKILL_DISABLED",
      message: "Create skill actions are disabled by policy."
    });
  }

  const skillName = getStringParam(params, "name");
  if (!skillName) {
    violations.push({
      code: "CREATE_SKILL_MISSING_NAME",
      message: "Create skill action requires a skill name."
    });
  } else if (!isValidSkillName(skillName)) {
    violations.push({
      code: "CREATE_SKILL_INVALID_NAME",
      message: "Skill name must match [a-zA-Z0-9_-] and be <= 64 chars."
    });
  }

  const code = getStringParam(params, "code");
  if (!code) {
    violations.push({
      code: "CREATE_SKILL_MISSING_CODE",
      message: "Create skill action requires code content."
    });
  } else if (code.length > MAX_SKILL_CODE_LENGTH) {
    violations.push({
      code: "CREATE_SKILL_CODE_TOO_LARGE",
      message: `Skill code length ${code.length} exceeds max ${MAX_SKILL_CODE_LENGTH}.`
    });
  } else if (!stripCodeCommentsAndWhitespace(code) || !hasCallableSkillExport(code)) {
    violations.push({
      code: "CREATE_SKILL_NON_EXECUTABLE",
      message: "Skill code must include an exported callable function."
    });
  } else if (containsUnsafeSkillCode(code)) {
    violations.push({
      code: "CREATE_SKILL_UNSAFE_CODE",
      message: "Skill code contains disallowed runtime-capability patterns."
    });
  }

  return violations;
}

/**
 * Validates run-skill requests against naming rules and stored runtime artifact existence.
 *
 * @param params - Planned run-skill params.
 * @returns Constraint violations for invalid run-skill requests.
 */
export function evaluateRunSkillConstraints(
  params: Record<string, unknown>
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const skillName = getStringParam(params, "name");

  if (!skillName) {
    violations.push({
      code: "RUN_SKILL_MISSING_NAME",
      message: "Run skill action requires a skill name."
    });
  } else if (!isValidSkillName(skillName)) {
    violations.push({
      code: "RUN_SKILL_INVALID_NAME",
      message: "Run skill name must match [a-zA-Z0-9_-] and be <= 64 chars."
    });
  } else if (!hasRuntimeSkillArtifact(skillName)) {
    violations.push({
      code: "RUN_SKILL_ARTIFACT_MISSING",
      message: `Run skill failed: no skill artifact found for ${skillName}.`
    });
  }

  return violations;
}
