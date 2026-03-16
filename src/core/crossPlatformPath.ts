/**
 * @fileoverview Cross-platform path helpers for fixture and runtime paths that may use Windows
 * separators even when the current host is not Windows.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
const WINDOWS_DRIVE_FILE_URL_PATH_PATTERN = /^\/[A-Za-z]:\//;

type PortablePathModule = Pick<typeof path.posix, "basename" | "dirname" | "extname" | "normalize" | "parse">;

/**
 * Returns whether a path must be interpreted with Windows separator semantics.
 *
 * @param candidatePath - Raw path string.
 * @returns `true` when Windows path rules should apply.
 */
function usesWindowsPathSemantics(candidatePath: string): boolean {
  return (
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(candidatePath) ||
    WINDOWS_UNC_PATH_PATTERN.test(candidatePath) ||
    (!candidatePath.startsWith("/") && candidatePath.includes("\\"))
  );
}

/**
 * Selects the path module whose separator semantics match one normalized path.
 *
 * @param candidatePath - Raw or normalized path string.
 * @returns Matching path implementation.
 */
function selectPathModule(candidatePath: string): PortablePathModule {
  return usesWindowsPathSemantics(candidatePath) ? path.win32 : path.posix;
}

/**
 * Removes trailing separators while preserving true filesystem roots.
 *
 * @param normalizedPath - Path already normalized for its platform semantics.
 * @param pathModule - Matching path implementation.
 * @returns Path without redundant trailing separators.
 */
function trimTrailingSeparators(
  normalizedPath: string,
  pathModule: PortablePathModule
): string {
  const root = pathModule.parse(normalizedPath).root;
  if (normalizedPath === root) {
    return normalizedPath;
  }
  return normalizedPath.replace(/[\\/]+$/, "");
}

/**
 * Normalizes one local path using separator rules that match the path string itself.
 *
 * @param candidatePath - Raw path string.
 * @returns Normalized path, or an empty string when the input is blank.
 */
export function normalizeCrossPlatformPath(candidatePath: string): string {
  const trimmed = candidatePath.trim();
  if (!trimmed) {
    return "";
  }
  if (usesWindowsPathSemantics(trimmed)) {
    return trimTrailingSeparators(path.win32.normalize(trimmed), path.win32);
  }
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  return trimTrailingSeparators(normalized, path.posix);
}

/**
 * Resolves the final path segment for a local path regardless of host operating system.
 *
 * @param candidatePath - Raw path string.
 * @returns Basename, or an empty string when the input is blank.
 */
export function basenameCrossPlatformPath(candidatePath: string): string {
  const normalized = normalizeCrossPlatformPath(candidatePath);
  if (!normalized) {
    return "";
  }
  return selectPathModule(normalized).basename(normalized);
}

/**
 * Resolves the parent directory for a local path regardless of host operating system.
 *
 * @param candidatePath - Raw path string.
 * @returns Parent directory path, or an empty string when the input is blank.
 */
export function dirnameCrossPlatformPath(candidatePath: string): string {
  const normalized = normalizeCrossPlatformPath(candidatePath);
  if (!normalized) {
    return "";
  }
  return selectPathModule(normalized).dirname(normalized);
}

/**
 * Resolves the final file extension for a local path regardless of host operating system.
 *
 * @param candidatePath - Raw path string.
 * @returns File extension, or an empty string when the input is blank.
 */
export function extnameCrossPlatformPath(candidatePath: string): string {
  const normalized = normalizeCrossPlatformPath(candidatePath);
  if (!normalized) {
    return "";
  }
  return selectPathModule(normalized).extname(normalized);
}

/**
 * Converts one local `file://` URL into a stable absolute path on any host OS.
 *
 * @param fileUrl - Candidate local file URL.
 * @returns Absolute local path, or `null` when the URL is invalid or remote.
 */
export function localFileUrlToAbsolutePath(fileUrl: string): string | null {
  try {
    const parsedUrl = new URL(fileUrl);
    if (parsedUrl.protocol !== "file:") {
      return null;
    }
    const normalizedHostname = parsedUrl.hostname.trim().toLowerCase();
    if (normalizedHostname.length > 0 && normalizedHostname !== "localhost") {
      return null;
    }
    if (WINDOWS_DRIVE_FILE_URL_PATH_PATTERN.test(parsedUrl.pathname)) {
      return decodeURIComponent(parsedUrl.pathname.slice(1)).replace(/\//g, "\\");
    }
    return fileURLToPath(parsedUrl);
  } catch {
    return null;
  }
}
