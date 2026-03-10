import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PlannedAction } from "../../core/types";
import { buildExecutionOutcome, normalizeOptionalString } from "../liveRun/contracts";
import { ResolvedSkillArtifact, SkillArtifactPaths, TypeScriptTranspiler } from "./contracts";
import { isPathWithinPrefix, resolveWorkspacePath } from "./pathRuntime";

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PRIMARY_SKILL_EXTENSION = ".js";
const COMPATIBILITY_SKILL_EXTENSION = ".ts";

let cachedTypeScriptTranspiler: TypeScriptTranspiler | "unavailable" | null = null;

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
    primaryPath: path.resolve(path.join(skillsRoot, `${skillName}${PRIMARY_SKILL_EXTENSION}`)),
    compatibilityPath: path.resolve(
      path.join(skillsRoot, `${skillName}${COMPATIBILITY_SKILL_EXTENSION}`)
    )
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
 * Lazily loads and caches the TypeScript transpiler used for compatibility skill artifacts.
 *
 * @returns TypeScript transpiler module or `null` when unavailable.
 */
async function loadTypeScriptTranspiler(): Promise<TypeScriptTranspiler | null> {
  if (cachedTypeScriptTranspiler === "unavailable") {
    return null;
  }
  if (cachedTypeScriptTranspiler) {
    return cachedTypeScriptTranspiler;
  }
  try {
    const typescriptModule = (await import("typescript")) as unknown as TypeScriptTranspiler;
    cachedTypeScriptTranspiler = typescriptModule;
    return typescriptModule;
  } catch {
    cachedTypeScriptTranspiler = "unavailable";
    return null;
  }
}

/**
 * Compiles TypeScript-flavored skill source to executable JavaScript.
 *
 * @param sourceCode - Raw skill source code.
 * @returns Executable JavaScript source.
 */
async function compileSkillSourceToJavaScript(sourceCode: string): Promise<string> {
  const transpiler = await loadTypeScriptTranspiler();
  if (transpiler?.transpileModule && transpiler.ModuleKind && transpiler.ScriptTarget) {
    const transpiled = transpiler.transpileModule(sourceCode, {
      compilerOptions: {
        module: transpiler.ModuleKind.ESNext,
        target: transpiler.ScriptTarget.ES2020
      }
    });
    return transpiled.outputText;
  }

  return stripTypeScriptTypes(sourceCode, {
    mode: "transform",
    sourceMap: false
  });
}

/**
 * Builds a cache-busting file URL for runtime module import.
 *
 * @param artifactPath - Artifact path on disk.
 * @returns Import specifier for the runtime module loader.
 */
function buildFileImportUrl(artifactPath: string): string {
  return `${pathToFileURL(artifactPath).href}?t=${Date.now()}`;
}

/**
 * Imports a runtime module namespace from a dynamic specifier.
 *
 * @param specifier - Module specifier to import.
 * @returns Imported module namespace.
 */
async function importModuleNamespaceAtRuntime(specifier: string): Promise<Record<string, unknown>> {
  return (await import(specifier)) as Record<string, unknown>;
}

/**
 * Builds a data URL module wrapper for dynamically generated JavaScript.
 *
 * @param javascriptSource - Executable JavaScript source.
 * @param sourcePath - Original source path used for sourceURL tagging.
 * @returns Data URL import specifier.
 */
function buildDataModuleImportUrl(javascriptSource: string, sourcePath: string): string {
  const inlineSource = `${javascriptSource}\n//# sourceURL=${JSON.stringify(sourcePath)}\n`;
  const encodedSource = Buffer.from(inlineSource, "utf8").toString("base64");
  return `data:text/javascript;base64,${encodedSource}`;
}

/**
 * Detects module-loader failures that should retry through a data URL import path.
 *
 * @param error - Import failure.
 * @returns `true` when a data URL retry should be attempted.
 */
function shouldRetryJavaScriptImportViaDataUrl(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("only urls with a scheme in") ||
    message.includes("received protocol") ||
    message.includes("unsupported es module url")
  );
}

/**
 * Loads the executable module namespace for a stored skill artifact.
 *
 * @param artifact - Resolved skill artifact descriptor.
 * @returns Imported module namespace.
 */
