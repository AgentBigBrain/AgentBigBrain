/**
 * @fileoverview Canonical skill-manifest normalization and creation helpers.
 */

import type { CreateSkillActionParams } from "../../core/types";
import type { SkillArtifactPaths } from "../executionRuntime/contracts";
import type {
  SkillAllowedSideEffect,
  SkillInventoryEntry,
  SkillLifecycleStatus,
  SkillManifest,
  SkillRiskLevel,
  SkillVerificationConfig,
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
const LIFECYCLE_STATUS_VALUES = new Set<SkillLifecycleStatus>(["active", "deprecated"]);
const VERIFICATION_STATUS_VALUES = new Set<SkillVerificationStatus>([
  "unverified",
  "verified",
  "failed"
]);

/**
 * Normalizes unknown input into a trimmed non-empty string.
 *
 * @param value - Candidate manifest field value.
 * @returns Trimmed string or `null`.
 */
function trimToNonEmptyString(value: unknown): string | null {
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
function normalizeStringArray(value: unknown): string[] {
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
function normalizeAllowedSideEffects(value: unknown): SkillAllowedSideEffect[] {
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
function normalizeRiskLevel(value: unknown): SkillRiskLevel {
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
function normalizeLifecycleStatus(value: unknown): SkillLifecycleStatus {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  return normalized && LIFECYCLE_STATUS_VALUES.has(normalized as SkillLifecycleStatus)
    ? (normalized as SkillLifecycleStatus)
    : "active";
}

/**
 * Resolves the canonical verification status for a skill manifest.
 *
 * @param value - Candidate manifest field value.
 * @returns Canonical verification status.
 */
function normalizeVerificationStatus(value: unknown): SkillVerificationStatus {
  const normalized = trimToNonEmptyString(value)?.toLowerCase();
  return normalized && VERIFICATION_STATUS_VALUES.has(normalized as SkillVerificationStatus)
    ? (normalized as SkillVerificationStatus)
    : "unverified";
}

/**
 * Builds the fallback manifest description when the caller omits one.
 *
 * @param skillName - Canonical skill name.
 * @returns Human-readable default description.
 */
function buildDefaultDescription(skillName: string): string {
  return `Governed runtime skill for ${skillName}.`;
}

/**
 * Builds the fallback user-facing summary when the caller omits one.
 *
 * @param skillName - Canonical skill name.
 * @returns Human-readable default summary.
 */
function buildDefaultUserSummary(skillName: string): string {
  return `Reusable tool for ${skillName}.`;
}

/**
 * Builds the fallback user-facing invocation hint when the caller omits one.
 *
 * @param skillName - Canonical skill name.
 * @returns Human-readable invocation hint.
 */
function buildDefaultInvocationHint(skillName: string): string {
  return `Ask me to run skill ${skillName}.`;
}

/**
 * Resolves the manifest version string, falling back to the default version when omitted.
 *
 * @param value - Candidate manifest field value.
 * @returns Canonical version string.
 */
function parseVersion(value: unknown): string {
  return trimToNonEmptyString(value) ?? DEFAULT_SKILL_VERSION;
}

/**
 * Extracts bounded verification settings from create-skill params.
 *
 * @param params - Create-skill params supplied by the planner/runtime.
 * @returns Verification configuration captured in the manifest.
 */
export function extractSkillVerificationConfig(
  params: CreateSkillActionParams
): SkillVerificationConfig {
  return {
    testInput: trimToNonEmptyString(params.testInput),
    expectedOutputContains: trimToNonEmptyString(params.expectedOutputContains)
  };
}

/**
 * Builds the initial manifest for a newly created skill.
 *
 * @param params - Create-skill params supplied by the planner/runtime.
 * @param skillName - Resolved safe skill name.
 * @param artifactPaths - Runtime artifact paths for the created skill.
 * @param nowIso - Creation timestamp.
 * @returns Canonical skill manifest.
 */
export function buildSkillManifest(
  params: CreateSkillActionParams,
  skillName: string,
  artifactPaths: SkillArtifactPaths,
  nowIso: string
): SkillManifest {
  const verification = extractSkillVerificationConfig(params);
  const description = trimToNonEmptyString(params.description) ?? buildDefaultDescription(skillName);
  const purpose = trimToNonEmptyString(params.purpose) ?? description;
  const inputSummary =
    trimToNonEmptyString(params.inputSummary) ?? "String input provided by the runtime.";
  const outputSummary =
    trimToNonEmptyString(params.outputSummary) ?? "String or JSON-like summary output.";
  const tags = normalizeStringArray(params.tags);
  const capabilities = normalizeStringArray(params.capabilities ?? params.tags);
  const invocationHints = normalizeStringArray(params.invocationHints);

  return {
    name: skillName,
    description,
    purpose,
    inputSummary,
    outputSummary,
    riskLevel: normalizeRiskLevel(params.riskLevel),
    allowedSideEffects: normalizeAllowedSideEffects(params.allowedSideEffects),
    tags,
    capabilities,
    version: parseVersion(params.version),
    createdAt: nowIso,
    updatedAt: nowIso,
    verificationStatus: "unverified",
    verificationVerifiedAt: null,
    verificationFailureReason: null,
    verificationTestInput: verification.testInput,
    verificationExpectedOutputContains: verification.expectedOutputContains,
    userSummary: trimToNonEmptyString(params.userSummary) ?? buildDefaultUserSummary(skillName),
    invocationHints:
      invocationHints.length > 0 ? invocationHints : [buildDefaultInvocationHint(skillName)],
    lifecycleStatus: "active",
    primaryPath: artifactPaths.primaryPath,
    compatibilityPath: artifactPaths.compatibilityPath
  };
}

/**
 * Applies a partial status update to an existing skill manifest.
 *
 * @param manifest - Existing manifest to update.
 * @param update - Partial status patch.
 * @param nowIso - Timestamp applied to the manifest.
 * @returns Updated manifest.
 */
export function applySkillManifestUpdate(
  manifest: SkillManifest,
  update: Partial<Pick<
    SkillManifest,
    | "verificationStatus"
    | "verificationVerifiedAt"
    | "verificationFailureReason"
    | "lifecycleStatus"
    | "version"
    | "updatedAt"
  >>,
  nowIso: string
): SkillManifest {
  return {
    ...manifest,
    verificationStatus: update.verificationStatus ?? manifest.verificationStatus,
    verificationVerifiedAt:
      update.verificationVerifiedAt === undefined
        ? manifest.verificationVerifiedAt
        : update.verificationVerifiedAt,
    verificationFailureReason:
      update.verificationFailureReason === undefined
        ? manifest.verificationFailureReason
        : update.verificationFailureReason,
    lifecycleStatus:
      update.lifecycleStatus === undefined
        ? manifest.lifecycleStatus
        : normalizeLifecycleStatus(update.lifecycleStatus),
    version: update.version ?? manifest.version,
    updatedAt: update.updatedAt ?? nowIso
  };
}

/**
 * Parses raw JSON into a canonical skill manifest.
 *
 * @param input - Raw manifest JSON.
 * @returns Canonical manifest, or `null` when the input is invalid.
 */
export function parseSkillManifest(input: unknown): SkillManifest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const candidate = input as Partial<SkillManifest>;
  const name = trimToNonEmptyString(candidate.name);
  const createdAt = trimToNonEmptyString(candidate.createdAt);
  const updatedAt = trimToNonEmptyString(candidate.updatedAt);
  const description = trimToNonEmptyString(candidate.description);
  const purpose = trimToNonEmptyString(candidate.purpose);
  const inputSummary = trimToNonEmptyString(candidate.inputSummary);
  const outputSummary = trimToNonEmptyString(candidate.outputSummary);
  const userSummary = trimToNonEmptyString(candidate.userSummary);
  const primaryPath = trimToNonEmptyString(candidate.primaryPath);
  const compatibilityPath = trimToNonEmptyString(candidate.compatibilityPath);

  if (
    !name ||
    !createdAt ||
    !updatedAt ||
    !description ||
    !purpose ||
    !inputSummary ||
    !outputSummary ||
    !userSummary ||
    !primaryPath ||
    !compatibilityPath
  ) {
    return null;
  }

  return {
    name,
    description,
    purpose,
    inputSummary,
    outputSummary,
    riskLevel: normalizeRiskLevel(candidate.riskLevel),
    allowedSideEffects: normalizeAllowedSideEffects(candidate.allowedSideEffects),
    tags: normalizeStringArray(candidate.tags),
    capabilities: normalizeStringArray(candidate.capabilities),
    version: parseVersion(candidate.version),
    createdAt,
    updatedAt,
    verificationStatus: normalizeVerificationStatus(candidate.verificationStatus),
    verificationVerifiedAt: trimToNonEmptyString(candidate.verificationVerifiedAt),
    verificationFailureReason: trimToNonEmptyString(candidate.verificationFailureReason),
    verificationTestInput: trimToNonEmptyString(candidate.verificationTestInput),
    verificationExpectedOutputContains: trimToNonEmptyString(
      candidate.verificationExpectedOutputContains
    ),
    userSummary,
    invocationHints: normalizeStringArray(candidate.invocationHints),
    lifecycleStatus: normalizeLifecycleStatus(candidate.lifecycleStatus),
    primaryPath,
    compatibilityPath
  };
}

/**
 * Converts a manifest into a user-facing inventory entry.
 *
 * @param manifest - Canonical manifest to summarize.
 * @returns Inventory entry for `/skills` and related surfaces.
 */
export function toSkillInventoryEntry(manifest: SkillManifest): SkillInventoryEntry {
  return {
    name: manifest.name,
    description: manifest.description,
    userSummary: manifest.userSummary,
    verificationStatus: manifest.verificationStatus,
    riskLevel: manifest.riskLevel,
    tags: manifest.tags,
    invocationHints: manifest.invocationHints,
    lifecycleStatus: manifest.lifecycleStatus,
    updatedAt: manifest.updatedAt
  };
}
