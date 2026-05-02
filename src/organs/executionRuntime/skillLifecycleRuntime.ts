import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  containsUnsafeMarkdownSkillInstructions,
  extractMarkdownSkillInstructions
} from "../../core/constraintRuntime/skillMarkdownPolicy";
import { PlannedAction, UpdateSkillActionParams } from "../../core/types";
import { buildExecutionOutcome, normalizeOptionalString } from "../liveRun/contracts";
import { applySkillManifestUpdate } from "../skillRegistry/skillManifest";
import type { SkillManifest } from "../skillRegistry/contracts";
import {
  normalizeAllowedSideEffects,
  normalizeMemoryPolicy,
  normalizeProjectionPolicy,
  normalizeRiskLevel,
  normalizeStringArray,
  parseVersion,
  trimToNonEmptyString
} from "../skillRegistry/skillManifestNormalization";
import { SkillRegistryStore } from "../skillRegistry/skillRegistryStore";
import { SkillArtifactPaths } from "./contracts";
import { isPathWithinPrefix, resolveWorkspacePath } from "./pathRuntime";
import { compileSkillSourceToJavaScript } from "./skillModuleLoader";

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PRIMARY_SKILL_EXTENSION = ".js";
const COMPATIBILITY_SKILL_EXTENSION = ".ts";
const INSTRUCTION_SKILL_EXTENSION = ".md";

type SkillLifecycleActionType = "deprecate_skill" | "approve_skill" | "reject_skill";

/**
 * Checks whether a skill name fits the bounded runtime artifact naming rules.
 *
 * @param skillName - Proposed skill name.
 * @returns `true` when the skill name is safe to use as an artifact name.
 */
function isSafeSkillName(skillName: string): boolean {
  return SKILL_NAME_PATTERN.test(skillName);
}

/**
 * Resolves the absolute runtime artifact paths used for a stored skill.
 *
 * @param skillName - Safe skill name.
 * @returns Runtime skill root plus artifact paths.
 */
function resolveSkillArtifactPaths(skillName: string): SkillArtifactPaths {
  const skillsRoot = path.resolve(resolveWorkspacePath("runtime/skills"));
  return {
    skillsRoot,
    instructionPath: path.resolve(
      path.join(skillsRoot, `${skillName}${INSTRUCTION_SKILL_EXTENSION}`)
    ),
    primaryPath: path.resolve(path.join(skillsRoot, `${skillName}${PRIMARY_SKILL_EXTENSION}`)),
    compatibilityPath: path.resolve(
      path.join(skillsRoot, `${skillName}${COMPATIBILITY_SKILL_EXTENSION}`)
    ),
    manifestPath: path.resolve(path.join(skillsRoot, `${skillName}.manifest.json`))
  };
}

/**
 * Checks whether a resolved skill artifact path stays inside the runtime skills root.
 *
 * @param artifactPath - Candidate artifact path.
 * @param skillsRoot - Required runtime skills root.
 * @returns `true` when the artifact path is contained within the skills root.
 */
function isSkillArtifactPathWithinRoot(artifactPath: string, skillsRoot: string): boolean {
  return isPathWithinPrefix(artifactPath, skillsRoot);
}

/**
 * Checks all lifecycle-owned paths for the skill-root boundary.
 *
 * @param artifactPaths - Runtime paths for the target skill.
 * @returns `true` when all mutable paths remain under the skills root.
 */
function skillLifecyclePathsStayInsideRoot(artifactPaths: SkillArtifactPaths): boolean {
  return (
    isSkillArtifactPathWithinRoot(artifactPaths.primaryPath, artifactPaths.skillsRoot) &&
    isSkillArtifactPathWithinRoot(artifactPaths.compatibilityPath, artifactPaths.skillsRoot) &&
    isSkillArtifactPathWithinRoot(artifactPaths.instructionPath, artifactPaths.skillsRoot) &&
    isSkillArtifactPathWithinRoot(artifactPaths.manifestPath, artifactPaths.skillsRoot)
  );
}

