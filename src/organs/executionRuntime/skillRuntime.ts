import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  containsUnsafeMarkdownSkillInstructions,
  extractMarkdownSkillInstructions,
  resolveCreateSkillRuntimeKind
} from "../../core/constraintRuntime/skillMarkdownPolicy";
import { CreateSkillActionParams, PlannedAction } from "../../core/types";
import { buildExecutionOutcome, normalizeOptionalString } from "../liveRun/contracts";
import { applySkillVerificationResult } from "../skillRegistry/skillLifecycle";
import { buildSkillManifest, extractSkillVerificationConfig } from "../skillRegistry/skillManifest";
import { SkillRegistryStore } from "../skillRegistry/skillRegistryStore";
import { evaluateSkillVerificationResult } from "../skillRegistry/skillVerification";
import { ResolvedSkillArtifact, SkillArtifactPaths } from "./contracts";
import { isPathWithinPrefix, resolveWorkspacePath } from "./pathRuntime";
import {
  compileSkillSourceToJavaScript,
  loadSkillModuleNamespace,
  pickCallableSkillExport,
  toSkillOutputSummary
} from "./skillModuleLoader";

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PRIMARY_SKILL_EXTENSION = ".js";
const COMPATIBILITY_SKILL_EXTENSION = ".ts";
const INSTRUCTION_SKILL_EXTENSION = ".md";

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
 * @returns Runtime skill root plus JS and TS artifact paths.
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
 * Checks whether a runtime skill artifact exists on disk.
 *
 * @param targetPath - Artifact path to test.
 * @returns `true` when the artifact exists.
 */
async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the current stored runtime artifact for a skill, preferring the JS primary artifact.
 *
 * @param artifactPaths - Runtime artifact paths for the skill.
 * @returns Resolved artifact descriptor or `null` when no artifact exists.
 */
async function resolveExistingSkillArtifact(
  artifactPaths: SkillArtifactPaths
): Promise<ResolvedSkillArtifact | null> {
  if (await fileExists(artifactPaths.primaryPath)) {
    return {
      path: artifactPaths.primaryPath,
      extension: ".js"
    };
  }

  if (await fileExists(artifactPaths.compatibilityPath)) {
    return {
      path: artifactPaths.compatibilityPath,
      extension: ".ts"
    };
  }

  return null;
}

/**
 * Executes the manifest-defined self-test for a newly created skill when verification config is
 * present.
 *
 * @param artifact - Stored skill artifact to load.
 * @param testInput - Optional self-test input text.
 * @param expectedOutputContains - Optional expected output substring.
 * @param nowIso - Timestamp applied to verification success.
 * @returns Verification result for the created skill.
 */
async function verifyCreatedSkillArtifact(
  artifact: ResolvedSkillArtifact,
  testInput: string | null,
  expectedOutputContains: string | null,
  nowIso: string
) {
  if (!testInput && !expectedOutputContains) {
    return evaluateSkillVerificationResult(null, null, nowIso);
  }

  const moduleNamespace = await loadSkillModuleNamespace(artifact);
  const callable = pickCallableSkillExport(moduleNamespace);
  if (!callable) {
    return {
      status: "failed" as const,
      verifiedAt: null,
      failureReason: `No callable export found in ${path.basename(artifact.path)}.`,
      outputSummary: null
    };
  }

  const result = await callable(testInput ?? "");
  return evaluateSkillVerificationResult(
    toSkillOutputSummary(result),
    expectedOutputContains,
    nowIso
  );
}

/**
 * Creates or replaces a runtime skill artifact pair from planner-supplied source code.
 *
 * @param action - Planned create-skill action.
 * @returns Execution outcome for the create-skill action.
 */
