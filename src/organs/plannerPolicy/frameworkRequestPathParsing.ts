/**
 * @fileoverview Explicit Windows workspace-path parsing helpers for framework build policy.
 */

import { getPathModuleForPathValue } from "./frameworkPathSupport";

const REQUESTED_FOLDER_PATH_PATTERNS = [
  /`((?:[A-Za-z]:\\|\/)[^`\r\n]+)`/g,
  /"((?:[A-Za-z]:\\|\/)[^"\r\n]+)"/g,
  /'((?:[A-Za-z]:\\|\/)[^'\r\n]+)'/g
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
    const normalizedPath = literalPath.replace(/[\\\/]+$/, "");
    const pathModule = getPathModuleForPathValue(normalizedPath);
    const folderName = pathModule.basename(normalizedPath);
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
    const pathModule = getPathModuleForPathValue(trimmedPath);
    const looksLikeFilePath = /\.[A-Za-z0-9_-]+$/.test(pathModule.basename(trimmedPath));
    return looksLikeFilePath ? pathModule.dirname(trimmedPath) : trimmedPath;
  }
  return null;
}