/**
 * Updates a runtime skill manifest and optional artifact content.
 *
 * @param action - Planned update-skill action.
 * @returns Execution outcome for the update-skill action.
 */
export async function executeUpdateSkillAction(action: PlannedAction) {
  const params = action.params as UpdateSkillActionParams;
  const skillName = normalizeOptionalString(params.name);
  if (!skillName) {
    return buildExecutionOutcome(
      "blocked",
      "Update skill blocked: missing skill name.",
      "SKILL_ACTION_MISSING_NAME"
    );
  }
  if (!isSafeSkillName(skillName)) {
    return buildExecutionOutcome(
      "blocked",
      "Update skill blocked: invalid skill name format.",
      "SKILL_ACTION_INVALID_NAME"
    );
  }

  try {
    const artifactPaths = resolveSkillArtifactPaths(skillName);
    if (!skillLifecyclePathsStayInsideRoot(artifactPaths)) {
      return buildExecutionOutcome(
        "blocked",
        "Update skill blocked: skill path escaped skills directory.",
        "ACTION_EXECUTION_FAILED"
      );
    }
    const skillRegistryStore = new SkillRegistryStore(artifactPaths.skillsRoot);
    const manifest = await skillRegistryStore.loadManifest(skillName);
    if (!manifest || manifest.origin === "builtin") {
      return buildExecutionOutcome(
        "blocked",
        `Update skill blocked: no mutable runtime skill found for ${skillName}.`,
        "SKILL_ACTION_ARTIFACT_MISSING"
      );
    }

    const markdownInstructions = extractMarkdownSkillInstructions(params);
    if (markdownInstructions && containsUnsafeMarkdownSkillInstructions(markdownInstructions)) {
      return buildExecutionOutcome(
        "blocked",
        "Update skill blocked: unsafe Markdown instruction content.",
        "SKILL_ACTION_UNSAFE_CONTENT"
      );
    }
    const code = normalizeOptionalString(params.code);
    if (manifest.kind === "markdown_instruction" && markdownInstructions) {
      await writeFile(artifactPaths.instructionPath, markdownInstructions, "utf8");
    }
    if (manifest.kind === "executable_module" && code) {
      const javascriptCode = await compileSkillSourceToJavaScript(code);
      await writeFile(artifactPaths.primaryPath, javascriptCode, "utf8");
      await writeFile(artifactPaths.compatibilityPath, code, "utf8");
    }

    const nowIso = new Date().toISOString();
    const updatedManifest = applySkillMetadataUpdate(manifest, params, nowIso);
    await skillRegistryStore.saveManifest(updatedManifest);
    return buildExecutionOutcome(
      "success",
      `Skill updated successfully: ${skillName}.`,
      undefined,
      {
        skillName,
        skillKind: updatedManifest.kind,
        skillVerificationStatus: updatedManifest.verificationStatus,
        skillLifecycleStatus: updatedManifest.lifecycleStatus,
        skillManifestPath: artifactPaths.manifestPath
      }
    );
  } catch (error) {
    return buildExecutionOutcome(
      "failed",
      `Update skill failed: ${(error as Error).message}`,
      "ACTION_EXECUTION_FAILED"
    );
  }
}

/**
 * Applies an approve, reject, or deprecate lifecycle transition to a runtime skill.
 *
 * @param action - Planned skill lifecycle action.
 * @returns Execution outcome for the lifecycle action.
 */