async function loadSkillModuleNamespace(
  artifact: ResolvedSkillArtifact
): Promise<Record<string, unknown>> {
  const moduleSpecifier = buildFileImportUrl(artifact.path);
  try {
    return await importModuleNamespaceAtRuntime(moduleSpecifier);
  } catch (error) {
    if (artifact.extension === ".js" && shouldRetryJavaScriptImportViaDataUrl(error)) {
      const javascriptSource = await readFile(artifact.path, "utf8");
      return importModuleNamespaceAtRuntime(
        buildDataModuleImportUrl(javascriptSource, artifact.path)
      );
    }

    if (artifact.extension !== ".ts") {
      throw error;
    }

    const sourceCode = await readFile(artifact.path, "utf8");
    const javascriptSource = await compileSkillSourceToJavaScript(sourceCode);
    return importModuleNamespaceAtRuntime(
      buildDataModuleImportUrl(javascriptSource, artifact.path)
    );
  }
}

/**
 * Picks the callable export used to invoke a runtime skill.
 *
 * @param moduleNamespace - Imported skill module namespace.
 * @param preferredExportName - Optional explicit export name.
 * @returns Callable skill function or `null` when no supported export exists.
 */
function pickCallableSkillExport(
  moduleNamespace: Record<string, unknown>,
  preferredExportName?: string
): ((input: string) => unknown | Promise<unknown>) | null {
  if (preferredExportName) {
    const preferred = moduleNamespace[preferredExportName];
    return typeof preferred === "function"
      ? (preferred as (input: string) => unknown | Promise<unknown>)
      : null;
  }

  const defaultExport = moduleNamespace.default;
  if (typeof defaultExport === "function") {
    return defaultExport as (input: string) => unknown | Promise<unknown>;
  }

  for (const exportedValue of Object.values(moduleNamespace)) {
    if (typeof exportedValue === "function") {
      return exportedValue as (input: string) => unknown | Promise<unknown>;
    }
  }

  return null;
}

/**
 * Summarizes arbitrary skill output into a bounded string for execution results.
 *
 * @param output - Raw skill result.
 * @returns Bounded human-readable summary string.
 */
function toSkillOutputSummary(output: unknown): string {
  if (typeof output === "string") {
    return output.length > 200 ? `${output.slice(0, 200)}…` : output;
  }
  if (
    typeof output === "number" ||
    typeof output === "boolean" ||
    output === null ||
    output === undefined
  ) {
    return String(output);
  }

  try {
    const serialized = JSON.stringify(output);
    return serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized;
  } catch {
    return "[unserializable skill output]";
  }
}

/**
 * Creates or replaces a runtime skill artifact pair from planner-supplied source code.
 *
 * @param action - Planned create-skill action.
 * @returns Execution outcome for the create-skill action.
 */
export async function executeCreateSkillAction(action: PlannedAction) {
  const skillName = normalizeOptionalString(action.params.name);
  const code = normalizeOptionalString(action.params.code);
  if (!skillName) {
    return buildExecutionOutcome(
      "blocked",
      "Create skill blocked: missing name.",
      "CREATE_SKILL_MISSING_NAME"
    );
  }
  if (!code) {
    return buildExecutionOutcome(
      "blocked",
      "Create skill blocked: missing code.",
      "CREATE_SKILL_MISSING_CODE"
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
      !isSkillArtifactPathWithinRoot(
        artifactPaths.compatibilityPath,
        artifactPaths.skillsRoot
      )
    ) {
      return buildExecutionOutcome(
        "blocked",
        "Create skill blocked: skill path escaped skills directory.",
        "ACTION_EXECUTION_FAILED"
      );
    }
    const javascriptCode = await compileSkillSourceToJavaScript(code);
    await writeFile(artifactPaths.primaryPath, javascriptCode, "utf8");
    await writeFile(artifactPaths.compatibilityPath, code, "utf8");
    return buildExecutionOutcome(
      "success",
      `Skill created successfully: ${skillName}.js (compat: ${skillName}.ts)`
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
    !isSkillArtifactPathWithinRoot(
      artifactPaths.compatibilityPath,
      artifactPaths.skillsRoot
    )
  ) {
    return buildExecutionOutcome(
      "blocked",
      "Run skill blocked: skill path escaped skills directory.",
      "ACTION_EXECUTION_FAILED"
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
    return buildExecutionOutcome(
      "success",
      `Run skill success: ${skillName} -> ${toSkillOutputSummary(result)}`
    );
  } catch (error) {
    return buildExecutionOutcome(
      "failed",
      `Run skill failed: ${(error as Error).message}`,
      "RUN_SKILL_LOAD_FAILED"
    );
  }
}
