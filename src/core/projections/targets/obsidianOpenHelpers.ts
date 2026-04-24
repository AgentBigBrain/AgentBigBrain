/**
 * @fileoverview Builds deterministic Obsidian URI targets for opening mirrored notes and dashboards.
 */

import path from "node:path";

/**
 * Builds an Obsidian URI that opens one absolute path inside a vault.
 *
 * **Why it exists:**
 * Operators may want to jump from runtime output directly into a mirrored note, and using exact
 * `path=` URIs avoids fuzzy vault/file name resolution.
 *
 * **What it talks to:**
 * - Uses `path.resolve` and `path.win32` (import `default`) from `node:path`.
 *
 * @param absoluteNotePath - Absolute note or asset path inside the Obsidian vault.
 * @returns `obsidian://open` URI using the exact path parameter.
 */
export function buildObsidianOpenPathUri(absoluteNotePath: string): string {
  const resolvedPath = resolveCrossPlatformAbsolutePath(absoluteNotePath);
  return `obsidian://open?path=${encodeURIComponent(resolvedPath)}`;
}

/**
 * Builds the absolute dashboard note path for one projected Obsidian root directory.
 *
 * **Why it exists:**
 * The dashboard note is the primary operator entrypoint into the mirror, so callers should not
 * rebuild that path ad hoc across tools and runtime flows.
 *
 * **What it talks to:**
 * - Uses `path.resolve` and `path.win32` (import `default`) from `node:path`.
 *
 * @param vaultPath - Absolute Obsidian vault root.
 * @param rootDirectoryName - Machine-owned mirror root directory inside the vault.
 * @returns Absolute dashboard note path.
 */
export function buildObsidianDashboardPath(
  vaultPath: string,
  rootDirectoryName: string
): string {
  if (path.win32.isAbsolute(vaultPath)) {
    return path.win32.resolve(vaultPath, rootDirectoryName, "00 Dashboard.md");
  }
  return path.resolve(vaultPath, rootDirectoryName, "00 Dashboard.md");
}

/**
 * Resolves an absolute note path without converting Windows paths into relative POSIX paths.
 *
 * **Why it exists:**
 * Obsidian vault paths may be configured for Windows even when tests or tooling execute on Linux,
 * so exact-path URIs must preserve the original platform path semantics.
 *
 * **What it talks to:**
 * - Uses `path.resolve` and `path.win32` (import `default`) from `node:path`.
 *
 * @param absolutePath - Candidate absolute path from operator configuration.
 * @returns Normalized absolute path using the matching platform semantics.
 */
function resolveCrossPlatformAbsolutePath(absolutePath: string): string {
  if (path.win32.isAbsolute(absolutePath)) {
    return path.win32.normalize(absolutePath);
  }
  return path.resolve(absolutePath);
}
