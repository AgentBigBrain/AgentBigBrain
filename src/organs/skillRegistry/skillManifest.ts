/**
 * @fileoverview Canonical skill-manifest normalization and creation helpers.
 */

import type { CreateSkillActionParams } from "../../core/types";
import type { SkillArtifactPaths } from "../executionRuntime/contracts";
import type {
  SkillInventoryEntry,
  SkillKind,
  SkillManifest,
  SkillVerificationConfig,
} from "./contracts";
import {
  normalizeActivationSource,
  normalizeAllowedSideEffects,
  normalizeLifecycleStatus,
  normalizeMemoryPolicy,
  normalizeProjectionPolicy,
  normalizeRiskLevel,
  normalizeSkillKind,
  normalizeSkillOrigin,
  normalizeStringArray,
  normalizeVerificationStatus,
  parseVersion,
  trimToNonEmptyString
} from "./skillManifestNormalization";

/**
 * Resolves create-skill kind from explicit params and available content.
 *
 * @param params - Create-skill params supplied by the planner/runtime.
 * @returns Canonical skill kind.
 */
function resolveCreateSkillKind(params: CreateSkillActionParams): SkillKind {
  const explicitKind = normalizeSkillKind(params.kind);
  if (params.kind !== undefined) {
    return explicitKind;
  }
  const hasCode = trimToNonEmptyString(params.code) !== null;
  const hasMarkdownInstructions =
    trimToNonEmptyString(params.instructions) !== null ||
    trimToNonEmptyString(params.markdownContent) !== null ||
    trimToNonEmptyString(params.content) !== null;
  return !hasCode && hasMarkdownInstructions ? "markdown_instruction" : "executable_module";
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
 * Builds the fallback invocation hint for Markdown guidance skills.
 *
 * @param skillName - Canonical skill name.
 * @returns Human-readable invocation hint.
 */
function buildDefaultMarkdownInvocationHint(skillName: string): string {
  return `Ask me to use guidance skill ${skillName}.`;
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
  const kind = resolveCreateSkillKind(params);
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
  const activationSource = normalizeActivationSource(
    params.activationSource ?? "explicit_user_request",
    params.origin
  );

  return {
    name: skillName,
    kind,
    origin: normalizeSkillOrigin(params.origin),
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
      invocationHints.length > 0
        ? invocationHints
        : [
            kind === "markdown_instruction"
              ? buildDefaultMarkdownInvocationHint(skillName)
              : buildDefaultInvocationHint(skillName)
          ],
    lifecycleStatus: activationSource === "agent_suggestion" ? "pending_approval" : "active",
    activationSource,
    instructionPath: kind === "markdown_instruction" ? artifactPaths.instructionPath : null,
    primaryPath:
      kind === "markdown_instruction" ? artifactPaths.instructionPath : artifactPaths.primaryPath,
    compatibilityPath:
      kind === "markdown_instruction"
        ? artifactPaths.instructionPath
        : artifactPaths.compatibilityPath,
    memoryPolicy: normalizeMemoryPolicy(params.memoryPolicy, kind),
    projectionPolicy: normalizeProjectionPolicy(params.projectionPolicy, kind)
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
    | "activationSource"
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
    activationSource:
      update.activationSource === undefined
        ? manifest.activationSource
        : normalizeActivationSource(update.activationSource, manifest.origin),
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
  const kind = normalizeSkillKind(candidate.kind);
  const createdAt = trimToNonEmptyString(candidate.createdAt);
  const updatedAt = trimToNonEmptyString(candidate.updatedAt);
  const description = trimToNonEmptyString(candidate.description);
  const purpose = trimToNonEmptyString(candidate.purpose);
  const inputSummary = trimToNonEmptyString(candidate.inputSummary);
  const outputSummary = trimToNonEmptyString(candidate.outputSummary);
  const userSummary = trimToNonEmptyString(candidate.userSummary);
  const instructionPath = trimToNonEmptyString(candidate.instructionPath);
  const primaryPath =
    trimToNonEmptyString(candidate.primaryPath) ??
    (kind === "markdown_instruction" ? instructionPath : null);
  const compatibilityPath =
    trimToNonEmptyString(candidate.compatibilityPath) ??
    (kind === "markdown_instruction" ? primaryPath : null);

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
    !compatibilityPath ||
    (kind === "markdown_instruction" && !instructionPath)
  ) {
    return null;
  }

  return {
    name,
    kind,
    origin: normalizeSkillOrigin(candidate.origin),
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
    activationSource: normalizeActivationSource(candidate.activationSource, candidate.origin),
    instructionPath,
    primaryPath,
    compatibilityPath,
    memoryPolicy: normalizeMemoryPolicy(candidate.memoryPolicy, kind),
    projectionPolicy: normalizeProjectionPolicy(candidate.projectionPolicy, kind)
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
    kind: manifest.kind,
    origin: manifest.origin,
    description: manifest.description,
    userSummary: manifest.userSummary,
    verificationStatus: manifest.verificationStatus,
    riskLevel: manifest.riskLevel,
    tags: manifest.tags,
    invocationHints: manifest.invocationHints,
    lifecycleStatus: manifest.lifecycleStatus,
    activationSource: manifest.activationSource,
    updatedAt: manifest.updatedAt,
    memoryPolicy: manifest.memoryPolicy,
    projectionPolicy: manifest.projectionPolicy
  };
}