export async function executeCreateSkillAction(action: PlannedAction) {
  const params = action.params as CreateSkillActionParams;
  const skillName = normalizeOptionalString(params.name);
  const code = normalizeOptionalString(params.code);
  const kind = resolveCreateSkillRuntimeKind(params);
  const markdownInstructions = extractMarkdownSkillInstructions(params);
  if (!skillName) {
    return buildExecutionOutcome(
      "blocked",
      "Create skill blocked: missing name.",
      "CREATE_SKILL_MISSING_NAME"
    );
  }
  if (kind === "markdown_instruction" && !markdownInstructions) {
    return buildExecutionOutcome(
      "blocked",
      "Create Markdown skill blocked: missing instruction content.",
      "CREATE_SKILL_MISSING_CODE"
    );
  }
  if (kind === "executable_module" && !code) {
    return buildExecutionOutcome(
      "blocked",
      "Create skill blocked: missing code.",
      "CREATE_SKILL_MISSING_CODE"
    );
  }
  if (
    kind === "markdown_instruction" &&
    markdownInstructions &&
    containsUnsafeMarkdownSkillInstructions(markdownInstructions)
  ) {
    return buildExecutionOutcome(
      "blocked",
      "Create Markdown skill blocked: unsafe instruction content.",
      "CREATE_SKILL_UNSAFE_CODE"
    );
  }
  if (!isSafeSkillName(skillName)) {
    return buildExecutionOutcome(
      "blocked",
      "Create skill blocked: invalid skill name format.",
      "CREATE_SKILL_INVALID_NAME"
    );
  }
  try {
    const artifactPaths = resolveSkillArtifactPaths(skillName);
    await mkdir(artifactPaths.skillsRoot, { recursive: true });
    if (
      !isSkillArtifactPathWithinRoot(artifactPaths.primaryPath, artifactPaths.skillsRoot) ||
      !isSkillArtifactPathWithinRoot(artifactPaths.compatibilityPath, artifactPaths.skillsRoot) ||
      !isSkillArtifactPathWithinRoot(artifactPaths.instructionPath, artifactPaths.skillsRoot) ||
      !isSkillArtifactPathWithinRoot(artifactPaths.manifestPath, artifactPaths.skillsRoot)
    ) {
      return buildExecutionOutcome(
        "blocked",
        "Create skill blocked: skill path escaped skills directory.",
        "ACTION_EXECUTION_FAILED"
      );
    }
    if (kind === "markdown_instruction" && markdownInstructions) {
      await writeFile(artifactPaths.instructionPath, markdownInstructions, "utf8");
      const nowIso = new Date().toISOString();
      const skillRegistryStore = new SkillRegistryStore(artifactPaths.skillsRoot);
      const manifest = buildSkillManifest(params, skillName, artifactPaths, nowIso);
      await skillRegistryStore.saveManifest(manifest);
      return buildExecutionOutcome(
        "success",
        `Markdown skill created successfully: ${skillName}.md. Guidance saved for bounded planner reuse.`,
        undefined,
        {
          skillName,
          skillKind: manifest.kind,
          skillVerificationStatus: manifest.verificationStatus,
          skillTrustedForReuse: false,
          skillManifestPath: artifactPaths.manifestPath
        }
      );
    }
    if (!code) {
      return buildExecutionOutcome(
        "blocked",
        "Create skill blocked: missing code.",
        "CREATE_SKILL_MISSING_CODE"
      );
    }
    const javascriptCode = await compileSkillSourceToJavaScript(code);
    await writeFile(artifactPaths.primaryPath, javascriptCode, "utf8");
    await writeFile(artifactPaths.compatibilityPath, code, "utf8");
    const nowIso = new Date().toISOString();
    const skillRegistryStore = new SkillRegistryStore(artifactPaths.skillsRoot);
    let manifest = buildSkillManifest(params, skillName, artifactPaths, nowIso);
    await skillRegistryStore.saveManifest(manifest);
    const verificationConfig = extractSkillVerificationConfig(params);
    const verificationResult = await verifyCreatedSkillArtifact(
      {
        path: artifactPaths.primaryPath,
        extension: ".js"
      },
      verificationConfig.testInput,
      verificationConfig.expectedOutputContains,
      nowIso
    );
    manifest = applySkillVerificationResult(manifest, verificationResult, nowIso);
    await skillRegistryStore.saveManifest(manifest);
    const verificationSuffix =
      manifest.verificationStatus === "verified"
        ? " Verified and ready for reuse."
        : manifest.verificationStatus === "failed"
          ? ` Verification failed: ${manifest.verificationFailureReason ?? "unknown reason"}.`
          : " Verification pending.";
    return buildExecutionOutcome(
      "success",
      `Skill created successfully: ${skillName}.js (compat: ${skillName}.ts).${verificationSuffix}`,
      undefined,
      {
        skillName,
        skillVerificationStatus: manifest.verificationStatus,
        skillTrustedForReuse: manifest.verificationStatus === "verified",
        skillManifestPath: artifactPaths.manifestPath
      }
    );
  } catch (error) {
    return buildExecutionOutcome(
      "failed",
      `Create skill failed: ${(error as Error).message}`,
      "ACTION_EXECUTION_FAILED"
    );
  }
}

