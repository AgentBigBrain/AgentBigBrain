/**
 * @fileoverview Shared normalization helpers for governed skill manifests.
 */

import type {
  SkillAllowedSideEffect,
  SkillActivationSource,
  SkillKind,
  SkillLifecycleStatus,
  SkillMemoryPolicy,
  SkillOrigin,
  SkillProjectionPolicy,
  SkillRiskLevel,
  SkillVerificationStatus
} from "./contracts";

const DEFAULT_SKILL_VERSION = "1.0.0";
const ALLOWED_SIDE_EFFECT_VALUES = new Set<SkillAllowedSideEffect>([
  "filesystem_read",
  "filesystem_write",
  "shell",
  "process",
  "network",
  "memory"
]);
const RISK_LEVEL_VALUES = new Set<SkillRiskLevel>(["low", "moderate", "high"]);
const LIFECYCLE_STATUS_VALUES = new Set<SkillLifecycleStatus>([
  "active",
  "draft",
  "pending_approval",
  "rejected",
  "deprecated"
]);
const ACTIVATION_SOURCE_VALUES = new Set<SkillActivationSource>([
  "builtin",
  "legacy_migration",
  "explicit_user_request",
  "agent_suggestion",
  "operator_approval"
]);
const VERIFICATION_STATUS_VALUES = new Set<SkillVerificationStatus>([
  "unverified",
  "verified",
  "failed"
]);
const SKILL_KIND_VALUES = new Set<SkillKind>(["executable_module", "markdown_instruction"]);
const SKILL_ORIGIN_VALUES = new Set<SkillOrigin>(["builtin", "runtime_user"]);
const MEMORY_POLICY_VALUES = new Set<SkillMemoryPolicy>([
  "none",
  "candidate_only",
  "operator_approved"
]);
const PROJECTION_POLICY_VALUES = new Set<SkillProjectionPolicy>([
  "metadata_only",
  "review_safe_excerpt",
  "operator_full_content"
]);

/**
 * Normalizes unknown input into a trimmed non-empty string.
 *
 * @param value - Candidate manifest field value.
 * @returns Trimmed string or `null`.
 */
export function trimToNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes an unknown input into a deduplicated string array.
 *
 * @param value - Candidate manifest field value.
 * @returns Deduplicated trimmed strings.
 */
export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((entry) => trimToNonEmptyString(entry)).filter(Boolean) as string[])];
}

/**
 * Filters unknown side-effect input down to the canonical skill side-effect enum values.
 *
 * @param value - Candidate manifest field value.
 * @returns Allowed side-effect values.
 */
export function normalizeAllowedSideEffects(value: unknown): SkillAllowedSideEffect[] {
  return normalizeStringArray(value)
    .map((entry) => entry.toLowerCase())
    .filter((entry): entry is SkillAllowedSideEffect =>
      ALLOWED_SIDE_EFFECT_VALUES.has(entry as SkillAllowedSideEffect)
    );
}

/**
 * Resolves the canonical risk level for a skill manifest.
 *
 * @param value - Candidate manifest field value.
 * @returns Canonical risk level.
 */
export function normalizeRiskLevel(value: unknown): SkillRiskLevel {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  return normalized && RISK_LEVEL_VALUES.has(normalized as SkillRiskLevel)
    ? (normalized as SkillRiskLevel)
    : "low";
}

/**
 * Resolves the canonical lifecycle status for a skill manifest.
 *
 * @param value - Candidate manifest field value.
 * @returns Canonical lifecycle status.
 */
export function normalizeLifecycleStatus(value: unknown): SkillLifecycleStatus {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  return normalized && LIFECYCLE_STATUS_VALUES.has(normalized as SkillLifecycleStatus)
    ? (normalized as SkillLifecycleStatus)
    : "active";
}

/**
 * Resolves the canonical activation source for a skill manifest.
 *
 * @param value - Candidate manifest field value.
 * @param origin - Skill origin used for defaulting.
 * @returns Canonical activation source.
 */
export function normalizeActivationSource(
  value: unknown,
  origin: unknown
): SkillActivationSource {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  if (normalized && ACTIVATION_SOURCE_VALUES.has(normalized as SkillActivationSource)) {
    return normalized as SkillActivationSource;
  }
  return normalizeSkillOrigin(origin) === "builtin" ? "builtin" : "legacy_migration";
}

/**
 * Resolves the canonical verification status for a skill manifest.
 *
 * @param value - Candidate manifest field value.
 * @returns Canonical verification status.
 */
export function normalizeVerificationStatus(value: unknown): SkillVerificationStatus {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  return normalized && VERIFICATION_STATUS_VALUES.has(normalized as SkillVerificationStatus)
    ? (normalized as SkillVerificationStatus)
    : "unverified";
}

/**
 * Resolves the canonical skill kind while preserving legacy executable manifests.
 *
 * @param value - Candidate manifest field value.
 * @returns Canonical skill kind.
 */
export function normalizeSkillKind(value: unknown): SkillKind {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  return normalized && SKILL_KIND_VALUES.has(normalized as SkillKind)
    ? (normalized as SkillKind)
    : "executable_module";
}

/**
 * Resolves the canonical skill origin.
 *
 * @param value - Candidate manifest field value.
 * @returns Canonical skill origin.
 */
export function normalizeSkillOrigin(value: unknown): SkillOrigin {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  return normalized && SKILL_ORIGIN_VALUES.has(normalized as SkillOrigin)
    ? (normalized as SkillOrigin)
    : "runtime_user";
}

/**
 * Resolves the skill memory policy with kind-aware defaults.
 *
 * @param value - Candidate manifest field value.
 * @param kind - Normalized skill kind.
 * @returns Canonical memory policy.
 */
export function normalizeMemoryPolicy(value: unknown, kind: SkillKind): SkillMemoryPolicy {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  if (normalized && MEMORY_POLICY_VALUES.has(normalized as SkillMemoryPolicy)) {
    return normalized as SkillMemoryPolicy;
  }
  return kind === "markdown_instruction" ? "candidate_only" : "none";
}

/**
 * Resolves the skill projection policy with kind-aware defaults.
 *
 * @param value - Candidate manifest field value.
 * @param kind - Normalized skill kind.
 * @returns Canonical projection policy.
 */
export function normalizeProjectionPolicy(value: unknown, kind: SkillKind): SkillProjectionPolicy {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  if (normalized && PROJECTION_POLICY_VALUES.has(normalized as SkillProjectionPolicy)) {
    return normalized as SkillProjectionPolicy;
  }
  return kind === "markdown_instruction" ? "review_safe_excerpt" : "metadata_only";
}

/**
 * Resolves the manifest version string, falling back to the default version when omitted.
 *
 * @param value - Candidate manifest field value.
 * @returns Canonical version string.
 */
export function parseVersion(value: unknown): string {
  return trimToNonEmptyString(value) ?? DEFAULT_SKILL_VERSION;
}
