import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";

import { ResolvedSkillArtifact, TypeScriptTranspiler } from "./contracts";

let cachedTypeScriptTranspiler: TypeScriptTranspiler | "unavailable" | null = null;

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
export async function compileSkillSourceToJavaScript(sourceCode: string): Promise<string> {
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
export async function loadSkillModuleNamespace(
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
export function pickCallableSkillExport(
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
export function toSkillOutputSummary(output: unknown): string {
  if (typeof output === "string") {
    return output.length > 200 ? `${output.slice(0, 200)}...` : output;
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
    return serialized.length > 200 ? `${serialized.slice(0, 200)}...` : serialized;
  } catch {
    return "[unserializable skill output]";
  }
}
