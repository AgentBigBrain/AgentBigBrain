/**
 * @fileoverview Deterministic path-boundary helpers shared by hard-constraint enforcement.
 */

import path from "node:path";

import { BrainConfig } from "./config";

/**
 * Canonicalizes a path string into slash-delimited lowercase form.
 *
 * **Why it exists:**
 * Constraint checks compare many path-like values from different actions. Normalizing slashes and
 * case avoids false mismatches and reduces bypass opportunities through formatting tricks.
 *
 * **What it talks to:**
 * - Local string normalization only.
 *
 * @param input - Raw path candidate read from action parameters.
 * @returns Path text normalized to forward slashes and lowercase characters.
 */
function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").toLowerCase();
}

/**
 * Resolves an input path against the workspace and canonicalizes it for prefix checks.
 *
 * **Why it exists:**
 * Path boundary enforcement must compare like-for-like absolute paths. This helper removes
 * relative segments and trailing separators before policy checks run.
 *
 * **What it talks to:**
 * - Uses `path.resolve` from Node's path module.
 * - Calls `normalizePath`.
 *
 * @param inputPath - Relative or absolute path candidate from an action payload.
 * @returns Workspace-anchored absolute path in normalized comparison form.
 */
function normalizeAbsolutePath(inputPath: string): string {
  return normalizePath(path.resolve(process.cwd(), inputPath)).replace(/\/+$/, "");
}

/**
 * Checks whether `targetPath` is equal to or nested under `prefix`.
 *
 * **Why it exists:**
 * Protected-path and sandbox rules rely on deterministic inside/outside decisions. This keeps
 * containment logic in one audited helper.
 *
 * **What it talks to:**
 * - Calls `normalizeAbsolutePath` for both target and prefix.
 *
 * @param targetPath - Candidate file/directory path from action parameters.
 * @param prefix - Allowed or protected root prefix to compare against.
 * @returns `true` when the target path is inside the prefix boundary.
 */
export function isPathWithinPrefix(targetPath: string, prefix: string): boolean {
  const normalizedTarget = normalizeAbsolutePath(targetPath);
  const normalizedPrefix = normalizeAbsolutePath(prefix);
  return (
    normalizedTarget === normalizedPrefix ||
    normalizedTarget.startsWith(`${normalizedPrefix}/`)
  );
}

/**
 * Checks whether a target path falls under any configured protected prefixes.
 *
 * **Why it exists:**
 * Keeps protected-path policy checks centralized so read/write/delete/list and shell scans share
 * identical boundary behavior.
 *
 * **What it talks to:**
 * - Reads `config.dna.protectedPathPrefixes`.
 * - Calls `isPathWithinPrefix`.
 *
 * @param targetPath - Filesystem location used by an operation.
 * @param config - Runtime configuration carrying protected-path prefixes.
 * @returns `true` when the path resolves inside any protected prefix.
 */
export function isProtectedPath(targetPath: string, config: BrainConfig): boolean {
  return config.dna.protectedPathPrefixes.some((prefix) =>
    isPathWithinPrefix(targetPath, prefix)
  );
}

/**
 * Resolves a relative path against the configured sandbox base path.
 *
 * **Why it exists:**
 * Centralized path joining keeps sandbox target construction consistent before canonical boundary
 * checks run elsewhere.
 *
 * **What it talks to:**
 * - Uses `path.join` from Node's path module.
 *
 * @param basePath - Absolute sandbox root.
 * @param relativePath - Relative path requested by action payload.
 * @returns Joined sandbox candidate path.
 */
export function resolveSandboxPath(basePath: string, relativePath: string): string {
  return path.join(basePath, relativePath);
}