/**
 * Loads and executes a stored runtime skill artifact.
 *
 * @param action - Planned run-skill action.
 * @returns Execution outcome for the run-skill action.
 */
export async function executeRunSkillAction(action: PlannedAction) {
  const skillName = normalizeOptionalString(action.params.name);
  if (!skillName) {
    return buildExecutionOutcome(
      "blocked",
      "Run skill blocked: missing skill name.",
      "RUN_SKILL_MISSING_NAME"
    );
  }
  if (!isSafeSkillName(skillName)) {
    return buildExecutionOutcome(
      "blocked",
      "Run skill blocked: invalid skill name format.",
      "RUN_SKILL_INVALID_NAME"
    );
  }

  const exportName = normalizeOptionalString(action.params.exportName) ?? undefined;
  const input =
    normalizeOptionalString(action.params.input) ??
    normalizeOptionalString(action.params.text) ??
    "";
  const artifactPaths = resolveSkillArtifactPaths(skillName);
  if (
    !isSkillArtifactPathWithinRoot(artifactPaths.primaryPath, artifactPaths.skillsRoot) ||
    !isSkillArtifactPathWithinRoot(artifactPaths.compatibilityPath, artifactPaths.skillsRoot) ||
    !isSkillArtifactPathWithinRoot(artifactPaths.instructionPath, artifactPaths.skillsRoot)
  ) {
    return buildExecutionOutcome(
      "blocked",
      "Run skill blocked: skill path escaped skills directory.",
      "ACTION_EXECUTION_FAILED"
    );
  }

  const skillRegistryStore = new SkillRegistryStore(artifactPaths.skillsRoot);
  const manifest = await skillRegistryStore.loadManifest(skillName);
  if (manifest?.kind === "markdown_instruction") {
    return buildExecutionOutcome(
      "blocked",
      `Run skill blocked: ${skillName} is a Markdown instruction skill and cannot execute code.`,
      "RUN_SKILL_ARTIFACT_MISSING"
    );
  }

  const resolvedArtifact = await resolveExistingSkillArtifact(artifactPaths);
  if (!resolvedArtifact) {
    return buildExecutionOutcome(
      "failed",
      `Run skill failed: no skill artifact found for ${skillName}.`,
      "RUN_SKILL_ARTIFACT_MISSING"
    );
  }

  try {
    const moduleNamespace = await loadSkillModuleNamespace(resolvedArtifact);
    const callable = pickCallableSkillExport(moduleNamespace, exportName);
    if (!callable) {
      return buildExecutionOutcome(
        "failed",
        `Run skill failed: no callable export found in ${path.basename(resolvedArtifact.path)}.`,
        "RUN_SKILL_INVALID_EXPORT"
      );
    }

    const result = await callable(input);
    const outputSummary = toSkillOutputSummary(result);
    return buildExecutionOutcome(
      "success",
      `Run skill success: ${skillName} -> ${outputSummary}`,
      undefined,
      {
        skillName,
        skillVerificationStatus: manifest?.verificationStatus ?? "unverified",
        skillTrustedForReuse: manifest?.verificationStatus === "verified",
        skillLifecycleStatus: manifest?.lifecycleStatus ?? "active"
      }
    );
  } catch (error) {
    return buildExecutionOutcome(
      "failed",
      `Run skill failed: ${(error as Error).message}`,
      "RUN_SKILL_LOAD_FAILED"
    );
  }
}
