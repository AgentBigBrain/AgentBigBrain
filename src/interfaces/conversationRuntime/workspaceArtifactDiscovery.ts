/**
 * @fileoverview Discovers stable workspace artifact references when a run reopens an existing
 * project without producing new file-write ledgers.
 */

import { existsSync } from "node:fs";

import { normalizeCrossPlatformPath } from "../../core/crossPlatformPath";

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

const PRIMARY_ARTIFACT_RELATIVE_PATHS = [
  "app/page.tsx",
  "app/page.jsx",
  "app/page.ts",
  "app/page.js",
  "pages/index.tsx",
  "pages/index.jsx",
  "pages/index.ts",
  "pages/index.js",
  "src/App.tsx",
  "src/App.jsx",
  "src/App.ts",
  "src/App.js",
  "index.html"
] as const;

const WORKSPACE_REFERENCE_RELATIVE_PATHS = [
  ...PRIMARY_ARTIFACT_RELATIVE_PATHS,
  "app/globals.css",
  "app/layout.tsx",
  "app/layout.jsx",
  "app/layout.ts",
  "app/layout.js",
  "src/index.css",
  "src/styles.css"
] as const;

/**
 * Returns whether one workspace root string should be treated with Windows separator semantics.
 */
function usesWindowsPathSemantics(candidatePath: string): boolean {
  return (
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(candidatePath) ||
    WINDOWS_UNC_PATH_PATTERN.test(candidatePath) ||
    (!candidatePath.startsWith("/") && candidatePath.includes("\\"))
  );
}

/**
 * Joins one relative artifact path onto a workspace root while preserving the root's path
 * separator semantics even when the host OS differs.
 */
function joinWorkspaceRelativePath(rootPath: string, relativePath: string): string {
  const normalizedRootPath = normalizeCrossPlatformPath(rootPath);
  if (!normalizedRootPath) {
    return "";
  }
  const normalizedRelativePath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedRelativePath) {
    return normalizedRootPath;
  }
  if (usesWindowsPathSemantics(normalizedRootPath)) {
    return normalizeCrossPlatformPath(
      `${normalizedRootPath}\\${normalizedRelativePath.replace(/\//g, "\\")}`
    );
  }
  return normalizeCrossPlatformPath(`${normalizedRootPath}/${normalizedRelativePath}`);
}

/**
 * Builds ordered artifact candidates under one workspace root using cross-platform path semantics
 * that match the root itself.
 */
export function buildWorkspaceArtifactCandidatePaths(rootPath: string | null): string[] {
  if (!rootPath) {
    return [];
  }
  return WORKSPACE_REFERENCE_RELATIVE_PATHS.map((relativePath) =>
    joinWorkspaceRelativePath(rootPath, relativePath)
  ).filter((candidatePath) => candidatePath.length > 0);
}

/**
 * Discovers stable file references under one concrete workspace root.
 */
export function discoverWorkspaceReferencePaths(
  rootPath: string | null,
  limit: number
): string[] {
  if (!rootPath || limit <= 0) {
    return [];
  }
  const discoveredPaths: string[] = [];
  for (const candidatePath of buildWorkspaceArtifactCandidatePaths(rootPath)) {
    if (!existsSync(candidatePath)) {
      continue;
    }
    discoveredPaths.push(candidatePath);
    if (discoveredPaths.length >= limit) {
      break;
    }
  }
  return discoveredPaths;
}

/**
 * Discovers the strongest primary artifact for one existing workspace root.
 */
export function discoverWorkspacePrimaryArtifactPath(rootPath: string | null): string | null {
  if (!rootPath) {
    return null;
  }
  for (const relativePath of PRIMARY_ARTIFACT_RELATIVE_PATHS) {
    const candidatePath = joinWorkspaceRelativePath(rootPath, relativePath);
    if (candidatePath && existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}