export async function executeSkillLifecycleAction(action: PlannedAction) {
  const actionType = action.type as SkillLifecycleActionType;
  const skillName = normalizeOptionalString(action.params.name);
  if (!skillName) {
    return buildExecutionOutcome(
      "blocked",
      "Skill lifecycle action blocked: missing skill name.",
      "SKILL_ACTION_MISSING_NAME"
    );
  }
  if (!isSafeSkillName(skillName)) {
    return buildExecutionOutcome(
      "blocked",
      "Skill lifecycle action blocked: invalid skill name format.",
      "SKILL_ACTION_INVALID_NAME"
    );
  }

  try {
    const artifactPaths = resolveSkillArtifactPaths(skillName);
    if (!skillLifecyclePathsStayInsideRoot(artifactPaths)) {
      return buildExecutionOutcome(
        "blocked",
        "Skill lifecycle action blocked: skill path escaped skills directory.",
        "ACTION_EXECUTION_FAILED"
      );
    }
    const skillRegistryStore = new SkillRegistryStore(artifactPaths.skillsRoot);
    const manifest = await skillRegistryStore.loadManifest(skillName);
    if (!manifest || manifest.origin === "builtin") {
      return buildExecutionOutcome(
        "blocked",
        `Skill lifecycle action blocked: no mutable runtime skill found for ${skillName}.`,
        "SKILL_ACTION_ARTIFACT_MISSING"
      );
    }
    const nowIso = new Date().toISOString();
    const lifecycleStatus =
      actionType === "approve_skill"
        ? "active"
        : actionType === "reject_skill"
          ? "rejected"
          : "deprecated";
    const updatedManifest = applySkillManifestUpdate(
      manifest,
      {
        lifecycleStatus,
        activationSource:
          actionType === "approve_skill" ? "operator_approval" : manifest.activationSource
      },
      nowIso
    );
    await skillRegistryStore.saveManifest(updatedManifest);
    return buildExecutionOutcome(
      "success",
      `Skill lifecycle updated: ${skillName} is ${updatedManifest.lifecycleStatus}.`,
      undefined,
      {
        skillName,
        skillKind: updatedManifest.kind,
        skillLifecycleStatus: updatedManifest.lifecycleStatus,
        skillActivationSource: updatedManifest.activationSource,
        skillManifestPath: artifactPaths.manifestPath
      }
    );
  } catch (error) {
    return buildExecutionOutcome(
      "failed",
      `Skill lifecycle action failed: ${(error as Error).message}`,
      "ACTION_EXECUTION_FAILED"
    );
  }
}

/**
 * Applies bounded metadata edits to a skill manifest.
 *
 * @param manifest - Existing manifest.
 * @param params - Update action params.
 * @param nowIso - Update timestamp.
 * @returns Updated manifest.
 */
function applySkillMetadataUpdate(
  manifest: SkillManifest,
  params: UpdateSkillActionParams,
  nowIso: string
) {
  const description = trimToNonEmptyString(params.description) ?? manifest.description;
  const purpose = trimToNonEmptyString(params.purpose) ?? manifest.purpose;
  const inputSummary = trimToNonEmptyString(params.inputSummary) ?? manifest.inputSummary;
  const outputSummary = trimToNonEmptyString(params.outputSummary) ?? manifest.outputSummary;
  const userSummary = trimToNonEmptyString(params.userSummary) ?? manifest.userSummary;
  return {
    ...manifest,
    description,
    purpose,
    inputSummary,
    outputSummary,
    riskLevel: params.riskLevel === undefined
      ? manifest.riskLevel
      : normalizeRiskLevel(params.riskLevel),
    allowedSideEffects: params.allowedSideEffects === undefined
      ? manifest.allowedSideEffects
      : normalizeAllowedSideEffects(params.allowedSideEffects),
    tags: params.tags === undefined ? manifest.tags : normalizeStringArray(params.tags),
    capabilities: params.capabilities === undefined
      ? manifest.capabilities
      : normalizeStringArray(params.capabilities),
    version: params.version === undefined ? manifest.version : parseVersion(params.version),
    userSummary,
    invocationHints: params.invocationHints === undefined
      ? manifest.invocationHints
      : normalizeStringArray(params.invocationHints),
    memoryPolicy: params.memoryPolicy === undefined
      ? manifest.memoryPolicy
      : normalizeMemoryPolicy(params.memoryPolicy, manifest.kind),
    projectionPolicy: params.projectionPolicy === undefined
      ? manifest.projectionPolicy
      : normalizeProjectionPolicy(params.projectionPolicy, manifest.kind),
    updatedAt: nowIso
  };
}
