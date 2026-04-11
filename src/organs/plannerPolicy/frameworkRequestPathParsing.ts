/**
 * @fileoverview Explicit Windows workspace-path parsing helpers for framework build policy.
 */

import path from "node:path";

const REQUESTED_FOLDER_PATH_PATTERNS = [
  /`([A-Za-z]:\\[^`\r\n]+)`/g,
  /"([A-Za-z]:\\[^"\r\n]+)"/g,
  /'([A-Za-z]:\\[^'\r\n]+)'/g
] as const;

/** Extracts literal Windows paths quoted directly in one framework request. */
function extractRequestedFrameworkPathLiterals(currentUserRequest: string): string[] {
  const literals: string[] = [];
  for (const pattern of REQUESTED_FOLDER_PATH_PATTERNS) {
    for (const match of currentUserRequest.matchAll(pattern)) {
      const literalPath = match[1]?.trim();
      if (literalPath) {
        literals.push(literalPath);
      }
    }
  }
  return literals;
}

/** Extracts the requested workspace folder name from quoted Windows paths in a request. */
export function extractRequestedFrameworkPathFolderName(
  currentUserRequest: string
): string | null {
  for (const literalPath of extractRequestedFrameworkPathLiterals(currentUserRequest)) {
    const folderName = path.win32.basename(literalPath.replace(/[\\\/]+$/, ""));
    if (folderName) {
      return folderName;
    }
  }
  return null;
}

/** Extracts the requested workspace root path from quoted Windows paths in a request. */
export function extractRequestedFrameworkWorkspaceRootPath(
  currentUserRequest: string
): string | null {
  for (const literalPath of extractRequestedFrameworkPathLiterals(currentUserRequest)) {
    const trimmedPath = literalPath.trim().replace(/[\\\/]+$/, "");
    if (trimmedPath.length === 0) {
      continue;
    }
    const looksLikeFilePath = /\.[A-Za-z0-9_-]+$/.test(path.win32.basename(trimmedPath));
    return looksLikeFilePath ? path.win32.dirname(trimmedPath) : trimmedPath;
  }
  return null;
}
